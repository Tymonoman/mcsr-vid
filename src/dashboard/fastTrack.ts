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
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { blockedIn, config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { getMatch } from "../api/mcsrApi.js";
import { metricsDnf, type MatchMetrics } from "../pipeline/matchScore.js";
import { withDiscoveredVods } from "../pipeline/vodDiscovery.js";
import { knownTierFor, pooledMatches, scanKnowledge } from "./suggest.js";
import { pairKey } from "./pairPosts.js";
import { blockedOnDisk, listProcessedMatchIds } from "./matchStatus.js";
import { startJob, type Job } from "./jobs.js";
import { afterSettled, nightlyChainRunning, requestExport } from "./nightly.js";
import { shortLog } from "../shorts/shortLog.js";

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
 */
export function isReallyGood(
  metrics: Pick<MatchMetrics, "players" | "finishMarginMs" | "resultMs">,
  known: (players: readonly [string, string]) => boolean,
): boolean {
  const closeFinish = metrics.finishMarginMs !== null && metrics.finishMarginMs < FAST_TRACK_CLOSE_MS;
  const subEight = metrics.resultMs <= FAST_TRACK_SUB_EIGHT_MS;
  if (known(metrics.players) && (closeFinish || subEight)) return true;
  return (
    pairKey(metrics.players) === FEINFUME_KEY &&
    metrics.finishMarginMs !== null &&
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

export interface FastTrackDeps {
  /** Both VODs findable — the pipeline's own first step, same call `nightly.ts`'s
   *  `playoffVodsReady`/`creatorWatch.ts`'s `checkVods` already make. */
  checkVods: (matchId: number) => Promise<boolean>;
  /** Starts the render — `startJob` by default; injected so a test never has to let the real
   *  pipeline run to settle just to see that a render was requested. */
  startRender: (matchId: number) => Job;
}

const liveDeps: FastTrackDeps = {
  checkVods: async (matchId) => {
    const match = await withDiscoveredVods(await getMatch(matchId));
    return match.players.every((p) => match.vod.some((v) => v.uuid === p.uuid));
  },
  startRender: startJob,
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

    const known = knownTierFor(
      config.favouritePlayers,
      (name) => scanKnowledge().twitchOf(name)?.followers ?? null,
      config.knownFollowerThreshold,
    );
    const processed = new Set(listProcessedMatchIds());
    const candidates = pooledMatches()
      .filter((entry) => nowMs - entry.dateSec * 1000 <= FAST_TRACK_WINDOW_MS)
      .filter((entry) => !metricsDnf(entry.metrics))
      .filter((entry) => !blockedIn(entry.metrics.players))
      .filter((entry) => !processed.has(entry.metrics.matchId))
      .filter((entry) => isReallyGood(entry.metrics, known))
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

      const label = `${players[0]} vs ${players[1]}`;
      const margin =
        entry.metrics.finishMarginMs === null ? "DNF margin" : `${entry.metrics.finishMarginMs}ms margin`;
      const reason = `${label}, ${margin}, ${(entry.metrics.resultMs / 1000).toFixed(1)}s run`;
      console.error(`fast-track: starting render of #${matchId} ${label} (${reason})`);

      state.lastDate = utcDate(nowMs);
      state.hits.push({ matchId, players: label, at: new Date(nowMs).toISOString(), reason });
      writeFastTrackState(state);

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
