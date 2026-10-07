/**
 * Everything the Telegram report needs, gathered once and rendered deterministically
 * (report.ts): every number, list and link in a report comes from here, never from Claude —
 * Claude only turns the TODAY section's facts into a headline and an ordered to-do list, asked
 * from index.ts through the adapter in claude.ts.
 *
 * Every section catches its own errors (`section()`): a dead API or a corrupt file on disk costs
 * that one line of the report, never the whole message.
 */
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { getRecentMatches } from "../api/mcsrApi.js";
import { getBroadcasterIds, isConfigured as twitchConfigured } from "../api/twitch.js";
import {
  isConfigured as youtubeConfigured,
  dataApiGet,
  channelCommentThreads,
  getAccessToken,
} from "../youtube/youtube.js";
import { readUpload } from "../youtube/youtubeStore.js";
import { fetchYppSnapshot, projectYpp, type YppProgress } from "../youtube/yppProgress.js";
import { capacity } from "../dashboard/archive.js";
import { readNightlyState, MIN_FREE_MATCHES, type NightlyLastRun } from "../dashboard/nightly.js";
import { restartState } from "../dashboard/restartWhenIdle.js";
import { nightlyQueue, nightlySkip } from "../dashboard/matchShelf.js";
import { listProcessedMatchIds, matchStatusFor } from "../dashboard/matchStatus.js";
import { nightlyShortSummary, readStatus } from "../dashboard/shortFlow.js";
import { pickErrorFile } from "../shorts/videoPick.js";
import { playoffBoard } from "../playoffs/playoffs.js";
import { describeFailure, runClaude } from "./claude.js";
import { filterUnanswered, type UnansweredComment } from "./comments.js";
import { gatherWorth, type WorthFacts } from "./worth.js";
import {
  aggregateWindows,
  latestDate,
  type DayRow,
  type WindowDays,
  type WindowTotals,
} from "./windowStats.js";

type Section<T> = { ok: true; data: T } | { ok: false; error: string };

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/** A section nobody asked `gatherFacts` for — the command that dispatched doesn't read it. */
function notRequested<T>(): Section<T> {
  return { ok: false, error: "not requested" };
}

/**
 * `work`, or a rejection with `message` once `ms` have passed. The timer is cleared the moment
 * `work` settles, so it never holds a finished process open. `work` itself is not cancelled (what it
 * calls takes no AbortSignal): a late finish still lands, and a late failure is handled by the
 * race rather than becoming an unhandled rejection that would take the dashboard down.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overrun = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, overrun]).finally(() => clearTimeout(timer));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `<left> vs <right>`, from a `matchStatusFor` entry — the one place this string is built. */
const playersOf = (m: { leftNickname: string; rightNickname: string }): string =>
  `${m.leftNickname} vs ${m.rightNickname}`;

/** The dashboard's base URL without a trailing slash: what every link in a report is built on. */
export const dashboardMatchUrl = (): string => config.dashboardBaseUrl.replace(/\/+$/, "");

/* --- Waiting for a hook / scheduled / playoffs (the TODAY facts) ------------------------------ */

export interface WaitingHookRow {
  matchId: number;
  players: string;
  detail?: string;
}

export interface ScheduledRow {
  matchId: number;
  players: string;
  kind: "video" | "short";
  at: string;
}

export interface UpcomingRow extends ScheduledRow {
  /** 0 = today (Warsaw-agnostic: a plain 24 h bucket from `nowMs`, as the schedule itself is UTC). */
  dayOffset: number;
}

export interface TodoFacts {
  waitingForHook: WaitingHookRow[];
  scheduledToday: ScheduledRow[];
  scheduledTomorrowCount: number;
  scheduledDayAfterCount: number;
  diskMatchesLeft: number | null;
  diskLow: boolean;
  playoffsSoon: { round: string; startTime: number | null; bestOf: number } | null;
  queuedTonight: number;
}

/**
 * Every match with a future `publishAt` (video or Short) landing within the next `days` 24 h
 * buckets from `nowMs`, oldest first. Shared by the TODAY facts (today/tomorrow/day-after counts)
 * and `/overnight`'s "next 7 days" — one pass over the upload records either way.
 */
export async function gatherUpcoming(nowMs: number, days: number): Promise<UpcomingRow[]> {
  const out: UpcomingRow[] = [];
  for (const id of listProcessedMatchIds()) {
    for (const kind of ["video", "short"] as const) {
      const record = await readUpload(id, kind);
      if (!record?.publishAt) continue;
      const at = Date.parse(record.publishAt);
      if (!Number.isFinite(at) || at <= nowMs) continue;
      const dayOffset = Math.floor((at - nowMs) / DAY_MS);
      if (dayOffset < 0 || dayOffset >= days) continue;
      const m = await matchStatusFor(id).catch(() => null);
      out.push({ matchId: id, players: m ? playersOf(m) : `#${id}`, kind, at: record.publishAt, dayOffset });
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

async function gatherTodo(nowMs: number): Promise<TodoFacts> {
  const summary = await nightlyShortSummary();
  const waitingForHook = await Promise.all(
    summary.waitingForHook.map(async (matchId) => {
      const m = await matchStatusFor(matchId).catch(() => null);
      return { matchId, players: m ? playersOf(m) : `#${matchId}` };
    }),
  );

  const upcoming = await gatherUpcoming(nowMs, 3);
  const scheduledToday = upcoming.filter((u) => u.dayOffset === 0);
  const scheduledTomorrowCount = upcoming.filter((u) => u.dayOffset === 1).length;
  const scheduledDayAfterCount = upcoming.filter((u) => u.dayOffset === 2).length;

  const cap = await capacity();
  const diskMatchesLeft = cap.working?.matchesLeft ?? null;

  const board = await playoffBoard(nowMs / 1000);
  // The board stays up while a finished round's games may still be found; only a slot still to be
  // played in the next 14 days is news for the day.
  const soon = board.slots.find(
    (s) => s.startTime !== null && s.startTime * 1000 >= nowMs && s.startTime * 1000 <= nowMs + 14 * DAY_MS,
  );
  const playoffsSoon = soon ? { round: soon.round, startTime: soon.startTime, bestOf: soon.bestOf } : null;

  return {
    waitingForHook,
    scheduledToday,
    scheduledTomorrowCount,
    scheduledDayAfterCount,
    diskMatchesLeft,
    diskLow: diskMatchesLeft !== null && diskMatchesLeft < MIN_FREE_MATCHES,
    playoffsSoon,
    queuedTonight: nightlyQueue().length,
  };
}

/* --- Alerts ------------------------------------------------------------------------------------ */

export interface AlertItem {
  source: string;
  message: string;
}

async function gatherAlerts(nowMs: number, health: HealthCheck[]): Promise<AlertItem[]> {
  const out: AlertItem[] = [];
  const since = nowMs - DAY_MS;

  const last = readNightlyState();
  if (
    last &&
    (last.outcome === "failed" || last.outcome === "aborted") &&
    Date.parse(last.startedAt) >= since
  ) {
    out.push({
      source: "nightly",
      message: `#${last.matchId ?? "?"} ${last.players.join(" vs ")} — ${last.outcome}${last.reason ? `: ${last.reason}` : ""}`,
    });
  }

  const summary = await nightlyShortSummary();
  for (const matchId of summary.failed) {
    const status = readStatus(matchId);
    const recent = status.errors.find((e) => Date.parse(e.at) >= since);
    if (recent) out.push({ source: `chain #${matchId}`, message: `${recent.step}: ${recent.message}` });
  }

  for (const matchId of listProcessedMatchIds()) {
    const file = pickErrorFile(matchDir(matchId), matchId);
    if (!existsSync(file)) continue;
    try {
      const err = JSON.parse(readFileSync(file, "utf8")) as { at: string; message: string };
      if (Date.parse(err.at) >= since) out.push({ source: `pick #${matchId}`, message: err.message });
    } catch {
      // A truncated pick-error file names nothing worth alerting on.
    }
  }

  for (const matchId of listProcessedMatchIds()) {
    for (const kind of ["video", "short"] as const) {
      const record = await readUpload(matchId, kind);
      const failed = record?.finished?.playlists;
      if (typeof failed === "string") {
        out.push({ source: `playlist ${kind} #${matchId}`, message: failed });
      }
    }
  }

  for (const h of health) {
    if (!h.ok) out.push({ source: "health", message: `${h.name}: ${h.detail ?? "not reachable"}` });
  }

  return out;
}

/* --- Health ------------------------------------------------------------------------------------ */

export interface HealthCheck {
  name: string;
  ok: boolean;
  ms?: number;
  detail?: string;
}

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; ms: number; value: T } | { ok: false; ms: number; error: string }> {
  const start = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - start, value };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: describeError(err) };
  }
}

async function pingMcsr(): Promise<HealthCheck> {
  const r = await timed(() => getRecentMatches({ count: 1 }));
  return r.ok
    ? { name: "MCSR Ranked API", ok: true, ms: r.ms }
    : { name: "MCSR Ranked API", ok: false, ms: r.ms, detail: r.error };
}

async function pingTwitch(): Promise<HealthCheck> {
  if (!twitchConfigured()) return { name: "Twitch", ok: false, detail: "TWITCH_CLIENT_ID/SECRET not set" };
  const r = await timed(() => getBroadcasterIds(["twitch"]));
  return r.ok
    ? { name: "Twitch", ok: true, ms: r.ms }
    : { name: "Twitch", ok: false, ms: r.ms, detail: r.error };
}

async function pingYoutubeData(): Promise<HealthCheck> {
  if (!youtubeConfigured()) return { name: "YouTube Data API", ok: false, detail: "no token" };
  const r = await timed(() => dataApiGet("/channels?part=id&mine=true"));
  return r.ok
    ? { name: "YouTube Data API", ok: true, ms: r.ms }
    : { name: "YouTube Data API", ok: false, ms: r.ms, detail: r.error };
}

/** ~30 s: a live round trip, not the TODAY ask's full two-minute budget. */
const PING_TIMEOUT_MS = 30_000;

async function pingClaude(): Promise<HealthCheck> {
  const start = Date.now();
  const reply = await runClaude("Reply with exactly the word OK and nothing else.", {
    systemPrompt: "Plain text only, no tools. Reply with exactly the word OK and nothing else.",
    timeoutMs: PING_TIMEOUT_MS,
  });
  const ms = Date.now() - start;
  return reply.ok
    ? { name: "claude (haiku)", ok: true, ms }
    : { name: "claude (haiku)", ok: false, ms, detail: describeFailure(reply) };
}

async function pingGroq(): Promise<HealthCheck | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const r = await timed(async () => {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
  return r.ok ? { name: "Groq", ok: true, ms: r.ms } : { name: "Groq", ok: false, ms: r.ms, detail: r.error };
}

/**
 * restartWhenIdle.ts's own kept state, not a ping: an armed restart whose boot check failed or
 * whose idle() check itself threw stays invisible otherwise — nothing else reads it, and the
 * operator's workflow is "reads only the morning report" (review fix, 8 Oct 2026; before this, a
 * stuck self-deploy showed only in container logs or a GET nobody was polling).
 */
export function restartIdleHealth(): HealthCheck | null {
  const state = restartState();
  if (!state?.error) return null;
  return { name: "restart-when-idle", ok: false, detail: state.error.split("\n")[0] };
}

/** The Tailscale DNS incident of 27 Sept 2026: a lookup over 1 s is worth flagging on its own. */
async function pingDns(): Promise<HealthCheck> {
  const r = await timed(() => lookup("api.mcsrranked.com"));
  if (!r.ok) return { name: "DNS (api.mcsrranked.com)", ok: false, ms: r.ms, detail: r.error };
  return {
    name: "DNS (api.mcsrranked.com)",
    ok: r.ms <= 1000,
    ms: r.ms,
    detail: r.ms > 1000 ? "over 1 s" : undefined,
  };
}

async function diskHealth(): Promise<HealthCheck> {
  const cap = await capacity();
  const w = cap.working;
  if (!w) return { name: "disk (/media)", ok: false, detail: "could not read free space" };
  const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
  return {
    name: "disk (/media)",
    ok: w.matchesLeft >= MIN_FREE_MATCHES,
    detail: `${gb(w.freeBytes)} free, ~${w.matchesLeft} matches left`,
  };
}

async function gatherHealth(): Promise<HealthCheck[]> {
  const checks = await Promise.all([
    pingMcsr(),
    pingTwitch(),
    pingYoutubeData(),
    pingClaude(),
    pingGroq(),
    pingDns(),
    diskHealth(),
    Promise.resolve(restartIdleHealth()),
  ]);
  return checks.filter((c): c is HealthCheck => c !== null);
}

/* --- Overnight --------------------------------------------------------------------------------- */

export interface OvernightUploadRow {
  matchId: number;
  kind: "video" | "short";
  players: string;
  videoId: string;
  uploadedAt: string;
  publishAt: string | null;
}

export interface OvernightNowPublicRow {
  matchId: number;
  kind: "video" | "short";
  players: string;
  videoId: string;
  publishAt: string;
}

export interface OvernightFacts {
  uploaded: OvernightUploadRow[];
  nowPublic: OvernightNowPublicRow[];
  nightlyRendered: NightlyLastRun | null;
}

async function gatherOvernight(sinceMs: number, nowMs: number): Promise<OvernightFacts> {
  const uploaded: OvernightUploadRow[] = [];
  const nowPublic: OvernightNowPublicRow[] = [];
  for (const matchId of listProcessedMatchIds()) {
    let players: string | null = null;
    for (const kind of ["video", "short"] as const) {
      const record = await readUpload(matchId, kind);
      if (!record) continue;
      if (Date.parse(record.uploadedAt) >= sinceMs) {
        players ??= await matchStatusFor(matchId)
          .then(playersOf)
          .catch(() => `#${matchId}`);
        uploaded.push({
          matchId,
          kind,
          players,
          videoId: record.videoId,
          uploadedAt: record.uploadedAt,
          publishAt: record.publishAt,
        });
      }
      // A record's privacyStatus is never updated after upload (CLAUDE.md), so a passed
      // publishAt is read as "should be public now", not confirmed live — the report says so.
      if (record.publishAt) {
        const at = Date.parse(record.publishAt);
        if (at >= sinceMs && at <= nowMs) {
          players ??= await matchStatusFor(matchId)
            .then(playersOf)
            .catch(() => `#${matchId}`);
          nowPublic.push({ matchId, kind, players, videoId: record.videoId, publishAt: record.publishAt });
        }
      }
    }
  }
  const last = readNightlyState();
  const nightlyRendered = last && Date.parse(last.startedAt) >= sinceMs ? last : null;
  return { uploaded, nowPublic, nightlyRendered };
}

/* --- Stats -------------------------------------------------------------------------------------- */

const ANALYTICS_METRICS = [
  "views",
  "engagedViews",
  "estimatedMinutesWatched",
  "subscribersGained",
  "subscribersLost",
  "likes",
  "comments",
] as const;

export interface ChannelSnapshot {
  subscribers: number;
  views: number;
  videos: number;
}

export interface StatsFacts {
  live: ChannelSnapshot;
  dataEndsOn: string | null;
  windows: Record<WindowDays, WindowTotals>;
}

async function analyticsDayRows(token: string, days: number): Promise<DayRow[]> {
  const end = new Date();
  const start = new Date(Date.now() - days * DAY_MS);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const url = `https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({
    ids: "channel==MINE",
    startDate: ymd(start),
    endDate: ymd(end),
    dimensions: "day",
    metrics: ANALYTICS_METRICS.join(","),
  })}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { rows?: (string | number)[][]; error?: { message: string } };
  if (!res.ok || body.error) throw new Error(`Analytics: ${body.error?.message ?? res.status}`);
  return (body.rows ?? []).map((r) => {
    const row: DayRow = { date: String(r[0]) };
    ANALYTICS_METRICS.forEach((m, i) => (row[m] = Number(r[i + 1] ?? 0)));
    return row;
  });
}

async function gatherStats(): Promise<StatsFacts> {
  const channel = await dataApiGet<{
    items?: Array<{ statistics: { subscriberCount: string; viewCount: string; videoCount: string } }>;
  }>("/channels?part=statistics&mine=true");
  const stats = channel.items?.[0]?.statistics;
  const live: ChannelSnapshot = {
    subscribers: Number(stats?.subscriberCount ?? 0),
    views: Number(stats?.viewCount ?? 0),
    videos: Number(stats?.videoCount ?? 0),
  };
  const token = await getAccessToken();
  const rows = await analyticsDayRows(token, 62);
  return { live, dataEndsOn: latestDate(rows), windows: aggregateWindows(rows, [...ANALYTICS_METRICS]) };
}

/* --- Comments ------------------------------------------------------------------------------------ */

export interface CommentsFacts {
  unanswered: UnansweredComment[];
  /** Titles for the videos the comments are on, by videoId — one videos.list call (≤50 ids, 1 unit). */
  videoTitles: Record<string, string>;
}

async function gatherComments(): Promise<CommentsFacts> {
  const threads = await channelCommentThreads(config.youtubeChannelId, 50);
  const unanswered = filterUnanswered(threads).sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  const ids = [...new Set(unanswered.map((c) => c.videoId))].slice(0, 50);
  const videoTitles: Record<string, string> = {};
  if (ids.length) {
    const body = await dataApiGet<{ items?: Array<{ id: string; snippet: { title: string } }> }>(
      `/videos?part=snippet&id=${ids.map(encodeURIComponent).join(",")}`,
    );
    for (const v of body.items ?? []) videoTitles[v.id] = v.snippet.title;
  }
  return { unanswered, videoTitles };
}

/* --- The whole report's facts -------------------------------------------------------------------- */

export interface ReportFacts {
  nowMs: number;
  todo: Section<TodoFacts>;
  alerts: Section<AlertItem[]>;
  health: HealthCheck[];
  overnight: Section<OvernightFacts>;
  stats: Section<StatsFacts>;
  comments: Section<CommentsFacts>;
  ypp: Section<YppProgress>;
  worthRendering: Section<WorthFacts>;
  dashboardBaseUrl: string;
}

/** Which of `ReportFacts`' sections `gatherFacts` actually computes — a narrow slash command
 *  (`/stats`, `/comments`, `/ypp`, `/waiting`, `/health`, `/alerts`, `/worth`) asks for only its
 *  own, so it pays for only its own API calls and skips the live Claude ping `gatherHealth` makes. */
export type FactSection =
  "todo" | "alerts" | "health" | "overnight" | "stats" | "comments" | "ypp" | "worthRendering";
/** The day's picture — what `/todo` and `/ask` read. `worthRendering` is not in it: it costs ~14 MCSR
 *  calls and a few yt-dlp listings when its six-hour cache is cold, and neither command shows it. */
const ALL_SECTIONS: readonly FactSection[] = [
  "todo",
  "alerts",
  "health",
  "overnight",
  "stats",
  "comments",
  "ypp",
];
/** The morning report (scheduled or `/report`): the day's picture and the list of matches worth rendering. */
export const MORNING_SECTIONS: readonly FactSection[] = [...ALL_SECTIONS, "worthRendering"];

/**
 * The one section that can outlast the report: its MCSR calls carry no timeout, so a slow API (the
 * 27 Sept DNS kind) would hold `gatherFacts`' `Promise.all` — and the 07:00 report with it. Past
 * this it degrades to its one failure line, and the gather finishes (and caches) in the background.
 */
export const WORTH_DEADLINE_MS = 120_000;

export const gatherWorthSection = (
  nowMs: number,
  fresh = false,
  deadlineMs = WORTH_DEADLINE_MS,
  gather: typeof gatherWorth = gatherWorth,
): Promise<Section<WorthFacts>> =>
  section(() => withDeadline(gather(nowMs, { fresh }), deadlineMs, "worth rendering timed out"));

/**
 * `sinceMs` is when the last report went out (or 24 h ago, the default) — what "overnight" and
 * "since the previous report" mean throughout. `only` narrows which sections are actually
 * gathered (default: the day's picture, for `/todo`/`/ask`, which want it whole; the morning report
 * passes `MORNING_SECTIONS`); a section left out comes back `{ ok: false, error: "not requested" }`
 * rather than being computed. `alerts` needs the health checks itself (a down API is one of its
 * lines), so asking for `alerts` alone still runs `gatherHealth`. `freshWorth` skips the six-hour
 * cache of the `worthRendering` section (`/worth` asks for it); `worthDeadlineMs` is the test's
 * way to shorten that section's `WORTH_DEADLINE_MS`.
 */
export async function gatherFacts(
  nowMs = Date.now(),
  sinceMs = nowMs - DAY_MS,
  only: readonly FactSection[] = ALL_SECTIONS,
  opts: { freshWorth?: boolean; worthDeadlineMs?: number } = {},
): Promise<ReportFacts> {
  const want = new Set(only);
  const health = want.has("health") || want.has("alerts") ? await gatherHealth() : [];
  const [todo, alerts, overnight, stats, comments, ypp, worthRendering] = await Promise.all([
    want.has("todo") ? section(() => gatherTodo(nowMs)) : Promise.resolve(notRequested<TodoFacts>()),
    want.has("alerts")
      ? section(() => gatherAlerts(nowMs, health))
      : Promise.resolve(notRequested<AlertItem[]>()),
    want.has("overnight")
      ? section(() => gatherOvernight(sinceMs, nowMs))
      : Promise.resolve(notRequested<OvernightFacts>()),
    want.has("stats") ? section(() => gatherStats()) : Promise.resolve(notRequested<StatsFacts>()),
    want.has("comments") ? section(() => gatherComments()) : Promise.resolve(notRequested<CommentsFacts>()),
    want.has("ypp")
      ? section(async () => {
          const snapshot = await fetchYppSnapshot(nowMs);
          return projectYpp(snapshot, nowMs);
        })
      : Promise.resolve(notRequested<YppProgress>()),
    want.has("worthRendering")
      ? gatherWorthSection(nowMs, opts.freshWorth, opts.worthDeadlineMs)
      : Promise.resolve(notRequested<WorthFacts>()),
  ]);
  return {
    nowMs,
    todo,
    alerts,
    health,
    overnight,
    stats,
    comments,
    ypp,
    worthRendering,
    dashboardBaseUrl: dashboardMatchUrl(),
  };
}

/* --- /nightly: the last run and tonight's queue -------------------------------------------------
 *
 * Not the full ranked candidate (`nightlyCandidate` in nightly.ts) — that needs a warm suggestion
 * scan, which this process may not have run. The queue and the skip list cost nothing to read and
 * are what "tonight would render" means when nobody has queued anything specific: the top of the
 * dashboard's own suggestion order, which this bot does not reproduce.
 */
export interface NightlyFacts {
  lastRun: NightlyLastRun | null;
  hourUtc: number | null;
  queue: Array<{ matchId: number; players: string }>;
  skipped: number[];
}

export async function gatherNightlyInfo(): Promise<NightlyFacts> {
  const queue = await Promise.all(
    nightlyQueue().map(async (matchId) => {
      const m = await matchStatusFor(matchId).catch(() => null);
      return { matchId, players: m ? playersOf(m) : `#${matchId}` };
    }),
  );
  return { lastRun: readNightlyState(), hourUtc: config.nightlyRenderHourUtc, queue, skipped: nightlySkip() };
}

export { MIN_FREE_MATCHES };
