import type { MatchInfo } from "./types.js";
// remotion/format.ts is a CSS-free leaf module (like layout.ts), so Node code can import it.
// It replaces a local formatClock that split seconds without re-carrying into minutes, so a
// value a hair under a minute boundary formatted as "2:60.000".
import { formatTime } from "../remotion/format.js";

/**
 * The seven milestones both players always pass through, in run order. These are the
 * splits the overlay already shows, so a suggestion's split table lines up with the
 * finished video.
 */
const SPLITS: ReadonlyArray<{ label: string; type: string }> = [
  { label: "Nether enter", type: "story.enter_the_nether" },
  { label: "Bastion", type: "nether.find_bastion" },
  { label: "Fortress", type: "nether.find_fortress" },
  { label: "Blaze rod", type: "nether.obtain_blaze_rod" },
  { label: "Blind travel", type: "projectelo.timeline.blind_travel" },
  { label: "Stronghold", type: "story.follow_ender_eye" },
  { label: "End enter", type: "story.enter_the_end" },
];

/** Every split above, plus the dragon. The denominator for "how close was this overall". */
export const TOTAL_SPLITS = SPLITS.length + 1;

const DRAGON_DEATH = "projectelo.timeline.dragon_death";
const KILL_DRAGON = "end.kill_dragon";
const DEATH = "projectelo.timeline.death_spawnpoint";

/**
 * `end.kill_dragon` fires on the killing blow; `dragon_death` fires when the ~10s death
 * animation finishes. Measured across four real matches the offset was 10.27-10.36s
 * (one outlier at 11.09s), so 10.3s converts a kill into a comparable death time.
 */
const KILL_TO_DEATH_MS = 10_300;

/** A split is "close" when the two players hit it within this window. */
const CLOSE_SPLIT_MS = 3_000;

/** Normalisation ceilings: the point at which a term stops earning any score. */
const MARGIN_CEILING_MS = 15_000;
const MAX_LEAD_CEILING_MS = 60_000;
const SWING_CEILING_MS = 120_000;
const LEAD_CHANGE_CEILING = 3;
const DEATH_CEILING = 6;

export interface SplitGap {
  label: string;
  /** Times for players[0] and players[1]; null when that player has no such event. */
  aMs: number | null;
  bMs: number | null;
  /** Absolute gap, or null when only one player reached the split. */
  gapMs: number | null;
  /** Nickname of whoever reached it first, or null when incomparable. */
  leader: string | null;
}

export interface MatchMetrics {
  matchId: number;
  players: [string, string];
  winner: string | null;
  resultMs: number;
  splits: SplitGap[];
  /** Gap at the dragon. null when the losing player never killed it (a DNF finish). */
  finishMarginMs: number | null;
  /** True when either side's dragon time was derived from `end.kill_dragon`. */
  finishEstimated: boolean;
  splitsWithin3s: number;
  /** How many splits (including the dragon) both players actually reached. */
  comparedSplits: number;
  maxLeadMs: number;
  leadChanges: number;
  /** Largest swing in the lead between consecutive splits - catches big collapses. */
  maxSwingMs: number;
  deaths: number;
  deathsByPlayer: Record<string, number>;
}

export interface ScoreWeights {
  closeMargin: number;
  closeSplits: number;
  closeMaxLead: number;
  closeLeadChanges: number;
  closeSpeed: number;
  chaosDeaths: number;
  chaosLeadChanges: number;
  chaosSwing: number;
  chaosSpeed: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  closeMargin: 3,
  closeSplits: 2,
  closeMaxLead: 1.5,
  closeLeadChanges: 1,
  closeSpeed: 1,
  chaosDeaths: 3,
  chaosLeadChanges: 1.5,
  chaosSwing: 2,
  chaosSpeed: 0.5,
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Earliest time per event type for one player. Timelines can repeat a type (a second
 * blind travel, say); the first occurrence is when the milestone was actually reached.
 */
function earliestByType(match: MatchInfo, uuid: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of match.timelines) {
    if (entry.uuid !== uuid) continue;
    const seen = out.get(entry.type);
    if (seen === undefined || entry.time < seen) out.set(entry.type, entry.time);
  }
  return out;
}

/**
 * Comparable dragon-death time. `dragon_death` is authoritative - the official
 * `result.time` is the winner's `dragon_death` + ~9.96s in every match checked - but it
 * is missing for some players, in which case `end.kill_dragon` is shifted to match.
 * Returns null when the player never killed the dragon at all.
 */
function dragonTime(events: Map<string, number>): { ms: number | null; estimated: boolean } {
  const death = events.get(DRAGON_DEATH);
  if (death !== undefined) return { ms: death, estimated: false };
  const kill = events.get(KILL_DRAGON);
  if (kill !== undefined) return { ms: kill + KILL_TO_DEATH_MS, estimated: true };
  return { ms: null, estimated: false };
}

export function computeMetrics(match: MatchInfo): MatchMetrics {
  const [playerA, playerB] = match.players;
  if (!playerA || !playerB) {
    throw new Error(`Match ${match.id} does not have two players (found ${match.players.length}).`);
  }

  const eventsA = earliestByType(match, playerA.uuid);
  const eventsB = earliestByType(match, playerB.uuid);

  const splits: SplitGap[] = SPLITS.map(({ label, type }) => {
    const aMs = eventsA.get(type) ?? null;
    const bMs = eventsB.get(type) ?? null;
    const comparable = aMs !== null && bMs !== null;
    return {
      label,
      aMs,
      bMs,
      gapMs: comparable ? Math.abs(aMs - bMs) : null,
      leader: comparable ? (aMs < bMs ? playerA.nickname : playerB.nickname) : null,
    };
  });

  const dragonA = dragonTime(eventsA);
  const dragonB = dragonTime(eventsB);
  const dragonA_ms = dragonA.ms;
  const dragonB_ms = dragonB.ms;
  const dragonComparable = dragonA_ms !== null && dragonB_ms !== null;
  splits.push({
    label: "Dragon",
    aMs: dragonA_ms,
    bMs: dragonB_ms,
    gapMs: dragonComparable ? Math.abs(dragonA_ms - dragonB_ms) : null,
    leader: dragonComparable ? (dragonA_ms < dragonB_ms ? playerA.nickname : playerB.nickname) : null,
  });

  // Signed gap is positive when player A leads, so a sign flip is a lead change and the
  // step between consecutive signed gaps is the swing.
  let leadChanges = 0;
  let maxLeadMs = 0;
  let maxSwingMs = 0;
  let splitsWithin3s = 0;
  let comparedSplits = 0;
  let previousSigned: number | null = null;
  let previousLeader: string | null = null;

  for (const split of splits) {
    if (split.aMs === null || split.bMs === null || split.gapMs === null) continue;
    comparedSplits += 1;
    if (split.gapMs < CLOSE_SPLIT_MS) splitsWithin3s += 1;
    maxLeadMs = Math.max(maxLeadMs, split.gapMs);

    const signed = split.bMs - split.aMs; // > 0 means A reached it first
    if (previousSigned !== null) maxSwingMs = Math.max(maxSwingMs, Math.abs(signed - previousSigned));
    if (previousLeader !== null && previousLeader !== split.leader) leadChanges += 1;
    previousSigned = signed;
    previousLeader = split.leader;
  }

  const deathsByPlayer: Record<string, number> = { [playerA.nickname]: 0, [playerB.nickname]: 0 };
  for (const entry of match.timelines) {
    if (entry.type !== DEATH) continue;
    if (entry.uuid === playerA.uuid) deathsByPlayer[playerA.nickname] += 1;
    else if (entry.uuid === playerB.uuid) deathsByPlayer[playerB.nickname] += 1;
  }

  const winner = match.players.find((player) => player.uuid === match.result.uuid)?.nickname ?? null;

  return {
    matchId: match.id,
    players: [playerA.nickname, playerB.nickname],
    winner,
    resultMs: match.result.time,
    splits,
    finishMarginMs: dragonComparable ? Math.abs(dragonA_ms - dragonB_ms) : null,
    finishEstimated: dragonA.estimated || dragonB.estimated,
    splitsWithin3s,
    comparedSplits,
    maxLeadMs,
    leadChanges,
    maxSwingMs,
    deaths: deathsByPlayer[playerA.nickname]! + deathsByPlayer[playerB.nickname]!,
    deathsByPlayer,
  };
}

/**
 * 1.0 at or under `fastSec`, falling linearly to 0 at `slowSec`. Speed is a genuine
 * ranking input, but deliberately one term among several - the best-performing video so
 * far (12730175) was a slow 10:22 that won on a 1.0s finish.
 */
export function speedBonus(resultMs: number, fastSec: number, slowSec: number): number {
  if (slowSec <= fastSec) return 0;
  return clamp01((slowSec * 1000 - resultMs) / ((slowSec - fastSec) * 1000));
}

function weightedMean(terms: ReadonlyArray<readonly [number, number]>): number {
  const totalWeight = terms.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight === 0) return 0;
  return terms.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;
}

/** 0-1. Rewards a tight finish, sustained proximity and a fast run. */
export function closenessScore(
  metrics: MatchMetrics,
  weights: ScoreWeights,
  fastSec: number,
  slowSec: number,
): number {
  // A DNF finish scores zero here rather than being dropped: the match stays eligible
  // for the chaos bucket, it just can't win a slot as a close race.
  const marginTerm =
    metrics.finishMarginMs === null ? 0 : clamp01(1 - metrics.finishMarginMs / MARGIN_CEILING_MS);
  // Divided by the full split count rather than the number actually compared: a patchy
  // timeline with 3 of 6 close splits is weaker evidence than 4 of 8, and dividing by
  // `comparedSplits` would score them identically.
  const splitTerm = metrics.splitsWithin3s / TOTAL_SPLITS;
  return weightedMean([
    [marginTerm, weights.closeMargin],
    [splitTerm, weights.closeSplits],
    [clamp01(1 - metrics.maxLeadMs / MAX_LEAD_CEILING_MS), weights.closeMaxLead],
    [Math.min(metrics.leadChanges, LEAD_CHANGE_CEILING) / LEAD_CHANGE_CEILING, weights.closeLeadChanges],
    [speedBonus(metrics.resultMs, fastSec, slowSec), weights.closeSpeed],
  ]);
}

/** 0-1. Rewards deaths, lead changes and big collapses - the "entertaining mess" axis. */
export function chaosScore(
  metrics: MatchMetrics,
  weights: ScoreWeights,
  fastSec: number,
  slowSec: number,
): number {
  return weightedMean([
    [Math.min(metrics.deaths, DEATH_CEILING) / DEATH_CEILING, weights.chaosDeaths],
    [Math.min(metrics.leadChanges, LEAD_CHANGE_CEILING) / LEAD_CHANGE_CEILING, weights.chaosLeadChanges],
    [clamp01(metrics.maxSwingMs / SWING_CEILING_MS), weights.chaosSwing],
    [speedBonus(metrics.resultMs, fastSec, slowSec), weights.chaosSpeed],
  ]);
}

/** Human-readable split table - shared between `npm run score` and the TUI detail view. */
export function formatMetrics(metrics: MatchMetrics): string {
  const [nameA, nameB] = metrics.players;
  const lines: string[] = [];
  lines.push(`Match ${metrics.matchId} - ${nameA} vs ${nameB}`);
  lines.push(`Winner: ${metrics.winner ?? "-"} in ${formatTime(metrics.resultMs)}`);
  lines.push("");
  lines.push(`${"SPLIT".padEnd(14)}${nameA.padStart(14)}${nameB.padStart(14)}      GAP`);
  for (const split of metrics.splits) {
    const a = split.aMs === null ? "--" : formatTime(split.aMs);
    const b = split.bMs === null ? "--" : formatTime(split.bMs);
    const gap =
      split.gapMs === null
        ? "  (incomparable)"
        : `${(split.gapMs / 1000).toFixed(3).padStart(8)}s -> ${split.leader}`;
    lines.push(`${split.label.padEnd(14)}${a.padStart(14)}${b.padStart(14)}  ${gap}`);
  }
  lines.push("");
  const margin =
    metrics.finishMarginMs === null
      ? "DNF (loser never killed the dragon)"
      : `${(metrics.finishMarginMs / 1000).toFixed(3)}s${metrics.finishEstimated ? " (estimated)" : ""}`;
  lines.push(`Finish margin : ${margin}`);
  lines.push(`Splits <3s    : ${metrics.splitsWithin3s}/${metrics.comparedSplits}`);
  lines.push(`Max lead      : ${(metrics.maxLeadMs / 1000).toFixed(1)}s`);
  lines.push(`Max swing     : ${(metrics.maxSwingMs / 1000).toFixed(1)}s`);
  lines.push(`Lead changes  : ${metrics.leadChanges}`);
  const deaths = Object.entries(metrics.deathsByPlayer)
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
  lines.push(`Deaths        : ${metrics.deaths} (${deaths})`);
  return lines.join("\n");
}
