import type { MatchInfo } from "../api/types.js";
import { MILESTONES, decidedAtMs, formatGap, raceStateAt, type Milestone } from "../shorts/raceGap.js";

/**
 * The "COMING UP" line the meta column shows in the first minute of the long-form: one moment
 * from later in the race, with the RTA the viewer will see on the timer when it happens.
 *
 * Every long-form loses 16–22 points of retention between 3% and 10% of the video (22 Sept 2026),
 * the overworld stretch where nothing on screen promises what is coming. This is the promise.
 * It comes from `match.timelines` alone, so it is ready at render time with no model call.
 *
 * The house rule holds: nothing names the winner. The moment sits at least a minute before the
 * game is decided (`decidedAtMs`), the line names no player at all — "which one?" is part of the
 * pull — and nothing here reads `match.result` beyond what `decidedAtMs` does.
 */
export interface Teaser {
  /** When the moment happens, ms from match start — what the overlay's RTA timer will read. */
  momentMs: number;
  /** "A DEATH AT THE BASTION", upper case, at most TEASER_MAX_CHARS. */
  text: string;
}

/** The meta column holds two lines of this; the longest line built below is 34. */
export const TEASER_MAX_CHARS = 34;
/** Nothing inside the first minute: the teaser is shown in it. */
export const TEASER_EARLIEST_MS = 60_000;
/** Nothing in the last minute before the game is decided: that is the finish, not a moment in the race. */
export const TEASER_BEFORE_DECIDED_MS = 60_000;
/** Two arrivals closer than this are a close split worth promising. */
const CLOSE_SPLIT_MS = 2000;

/**
 * An unplanned death only. `death_spawnpoint` is the routine death warp — a bed set in the
 * portal room, then a deliberate fall to respawn on it at full health (13446429: "Respawn point
 * set", "Infume hit the ground too hard", seven seconds before the End, both players). Promising
 * "a death" and delivering that would teach the viewer the line lies.
 */
const DEATH = "projectelo.timeline.death";

/** Where a player is, by the highest rung they have reached. */
const WHERE: Record<string, string> = {
  "story.enter_the_nether": "IN THE NETHER",
  "nether.find_bastion": "AT THE BASTION",
  "nether.find_fortress": "AT THE FORTRESS",
  "projectelo.timeline.blind_travel": "ON BLIND TRAVEL",
  "story.follow_ender_eye": "IN THE STRONGHOLD",
  "story.enter_the_end": "IN THE END",
};
const where = (m: Milestone | null): string => (m ? WHERE[m.type]! : "IN THE OVERWORLD");

/**
 * The moment to tease, or null when nothing qualifies. In order of preference: an unplanned
 * death (the furthest into the run, then the earliest), the lead change that overturned the
 * biggest deficit, the closest split under two seconds.
 */
export function chooseTeaser(match: MatchInfo): Teaser | null {
  const [left, right] = match.players;
  const decided = decidedAtMs(match);
  if (!left || !right || decided === null) return null;
  const latest = decided - TEASER_BEFORE_DECIDED_MS;
  const inWindow = (ms: number) => ms >= TEASER_EARLIEST_MS && ms <= latest;
  const sideOf = (uuid: string) => (uuid === left.uuid ? "left" : uuid === right.uuid ? "right" : null);
  const rung = (m: Milestone | null) => (m ? MILESTONES.indexOf(m) : -1);

  let death: { at: number; rung: number; where: string } | null = null;
  for (const e of match.timelines) {
    const side = sideOf(e.uuid);
    if (e.type !== DEATH || !side || !inWindow(e.time)) continue;
    const at = raceStateAt(match, e.time).at[side];
    if (!death || rung(at) > death.rung || (rung(at) === death.rung && e.time < death.at))
      death = { at: e.time, rung: rung(at), where: where(at) };
  }
  if (death) return { momentMs: death.at, text: `A DEATH ${death.where}` };

  // The race's state changes only on an arrival, so those are the only times the lead can flip.
  const arrivals = [
    ...new Set(
      match.timelines
        .filter((e) => sideOf(e.uuid) && MILESTONES.some((m) => m.type === e.type))
        .map((e) => e.time),
    ),
  ].sort((a, b) => a - b);
  let flip: { at: number; deficit: number; where: string } | null = null;
  for (const t of arrivals) {
    const before = raceStateAt(match, t - 1);
    const now = raceStateAt(match, t);
    if (!before.leader || !now.leader || before.leader === now.leader || !inWindow(t)) continue;
    // How far behind the new leader was at the rung they shared, 0 when they shared none.
    const deficit = before.gapMs ?? 0;
    if (!flip || deficit > flip.deficit) flip = { at: t, deficit, where: where(now.milestone) };
  }
  if (flip) return { momentMs: flip.at, text: `THE LEAD CHANGES ${flip.where}` };

  let close: { at: number; gap: number; m: Milestone } | null = null;
  for (const m of MILESTONES) {
    const first = (uuid: string) =>
      Math.min(...match.timelines.filter((e) => e.type === m.type && e.uuid === uuid).map((e) => e.time));
    const [l, r] = [first(left.uuid), first(right.uuid)];
    const gap = Math.abs(l - r);
    // Math.min of nothing is Infinity: a side that never got there is no split at all.
    if (!Number.isFinite(gap) || gap >= CLOSE_SPLIT_MS || !inWindow(Math.max(l, r))) continue;
    if (!close || gap < close.gap) close = { at: Math.max(l, r), gap, m };
  }
  if (close) return { momentMs: close.at, text: `${formatGap(close.gap)} APART ${close.m.behind}` };
  return null;
}
