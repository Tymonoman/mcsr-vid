/**
 * Fast-track: a really good match found between nightly runs renders right now instead of
 * waiting for `nightlyRenderHourUtc` (the operator, 18 Oct 2026, question 8: "if there's a really
 * good match and it's recent render it and move it up the schedule so we post it first instead of
 * our competitors. if there's a 1 second difference between feinberg and infume and it's a fast
 * match post it asap").
 *
 * Shaped like `creatorWatch.ts`: a 15-minute tick (`server.ts`, main server only), a small state
 * file for the once-a-day cap, per-item errors that cost the rest of the tick nothing. Unlike
 * creator watch, this needs no feed scan of its own — `suggest.ts`'s own scanner already walks
 * the last ten days, so `pooledMatches()` is the whole source.
 *
 * The slot-shuffle the operator also asked for ("moves Y back a slot, and Y's own slot-holder
 * back again, in turn") is deliberately **not** built: rewriting `publishAt` on other
 * already-scheduled videos via `videos.update`, cascading through however many are full, with no
 * operator in the loop, is exactly the "irreversible without the operator" surface CLAUDE.md's
 * house rules keep this dashboard off of. A fast-tracked match renders now and then claims a
 * publish slot the ordinary way (`claimSlot`/`videoPublishTime`, `src/dashboard/shortFlow.ts`)
 * once its hooks are saved, same as every other match — see the handbook for the full rationale.
 *
 * The record watch (22 Oct 2026, the growth plan's idea 3) is a second candidate source: the API's
 * record leaderboard (`recordCandidates`). A run on it within the 48h window joins the pool's
 * candidates; an older one is put to the operator instead (`src/telegram/recordAsk.ts`), queued
 * for tonight on a yes. "Record" and the run time stay in the reason and the ask: nothing that
 * names or orders a video reads either (no "fastest runs" playlist: its membership names the
 * winner).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { blockedIn, config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { getMatch, getRecordLeaderboard } from "../api/mcsrApi.js";
import type { MatchInfo, RecordRun } from "../api/types.js";
import { computeMetrics, metricsDnf, type MatchMetrics } from "../pipeline/matchScore.js";
import { withDiscoveredVods } from "../pipeline/vodDiscovery.js";
import { knownTierFor, POOL_MAX_AGE_DAYS, pooledMatches, scanKnowledge } from "./suggest.js";
import { pairKey } from "./pairPosts.js";
import { blockedOnDisk, listProcessedMatchIds } from "./matchStatus.js";
import { startJob, type Job } from "./jobs.js";
import { afterSettled, nightlyChainRunning, requestExport } from "./nightly.js";
import { shortLog } from "../shorts/shortLog.js";
import { recordNightRender, renderBudgetLeft } from "./renderBudget.js";

/** A match must have happened within this long to be worth jumping the queue for. */
export const FAST_TRACK_WINDOW_MS = 48 * 60 * 60 * 1000;
/** The general rule's close-finish threshold — same number as `suggest.ts`'s `CLOSE_FINISH_MS`,
 *  named separately since the two never need to move together. */
export const FAST_TRACK_CLOSE_MS = 5_000;
export const FAST_TRACK_SUB_EIGHT_MS = 8 * 60 * 1000;
/** The named-pair rule (question 8's second sentence): tighter than the general one. */
export const FEINFUME_CLOSE_MS = 1_000;
export const FEINFUME_SUB_MS = 9 * 60 * 1000;
const FEINFUME_KEY = pairKey(["Feinberg", "Infume"]);

/**
 * Whether a scored match is "really good" enough to jump the nightly's clock: a known pair with
 * a sub-5s or sub-8 finish, or Feinberg vs Infume specifically within 1s on a sub-9 run. `known`
 * is injected the same way `isKnownPick` reads it elsewhere — the scan's own cache, no API call.
 * Both runners must have finished (`finishMarginMs !== null`) in every branch: a sub-8 run whose
 * opponent stopped is a one-sided video, not a race (the operator, 22 Oct 2026, "fast-track only
 * on matches both runners finished": yes).
 */
export function isReallyGood(
  metrics: Pick<MatchMetrics, "players" | "finishMarginMs" | "resultMs">,
  known: (players: readonly [string, string]) => boolean,
): boolean {
  if (metrics.finishMarginMs === null) return false;
  const closeFinish = metrics.finishMarginMs < FAST_TRACK_CLOSE_MS;
  const subEight = metrics.resultMs <= FAST_TRACK_SUB_EIGHT_MS;
  if (known(metrics.players) && (closeFinish || subEight)) return true;
  return (
    pairKey(metrics.players) === FEINFUME_KEY &&
    metrics.finishMarginMs <= FEINFUME_CLOSE_MS &&
    metrics.resultMs < FEINFUME_SUB_MS
  );
}

interface FastTrackHit {
  matchId: number;
  players: string;
  at: string;
  reason: string;
}

interface FastTrackState {
  /** YYYY-MM-DD UTC of the last fast-track started — the whole day's budget, question 8 named no
   *  number so one a day mirrors every other automatic cap in this file (`nightlyMaxRenders`,
   *  evening coverage). */
  lastDate: string | null;
  hits: FastTrackHit[];
}

const MAX_STORED_HITS = 200;
const statePath = (): string => path.join(config.mediaDir, ".fast-track.json");

export function readFastTrackState(): FastTrackState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<FastTrackState>;
    return {
      lastDate: typeof parsed.lastDate === "string" ? parsed.lastDate : null,
      hits: Array.isArray(parsed.hits) ? parsed.hits : [],
    };
  } catch {
    return { lastDate: null, hits: [] };
  }
}

function writeFastTrackState(state: FastTrackState): void {
  const trimmed: FastTrackState = { ...state, hits: state.hits.slice(-MAX_STORED_HITS) };
  const file = statePath();
  writeFileSync(`${file}.tmp`, JSON.stringify(trimmed, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** This hit log since `sinceMs` — the morning report's "since the previous report" shape, same
 *  as `creatorWatch.ts`'s `creatorWatchSince`. */
export function fastTrackSince(
  sinceMs: number,
  state: FastTrackState = readFastTrackState(),
): FastTrackHit[] {
  return state.hits.filter((h) => Date.parse(h.at) >= sinceMs);
}

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/* --- The record watch ---------------------------------------------------------------------------- */

/** "One ask per id ever, at most 2 asks a day" (the record-watch brief, 22 Oct 2026). */
export const MAX_RECORD_ASKS_PER_DAY = 2;

/** `.record-watch.json`: every leaderboard id settled for good, and the asks sent. An id in
 *  `seen` is never fetched again; every asked id is also seen, so it is never asked twice. */
export interface RecordWatchState {
  seen: Record<string, string>;
  asks: Record<string, { at: string; label: string; answer?: "queue" | "skip" }>;
}

const recordWatchPath = (): string => path.join(config.mediaDir, ".record-watch.json");

export function readRecordWatch(): RecordWatchState {
  try {
    const parsed = JSON.parse(readFileSync(recordWatchPath(), "utf8")) as Partial<RecordWatchState>;
    return { seen: parsed.seen ?? {}, asks: parsed.asks ?? {} };
  } catch {
    return { seen: {}, asks: {} };
  }
}

/** Read, change, write in one synchronous step, so the tick and a button press (same process)
 *  never write over each other's change across an await. */
export function updateRecordWatch(change: (s: RecordWatchState) => void): void {
  const state = readRecordWatch();
  change(state);
  const file = recordWatchPath();
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}

const markSeen = (matchId: number, nowMs: number): void =>
  updateRecordWatch((s) => {
    s.seen[String(matchId)] = new Date(nowMs).toISOString();
  });

/** What the operator is asked about: built into text by `src/telegram/recordAsk.ts` alone. */
export interface RecordAsk {
  matchId: number;
  players: readonly [string, string];
  timeMs: number;
}

/** Registered by `src/telegram/recordAsk.ts` (this module never imports it, same seam as
 *  `setFastTrackUploadedHook`); resolves true once the ask is sent. */
let recordAskHook: ((ask: RecordAsk) => Promise<boolean>) | null = null;
export const setRecordAskHook = (hook: (ask: RecordAsk) => Promise<boolean>): void => {
  recordAskHook = hook;
};

export interface RecordCandidate {
  metrics: MatchMetrics;
  dateSec: number;
  timeMs: number;
}

/**
 * The record leaderboard's new runs that pass fast-track's own gates: not blocked, not a DNF,
 * both runners finished, not processed, a known pair (`isReallyGood`; every leaderboard run is
 * sub-8). A run past `POOL_MAX_AGE_DAYS` (its VODs are gone), blocked, a DNF, one-sided or already
 * processed is marked seen and never fetched again; an unknown pair is not, since the scan's
 * follower counts can still come in.
 */
export async function recordCandidates(
  nowMs: number,
  known: (players: readonly [string, string]) => boolean,
  processed: ReadonlySet<number>,
  deps: { records: () => Promise<RecordRun[]>; match: (matchId: number) => Promise<MatchInfo> },
): Promise<RecordCandidate[]> {
  const seen = readRecordWatch().seen;
  const out: RecordCandidate[] = [];
  for (const run of await deps.records()) {
    if (String(run.id) in seen) continue;
    if (nowMs - run.date * 1000 > POOL_MAX_AGE_DAYS * 86_400_000 || blockedIn([run.user.nickname])) {
      markSeen(run.id, nowMs);
      continue;
    }
    let metrics: MatchMetrics;
    try {
      metrics = computeMetrics(await deps.match(run.id));
    } catch (err) {
      console.error(`record watch: #${run.id} unreadable — ${describeError(err)}`);
      continue;
    }
    if (
      blockedIn(metrics.players) ||
      metricsDnf(metrics) ||
      metrics.finishMarginMs === null ||
      processed.has(run.id)
    ) {
      markSeen(run.id, nowMs);
      continue;
    }
    if (isReallyGood(metrics, known)) out.push({ metrics, dateSec: run.date, timeMs: run.time });
  }
  return out;
}

/** m:ss, for the reason and the ask. */
export const runClock = (ms: number): string =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

export interface FastTrackDeps {
  /** Both VODs findable — the pipeline's own first step, same call `nightly.ts`'s
   *  `playoffVodsReady`/`creatorWatch.ts`'s `checkVods` already make. */
  checkVods: (matchId: number) => Promise<boolean>;
  /** Starts the render — `startJob` by default; injected so a test never has to let the real
   *  pipeline run to settle just to see that a render was requested. */
  startRender: (matchId: number) => Job;
  /** The record leaderboard; left out, the record watch does nothing (the pool-only tests). */
  records?: () => Promise<RecordRun[]>;
  match?: (matchId: number) => Promise<MatchInfo>;
  /** Sends the record ask; true once sent. */
  ask?: (ask: RecordAsk) => Promise<boolean>;
}

const liveDeps: FastTrackDeps = {
  checkVods: async (matchId) => {
    const match = await withDiscoveredVods(await getMatch(matchId));
    return match.players.every((p) => match.vod.some((v) => v.uuid === p.uuid));
  },
  startRender: startJob,
  records: getRecordLeaderboard,
  match: getMatch,
  ask: async (ask) => (recordAskHook ? recordAskHook(ask) : false),
};

/** Guards a slow VOD probe outlasting the 15-minute cadence this is called on. */
let ticking = false;

/**
 * The 15-minute tick's own call (`server.ts`, main server only). A no-op while a render of any
 * kind is already in flight — this never competes with the nightly's own chain or a clicked
 * render for the lab's one render slot — or while today's fast-track has already been spent.
 */
export async function fastTrackTick(
  nowMs: number = Date.now(),
  deps: FastTrackDeps = liveDeps,
): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const state = readFastTrackState();
    if (state.lastDate === utcDate(nowMs)) return;
    if (nightlyChainRunning()) return;
    // Counts against the night's shared cap (src/dashboard/renderBudget.ts).
    if (renderBudgetLeft(nowMs) <= 0) return;

    const known = knownTierFor(
      config.favouritePlayers,
      (name) => scanKnowledge().twitchOf(name)?.followers ?? null,
      config.knownFollowerThreshold,
    );
    const processed = new Set(listProcessedMatchIds());
    const pool: Array<{ metrics: MatchMetrics; dateSec: number; recordMs?: number }> = pooledMatches()
      .filter((entry) => !metricsDnf(entry.metrics))
      .filter((entry) => !blockedIn(entry.metrics.players))
      .filter((entry) => !processed.has(entry.metrics.matchId))
      .filter((entry) => isReallyGood(entry.metrics, known));

    let records: RecordCandidate[] = [];
    if (deps.records && deps.match) {
      try {
        records = await recordCandidates(nowMs, known, processed, { records: deps.records, match: deps.match });
      } catch (err) {
        console.error(`record watch: leaderboard unreadable — ${describeError(err)}`);
      }
    }
    for (const r of records) {
      if (nowMs - r.dateSec * 1000 <= FAST_TRACK_WINDOW_MS) {
        // Often already in the pool (it scans the same days): one candidate, marked a record.
        const inPool = pool.find((e) => e.metrics.matchId === r.metrics.matchId);
        if (inPool) inPool.recordMs = r.timeMs;
        else pool.push({ metrics: r.metrics, dateSec: r.dateSec, recordMs: r.timeMs });
      } else {
        await askAboutRecord(r, nowMs, deps);
      }
    }

    const candidates = pool
      .filter((entry) => nowMs - entry.dateSec * 1000 <= FAST_TRACK_WINDOW_MS)
      // Newest first: "it's recent" (question 8) — of several really-good matches, the freshest
      // one is the one worth beating a rival channel's own upload to.
      .sort((a, b) => b.dateSec - a.dateSec);

    for (const entry of candidates) {
      const { matchId, players } = entry.metrics;
      if (blockedOnDisk(matchDir(matchId))) continue;
      let hasVods: boolean;
      try {
        hasVods = await deps.checkVods(matchId);
      } catch (err) {
        console.error(`fast-track: #${matchId} VOD check failed — ${describeError(err)}`);
        continue;
      }
      if (!hasVods) continue;
      // The VOD probe is slow network: the 03:00 nightly may have started (or spent the cap) since
      // the checks at the top of this tick.
      if (nightlyChainRunning() || renderBudgetLeft(nowMs) <= 0) return;

      const label = `${players[0]} vs ${players[1]}`;
      // isReallyGood already refused a null margin: both runners finished.
      const reason =
        `${label}, ${entry.metrics.finishMarginMs}ms margin, ${(entry.metrics.resultMs / 1000).toFixed(1)}s run` +
        (entry.recordMs === undefined ? "" : `, record pace ${runClock(entry.recordMs)}`);
      console.error(`fast-track: starting render of #${matchId} ${label} (${reason})`);

      state.lastDate = utcDate(nowMs);
      state.hits.push({ matchId, players: label, at: new Date(nowMs).toISOString(), reason });
      writeFastTrackState(state);
      try {
        recordNightRender(matchId, nowMs);
      } catch (err) {
        console.error(`fast-track: render ledger write failed — ${describeError(err)}`);
      }

      if (config.nightlyRenderExport) requestExport(matchId);
      const job = deps.startRender(matchId);
      shortLog(matchId, "chain", `fast-tracked: ${reason}`);
      afterSettled(job, async (verdict, exportClause, picked) => {
        const said = verdict.reason ? `${verdict.outcome}: ${verdict.reason}` : verdict.outcome;
        shortLog(matchId, "chain", `fast-track render — ${said}${exportClause}${picked}`);
      });
      // One a day, so one hit per tick at most — the loop exists only to skip a candidate whose
      // VODs are not findable in favour of the next one.
      return;
    }
  } finally {
    ticking = false;
  }
}

/**
 * An older record run (past the 48h window) is the operator's call: one ask, queued for tonight
 * on Queue (`src/telegram/recordAsk.ts`). Its VODs must still be findable; past the window an
 * archive that is not there will not appear, so a miss marks it seen.
 */
async function askAboutRecord(r: RecordCandidate, nowMs: number, deps: FastTrackDeps): Promise<void> {
  const today = utcDate(nowMs);
  const asks = Object.values(readRecordWatch().asks);
  if (asks.filter((a) => utcDate(Date.parse(a.at)) === today).length >= MAX_RECORD_ASKS_PER_DAY) return;
  const { matchId, players } = r.metrics;
  try {
    if (!(await deps.checkVods(matchId))) {
      markSeen(matchId, nowMs);
      return;
    }
    if (!(await deps.ask?.({ matchId, players, timeMs: r.timeMs }))) return;
  } catch (err) {
    console.error(`record watch: ask for #${matchId} failed — ${describeError(err)}`);
    return;
  }
  const at = new Date(nowMs).toISOString();
  updateRecordWatch((s) => {
    s.seen[String(matchId)] = at;
    s.asks[String(matchId)] = { at, label: `${players[0]} vs ${players[1]}` };
  });
}
