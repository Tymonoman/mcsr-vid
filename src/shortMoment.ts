import type { MatchInfo, TimelineEntry } from "./types.js";

/**
 * Picks the ~30 seconds of a match worth cutting into a Short.
 *
 * Everything here comes from `match.timelines` — the same event list the splits and the chaos
 * score are built from — so choosing a moment costs no video decoding at all. That matters: a
 * scene-change pass over one 11-minute POV measured ~3.5 minutes of all four cores, and it
 * would only rediscover the events the API already handed us with timestamps attached.
 *
 * The scoring is deliberately shaped for Shorts rather than reused from `matchScore`, which
 * ranks whole matches. A Short is not a match in miniature: it needs something in the first two
 * seconds or the viewer scrolls, and it needs its payoff near the end rather than at the start.
 */

/** Seconds of match footage a Short covers. */
export const SHORT_WINDOW_SEC = 30;
/** How far apart candidate windows are tried. */
const STRIDE_SEC = 1;
/** The opening that has to earn the scroll. */
const HOOK_SEC = 2;
/**
 * Where in the window the biggest moment should land, as a fraction. 0.7 leaves ~21s of build
 * and ~9s of reaction — long enough to see it coming, short enough not to sit through the
 * aftermath.
 */
const PAYOFF_TARGET = 0.7;

/**
 * How much each event is worth as the payoff of a Short. Everything not listed scores zero:
 * `mine_stone`, `smelt_iron` and friends are how a run is *made*, not why anyone watches one.
 *
 * These are informed guesses, not measurements — there is no retention data for a channel with
 * no Shorts yet. They belong in config once there is.
 */
export const EVENT_WEIGHTS: Record<string, number> = {
  "projectelo.timeline.dragon_death": 1.0,
  "end.kill_dragon": 0.95,
  "projectelo.timeline.death_spawnpoint": 0.8,
  "projectelo.timeline.death": 0.8,
  "story.enter_the_end": 0.7,
  "projectelo.timeline.blind_travel": 0.65,
  "story.follow_ender_eye": 0.5,
  "nether.obtain_blaze_rod": 0.45,
  "nether.find_fortress": 0.35,
  "nether.loot_bastion": 0.3,
  "nether.find_bastion": 0.3,
  "story.enter_the_nether": 0.25,
};

export interface ShortMoment {
  /** Milliseconds from match start (RTA 0:00) where the Short begins. */
  startMs: number;
  endMs: number;
  score: number;
  /** One line naming why this window won, for the dashboard and the commit trail. */
  reason: string;
  /** The scored events inside it, earliest first. */
  events: TimelineEntry[];
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const weightOf = (type: string) => EVENT_WEIGHTS[type] ?? 0;

/**
 * The moments where the lead changed hands, in ms.
 *
 * `matchScore.leadChanges` counts these; a Short needs to know *when*. A lead change is the most
 * watchable thing in a race that isn't the finish, because it is the only event whose meaning
 * depends on both players at once.
 */
export function leadChangeTimes(match: MatchInfo, leftUuid: string, rightUuid: string): number[] {
  const byType = new Map<string, { left?: number; right?: number }>();
  for (const entry of match.timelines) {
    if (weightOf(entry.type) === 0) continue;
    const side = entry.uuid === leftUuid ? "left" : entry.uuid === rightUuid ? "right" : null;
    if (!side) continue;
    const row = byType.get(entry.type) ?? {};
    // The earliest occurrence is the milestone, matching computeSplits.
    if (row[side] === undefined || entry.time < row[side]!) row[side] = entry.time;
    byType.set(entry.type, row);
  }

  const paired = [...byType.values()]
    .filter((r): r is { left: number; right: number } => r.left !== undefined && r.right !== undefined)
    .sort((a, b) => Math.min(a.left, a.right) - Math.min(b.left, b.right));

  const times: number[] = [];
  let previousLeader: "left" | "right" | null = null;
  for (const row of paired) {
    const leader = row.left <= row.right ? "left" : "right";
    // The change becomes visible when the *second* player reaches the milestone — that is the
    // frame where the order on screen actually swaps.
    if (previousLeader !== null && leader !== previousLeader) times.push(Math.max(row.left, row.right));
    previousLeader = leader;
  }
  return times;
}

export interface ShortMomentOptions {
  leftUuid: string;
  rightUuid: string;
  /** Length of the run, ms. Windows are not allowed to run past it. */
  runMs: number;
  windowSec?: number;
}

/**
 * Scores every candidate window and returns them best-first.
 *
 * Scores are comparable within one match only, exactly like `Suggestion.score` — they say which
 * 30 seconds of *this* match to cut, not whether this match deserves a Short at all.
 */
export function rankShortMoments(match: MatchInfo, opts: ShortMomentOptions): ShortMoment[] {
  const windowSec = opts.windowSec ?? SHORT_WINDOW_SEC;
  const windowMs = windowSec * 1000;
  const scored = match.timelines.filter((e) => weightOf(e.type) > 0).sort((a, b) => a.time - b.time);
  if (scored.length === 0) return [];

  const flips = leadChangeTimes(match, opts.leftUuid, opts.rightUuid);

  // Pair each milestone both players reached, so "they did the same thing seconds apart" — the
  // one thing a dual-POV Short shows that no single-POV clip can — is scoreable.
  const pairGaps = new Map<number, number>();
  const byType = new Map<string, number[]>();
  for (const e of scored) {
    if (e.uuid !== opts.leftUuid && e.uuid !== opts.rightUuid) continue;
    byType.set(e.type, [...(byType.get(e.type) ?? []), e.time]);
  }
  for (const times of byType.values()) {
    if (times.length < 2) continue;
    const [a, b] = [Math.min(...times), Math.max(...times)];
    pairGaps.set(b, b - a);
  }

  const lastEnd = Math.min(opts.runMs, scored[scored.length - 1]!.time + windowMs * 0.4);
  const moments: ShortMoment[] = [];
  for (let startMs = 0; startMs + windowMs <= Math.max(windowMs, lastEnd); startMs += STRIDE_SEC * 1000) {
    const endMs = startMs + windowMs;
    const inside = scored.filter((e) => e.time >= startMs && e.time < endMs);
    if (inside.length === 0) continue;

    const best = inside.reduce((a, b) => (weightOf(b.type) > weightOf(a.type) ? b : a));
    const position = (best.time - startMs) / windowMs;
    const payoff = weightOf(best.type) * (1 - Math.abs(position - PAYOFF_TARGET));

    const hookEvents = inside.filter((e) => e.time < startMs + HOOK_SEC * 1000);
    const hook = hookEvents.length === 0 ? 0 : Math.max(...hookEvents.map((e) => weightOf(e.type)));

    const leadFlip = flips.some((t) => t >= startMs && t < endMs) ? 1 : 0;

    let simultaneity = 0;
    for (const [at, gap] of pairGaps) {
      if (at >= startMs && at < endMs) simultaneity = Math.max(simultaneity, clamp01(1 - gap / 5000));
    }

    const density = clamp01(inside.reduce((sum, e) => sum + weightOf(e.type), 0) / 3);

    // Weights, not a formula to be clever about: payoff dominates, a lead flip is nearly as good
    // as a big single event, and the hook is a tiebreak that stops a window opening on dead air.
    const score = 3 * clamp01(payoff) + 2.5 * leadFlip + 2 * simultaneity + 1.5 * hook + 1 * density;

    const reasons = [
      `payoff ${best.type.split(".").pop()} at +${((best.time - startMs) / 1000).toFixed(0)}s`,
    ];
    if (leadFlip) reasons.push("lead change");
    if (simultaneity > 0.5) reasons.push("both players within seconds");
    if (hook > 0) reasons.push("opens on an event");
    moments.push({ startMs, endMs, score, reason: reasons.join(", "), events: inside });
  }

  return moments.sort((a, b) => b.score - a.score);
}

/**
 * Best-first, but with overlapping windows collapsed.
 *
 * A 1-second stride means the runner-up to any window is almost always the same window shifted
 * by a second. That is the right resolution to *search* at and a useless thing to offer a human:
 * "here are three options" has to mean three different moments.
 */
export function distinctShortMoments(match: MatchInfo, opts: ShortMomentOptions, limit = 3): ShortMoment[] {
  const chosen: ShortMoment[] = [];
  for (const moment of rankShortMoments(match, opts)) {
    if (chosen.some((c) => moment.startMs < c.endMs && c.startMs < moment.endMs)) continue;
    chosen.push(moment);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

/** The single best window, or null when the match has no scoreable events at all. */
export function pickShortMoment(match: MatchInfo, opts: ShortMomentOptions): ShortMoment | null {
  return rankShortMoments(match, opts)[0] ?? null;
}
