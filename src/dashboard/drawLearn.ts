/**
 * Re-seeds `suggest.ts`'s `DEFAULT_DRAW` from the channel's own numbers instead of the one-time
 * measurement of 1 Oct 2026 (that constant's own comment: "refresh by hand … there is no job
 * that re-seeds it").
 *
 * A player's learned draw is the median, over their videos, of (that video's first-7-day views ÷
 * the channel median first-7-day views) — the same "expected views" idea `DEFAULT_DRAW` already
 * encodes, kept current by itself. A pair is "proven" when their most recent measured meeting
 * beat the channel median, which lets `audienceFor` skip the `pairRepeatDays` halving for a pair
 * that is shown to still draw on a repeat. Both only ever apply when `config.learnedDraw` is on
 * (default off): see that setting's own comment in `src/config.ts`.
 *
 * The population: every long-form upload record (`youtube.json`, never a Short — `allUploads`
 * reads only that file), public (or scheduled and past its time — the same "on the channel" test
 * `lastMeetingFor`/`recentPairPosts` already use), published 7 to 90 days ago, with neither
 * player on `config.blockedPlayers` (a runner who withdrew permission is never fed into a
 * channel-wide number either, same as everywhere else that name is kept out). A video's first
 * week of views never changes once that window has passed, so each one is read from the
 * Analytics API at most once ever and cached forever in the same file this module writes.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { blockedIn, config } from "../config.js";
import { describeError } from "../errorText.js";
import { getAccessToken, isConfigured } from "../youtube/youtube.js";
import { analytics } from "../youtube/yppProgress.js";
import { allUploads, type UploadRecord } from "../youtube/youtubeStore.js";
import { cachedMatchPlayers, pairKey } from "./pairPosts.js";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7;
const MIN_AGE_MS = WINDOW_DAYS * DAY_MS;
const MAX_AGE_MS = 90 * DAY_MS;
/** A player needs this many measured videos before a learned draw replaces the hand-seeded one. */
const MIN_VIDEOS_FOR_PLAYER = 3;
/** How often `drawLearnTick` actually recomputes; every other call in the window is a no-op. */
const RECOMPUTE_EVERY_MS = DAY_MS;

export interface DrawLearned {
  computedAt: number;
  channelMedian: number;
  players: Record<string, { draw: number; n: number }>;
  /** Keyed by `pairKey`. The pair's most recent *measured* meeting's ratio, proven when > 1. */
  pairs: Record<string, { lastRatio: number; lastVideoId: string }>;
  /** First-7-day views per video id — never re-fetched once a video has one. */
  videoViews: Record<string, number>;
}

const filePath = (): string => path.join(config.mediaDir, ".draw-learned.json");

/** Missing is the normal "not computed yet" state and says nothing; corrupt JSON logs once. Both
 *  fall back to null, which is what makes `learnedDraw` byte-for-byte off when there is nothing
 *  to learn from. */
export function readDrawLearned(): DrawLearned | null {
  const file = filePath();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DrawLearned;
  } catch (err) {
    console.error(`draw: ${file} unreadable — ${describeError(err)}`);
    return null;
  }
}

function writeDrawLearned(data: DrawLearned): void {
  const tmp = `${filePath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath());
}

const median = (nums: readonly number[]): number => {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface DrawLearnDeps {
  uploads: () => Promise<
    ReadonlyArray<{
      matchId: number;
      record: Pick<UploadRecord, "videoId" | "publishAt" | "privacyStatus" | "uploadedAt">;
    }>
  >;
  /** The two API-spelling nicknames who played a match, or null when unreadable. */
  playersOf: (matchId: number) => Promise<[string, string] | null>;
  /** First-7-days views for one video published at `publishedMs`, epoch ms. */
  firstWeekViews: (videoId: string, publishedMs: number) => Promise<number>;
}

const liveDeps: DrawLearnDeps = {
  uploads: allUploads,
  playersOf: cachedMatchPlayers,
  firstWeekViews: async (videoId, publishedMs) => {
    const token = await getAccessToken();
    const rows = await analytics(token, {
      startDate: ymd(publishedMs),
      endDate: ymd(publishedMs + (WINDOW_DAYS - 1) * DAY_MS),
      metrics: "views",
      filters: `video==${videoId}`,
    });
    return Number(rows[0]?.[0] ?? 0);
  },
};

/** When a video counts as "on the channel" — the same test `lastMeetingFor`/`recentPairPosts`
 *  already use: public, or scheduled with its time in the past (never updated once it is, so a
 *  stuck-"private" record with a past `publishAt` still counts). */
const publishedMsOf = (
  record: Pick<UploadRecord, "publishAt" | "privacyStatus" | "uploadedAt">,
): number | null => {
  if (record.privacyStatus === "private" && !record.publishAt) return null;
  const ms = Date.parse(record.publishAt ?? record.uploadedAt);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The actual computation, unconditional (no "once a day" gate — that is `drawLearnTick`'s job, so
 * a caller or a test can always ask for a fresh answer). Null when there is nothing to learn from
 * yet (no token, no eligible video, or every eligible video scored zero): the prior file, if any,
 * is left exactly as it was rather than overwritten with less.
 */
export async function recomputeDrawLearned(
  nowMs: number = Date.now(),
  deps: DrawLearnDeps = liveDeps,
): Promise<DrawLearned | null> {
  const prior = readDrawLearned();
  if (!isConfigured()) return prior;

  const uploads = await deps.uploads();
  const eligible = uploads.flatMap(({ matchId, record }) => {
    const publishedMs = publishedMsOf(record);
    if (publishedMs === null) return [];
    const age = nowMs - publishedMs;
    return age >= MIN_AGE_MS && age <= MAX_AGE_MS ? [{ matchId, videoId: record.videoId, publishedMs }] : [];
  });
  if (eligible.length === 0) return prior;

  const videoViews: Record<string, number> = { ...(prior?.videoViews ?? {}) };
  const measured: Array<{ players: [string, string]; views: number; videoId: string; publishedMs: number }> =
    [];
  // A broken token fails the same way for every video; asking again per video would just be N
  // copies of the same log line for N wasted round trips. The first failure is the one that
  // tells you the token is bad, so it is the only one that calls out — everything uncached after
  // it is skipped silently and picked up by tomorrow's tick instead.
  let analyticsFailed = false;
  for (const { matchId, videoId, publishedMs } of eligible) {
    const players = await deps.playersOf(matchId).catch((err: unknown) => {
      console.error(`draw: match #${matchId}'s players unreadable — ${describeError(err)}`);
      return null;
    });
    // A blocked player's old upload does not exist for this purpose, same as everywhere else
    // (config.blockedPlayers): not counted toward the channel median, never taught a draw.
    if (!players || blockedIn(players)) continue;
    let views = videoViews[videoId];
    if (views === undefined) {
      if (analyticsFailed) continue;
      try {
        views = await deps.firstWeekViews(videoId, publishedMs);
        videoViews[videoId] = views;
      } catch (err) {
        console.error(`draw: ${videoId}'s first-week views unreadable — ${describeError(err)}`);
        analyticsFailed = true;
        continue;
      }
    }
    measured.push({ players, views, videoId, publishedMs });
  }
  if (measured.length === 0) return prior;

  const channelMedian = median(measured.map((m) => m.views));
  const result: DrawLearned = { computedAt: nowMs, channelMedian, players: {}, pairs: {}, videoViews };
  if (channelMedian > 0) {
    const ratiosByPlayer = new Map<string, number[]>();
    const latestByPair = new Map<string, { publishedMs: number; ratio: number; videoId: string }>();
    for (const m of measured) {
      const ratio = m.views / channelMedian;
      for (const nickname of m.players) {
        const key = nickname.toLowerCase();
        ratiosByPlayer.set(key, [...(ratiosByPlayer.get(key) ?? []), ratio]);
      }
      const key = pairKey(m.players);
      const prev = latestByPair.get(key);
      if (!prev || m.publishedMs > prev.publishedMs) latestByPair.set(key, { ...m, ratio });
    }
    for (const [nick, ratios] of ratiosByPlayer) {
      if (ratios.length >= MIN_VIDEOS_FOR_PLAYER)
        result.players[nick] = { draw: median(ratios), n: ratios.length };
    }
    for (const [key, v] of latestByPair) result.pairs[key] = { lastRatio: v.ratio, lastVideoId: v.videoId };
  }
  writeDrawLearned(result);
  return result;
}

/**
 * The 15-minute tick's own call (`server.ts`, beside `shortTick`/`autoHooksTick`): a no-op unless
 * `config.learnedDraw` is on, and then at most once a day — the first eligible video's Analytics
 * call already tells you whether the token works, so one failure logs once rather than once per
 * video. Never throws: a background tick dying on this must not take the others down with it.
 * `recompute` is `recomputeDrawLearned` by default; a test overrides it to count attempts without
 * a real scan.
 *
 * Guarded against itself (`running`, the same shape as `shortTick`'s `ticking` in
 * src/dashboard/shortFlow.ts and `evaluateExperiments`'s `evaluating`): `recompute` can run long
 * enough — a first-time backlog, a slow Analytics API — to still be in flight 15 minutes later,
 * and the "once a day" gate above reads `computedAt` from the file, which isn't written until
 * `recompute` finishes, so a second overlapping tick would see the same stale-or-absent prior and
 * start a second, fully overlapping recompute. No cross-process lock is needed here, unlike
 * `.experiments.json`'s: this file has no second CLI writer.
 */
let running = false;

export async function drawLearnTick(
  nowMs: number = Date.now(),
  recompute: (nowMs: number) => Promise<DrawLearned | null> = recomputeDrawLearned,
): Promise<void> {
  if (!config.learnedDraw || running) return;
  running = true;
  try {
    const prior = readDrawLearned();
    if (prior && nowMs - prior.computedAt < RECOMPUTE_EVERY_MS) return;
    await recompute(nowMs);
  } catch (err) {
    console.error(`draw: learn tick failed — ${describeError(err)}`);
  } finally {
    running = false;
  }
}
