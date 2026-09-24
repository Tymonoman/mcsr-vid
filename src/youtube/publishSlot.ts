/**
 * The next fixed publish slot that nothing else has taken.
 *
 * Browse is three quarters of this channel's traffic, and browse rewards a slot the audience
 * can expect; `publishHourUtc` is the active competitor's measured slot (see src/config.ts).
 *
 * One slot a day, though: two videos published into the same hour compete with each other for
 * the same browse impressions, and three matches rendered overnight are three matches ready by
 * breakfast. So a day another video already claims is skipped rather than doubled up on, and the
 * kit proposes tomorrow — which is also how a week of renders turns into a week of uploads.
 *
 * `minLeadMs` skips a slot that is too close to upload for: a scheduled time YouTube has already
 * passed rejects the whole upload, and an 800 MB file is not on the platform in five minutes.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { getMatch } from "../api/mcsrApi.js";
import { channelUploadsSnapshot, describesMatch, SHORT_MAX_SEC } from "./channelUploads.js";
import { msUntilNextRun } from "../dashboard/nightly.js";
import { allUploads, readUpload } from "./youtubeStore.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which UTC day and hour a moment falls on. A ranked match and a playoff series have their own
 * hours (`publishHourUtc`, `seriesPublishHourUtc`), so a day another kind has claimed is still
 * free for this one: the test is the slot, not the day.
 */
const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);
const slotOf = (ms: number): string => `${dayOf(ms)}:${new Date(ms).getUTCHours()}`;

export function nextPublishSlot(
  nowMs: number,
  hourUtc: number,
  /** RFC 3339 times other videos are already scheduled for — see `claimedPublishTimes`. */
  claimedAt: readonly string[] = [],
  minLeadMs = 60 * 60 * 1000,
  /** Times (ms) this video keeps `gapDays` UTC calendar days away from — see `pairGapTimes`. */
  keepApart: readonly number[] = [],
  gapDays = 0,
): Date {
  const taken = new Set(
    claimedAt
      .map((at) => Date.parse(at))
      // A slot in the past cannot collide with one we are about to propose, and an unparseable
      // date is not a reason to push every upload a day out.
      .filter((ms) => Number.isFinite(ms) && ms > nowMs)
      .map(slotOf),
  );
  let at = nowMs + msUntilNextRun(nowMs, hourUtc);
  if (at - nowMs < minLeadMs) at += DAY_MS;
  while (taken.has(slotOf(at)) || keepApart.some((ms) => Math.abs(dayOf(at) - dayOf(ms)) < gapDays))
    at += DAY_MS;
  return new Date(at);
}

export interface PublishSlot {
  at: Date;
  /** One line when the pair gap pushed the slot past the first free one, else null. */
  why: string | null;
}

/** The slot the kit shows and the chain schedules: the first free one, kept off this pair's other kind. */
export async function publishSlotFor(matchId: number, nowMs: number): Promise<PublishSlot> {
  const hour = publishHourFor(matchDir(matchId));
  const claimed = await claimedPublishTimes(matchId);
  const free = nextPublishSlot(nowMs, hour, claimed);
  const gap = config.seriesPairGapDays;
  const apart = gap > 0 ? await pairGapTimes(matchId, nowMs - (gap + 1) * DAY_MS) : [];
  const at = nextPublishSlot(nowMs, hour, claimed, undefined, apart, gap);
  if (at.getTime() === free.getTime()) return { at, why: null };
  const days = [...apart]
    .sort((a, b) => a - b)
    .map((ms) => new Date(ms).toISOString().slice(0, 10))
    .join(", ");
  const other = isSeries(matchId) ? "ranked video" : "series";
  return { at, why: `pushed out to keep ${gap} days from this pair's ${other} (${days})` };
}

const isSeries = (matchId: number): boolean => existsSync(path.join(matchDir(matchId), "series.json"));

/** "uuidA+uuidB", order-free; null when the match cannot be read — no constraint, not an error. */
async function pairOf(matchId: number): Promise<string | null> {
  try {
    const [a, b] = (await getMatch(matchId)).players;
    return a && b ? [a.uuid, b.uuid].sort().join("+") : null;
  } catch {
    return null;
  }
}

/**
 * When the same pair's video of the other kind (a series for a ranked match, a ranked match for a
 * series) goes or went out, from `sinceMs` on. The doogile–Aquacorde series drew 84 views in 32 h
 * against 2,095 for their ranked video published the same day (24 Sept 2026 audit): two titles
 * naming one pair read as a repeat. A scheduled video counts at its `publishAt`, a public one at
 * its upload; a private one with no time has no day to keep away from. A Short rides on its
 * long-form's day, so it is not counted.
 *
 * The same two players, not one shared one: the top seeds are in most ranked videos, so a
 * one-player rule would hold every series a week out through the playoffs, and the audit's
 * evidence is a repeated pair, not a repeated name.
 */
export async function pairGapTimes(matchId: number, sinceMs: number): Promise<number[]> {
  const timed = [
    ...(await allUploads()).map((u) => ({
      id: u.matchId,
      at: u.record.publishAt ?? (u.record.privacyStatus !== "private" ? u.record.uploadedAt : null),
    })),
    ...channelUploadsSnapshot()
      .filter((v) => !(v.durationSec > 0 && v.durationSec <= SHORT_MAX_SEC))
      .map((v) => ({
        // A series description links game 1 first, and game 1's directory is the series.
        id: Number(/\/matches\/(\d+)/.exec(v.description)?.[1]),
        at: v.publishAt || (v.privacyStatus === "public" ? v.publishedAt : null),
      })),
  ]
    .map((v) => ({ id: v.id, ms: v.at ? Date.parse(v.at) : NaN }))
    .filter((v) => Number.isInteger(v.id) && v.id !== matchId && v.ms >= sinceMs);
  const series = isSeries(matchId);
  const others = timed.filter((v) => isSeries(v.id) !== series);
  const pair = others.length > 0 ? await pairOf(matchId) : null;
  if (!pair) return [];
  const out: number[] = [];
  for (const v of others) if ((await pairOf(v.id)) === pair) out.push(v.ms);
  return [...new Set(out)];
}

/** The hour a match publishes at: a series video (`series.json` in its directory) has its own. */
export const publishHourFor = (dir: string): number =>
  existsSync(path.join(dir, "series.json")) ? config.seriesPublishHourUtc : config.publishHourUtc;

/**
 * The publish times already spoken for, for everything but this match.
 *
 * Two sources, because uploading is half manual: what the channel says is scheduled (a Studio
 * upload with a future `publishAt`, src/youtube/channelUploads.ts) and what this dashboard recorded when
 * it uploaded (`youtube.json`). This match's own scheduling is excluded — a match already booked
 * into tomorrow's slot must not push its own kit into the day after.
 */
export async function claimedPublishTimes(exceptMatchId: number): Promise<string[]> {
  const channel = channelUploadsSnapshot();
  // Every video of this match, not the first: a Short's description carries the same
  // `/matches/<id>` link, so excluding one video by id let the Short stand in for the long-form
  // and the match's own booked slot pushed its kit into the day after.
  const ownVideoId = (await readUpload(exceptMatchId))?.videoId;
  const uploads = await allUploads();
  return [
    ...channel
      .filter((v) => !describesMatch(exceptMatchId, v) && v.videoId !== ownVideoId)
      .map((v) => v.publishAt),
    ...uploads.filter((u) => u.matchId !== exceptMatchId).map((u) => u.record.publishAt),
  ].filter((at): at is string => typeof at === "string" && at.trim() !== "");
}
