import type { MatchInfo, TimelineEntry } from "./types.js";

/**
 * Picks the ~22 seconds of a match worth cutting into a Short.
 *
 * Everything here comes from `match.timelines` — the same event list the splits and the chaos
 * score are built from — so choosing a moment costs no video decoding at all. That matters: a
 * scene-change pass over one 11-minute POV measured ~3.5 minutes of all four cores, and it
 * would only rediscover the events the API already handed us with timestamps attached.
 *
 * The scoring is deliberately shaped for Shorts rather than reused from `matchScore`, which
 * ranks whole matches. A Short is not a match in miniature: it needs something in the first two
 * seconds or the viewer scrolls, and it needs its payoff past the middle rather than at the start.
 */

/**
 * Seconds of match footage a Short covers.
 *
 * 22, not the 30 this started at. Completion rate is a Shorts ranking input, and the reference
 * point is @MCSR-Vault's 42k-view Short: 21.3s long, payoff at t=9s, ~12s of reaction, no outro.
 * A shorter clip with the same payoff finishes more often, and nothing here needs 30 seconds —
 * the window is one event and the run-up to it. `--seconds` still overrides.
 */
export const SHORT_WINDOW_SEC = 22;
/** How far apart candidate windows are tried. */
const STRIDE_SEC = 1;
/** The opening that has to earn the scroll. */
const HOOK_SEC = 2;
/**
 * Where in the window the biggest moment should land, as a fraction. At the 22s window that
 * leaves ~13s of build and ~9s of reaction, which is the reference Short's shape: enough run-up
 * to see it coming, and the tail that carries the reaction without outstaying it.
 */
const PAYOFF_TARGET = 0.59;

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
  /**
   * When each Twitch chat message was posted, in seconds after match start, both chats merged
   * (`chat-<nick>.json`, src/twitchChat.ts). Optional: a match without saved chat scores as
   * before. Chat is the one record of where the *crowd* reacted, which the timeline cannot know.
   */
  chatAtSec?: readonly number[];
}

/** Chat reacts after the fact: the burst for a window is counted this long past its end. */
const CHAT_LAG_SEC = 8;
/** Fewer messages than this is one person typing, not a crowd — a quiet chat must not burst on it. */
const MIN_BURST_MESSAGES = 4;

/**
 * How much louder than the match's average chat is over a window, 0 at average and 1 at three
 * times it. Relative, so a stream with a thousand viewers and one with ten are scored the same
 * way; and a chat that never bursts scores every window 0, which changes nothing.
 */
export function chatBurst(
  chatAtSec: readonly number[],
  startMs: number,
  endMs: number,
  runMs: number,
): number {
  if (chatAtSec.length === 0 || runMs <= 0) return 0;
  const from = startMs / 1000;
  const to = endMs / 1000 + CHAT_LAG_SEC;
  const inWindow = chatAtSec.filter((t) => t >= from && t < to).length;
  if (inWindow < MIN_BURST_MESSAGES) return 0;
  const rate = inWindow / (to - from);
  const mean = chatAtSec.length / (runMs / 1000 + CHAT_LAG_SEC);
  return mean === 0 ? 0 : clamp01((rate / mean - 1) / 2);
}

/**
 * Scores every candidate window and returns them best-first.
 *
 * Scores are comparable within one match only, exactly like `Suggestion.score` — they say which
 * 22 seconds of *this* match to cut, not whether this match deserves a Short at all.
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

  // How far past the last scored event a window may run. Slightly more than the payoff target
  // leaves behind (1 - 0.59 = 0.41), so that the ideal window is still reachable when the payoff
  // *is* the last event — at exactly 0.4 the search stops one stride short of its own target.
  const lastEnd = Math.min(opts.runMs, scored[scored.length - 1]!.time + windowMs * 0.45);
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
    const burst = opts.chatAtSec ? chatBurst(opts.chatAtSec, startMs, endMs, opts.runMs) : 0;

    // Weights, not a formula to be clever about: payoff dominates, a lead flip is nearly as good
    // as a big single event, and the hook is a tiebreak that stops a window opening on dead air.
    // A chat burst is worth as much as the hook: the crowd's reaction breaks ties between
    // windows the timeline scores alike, and never outranks the event itself.
    const score =
      3 * clamp01(payoff) + 2.5 * leadFlip + 2 * simultaneity + 1.5 * hook + 1 * density + 1.5 * burst;

    const reasons = [
      `payoff ${best.type.split(".").pop()} at +${((best.time - startMs) / 1000).toFixed(0)}s`,
    ];
    if (leadFlip) reasons.push("lead change");
    if (simultaneity > 0.5) reasons.push("both players within seconds");
    if (hook > 0) reasons.push("opens on an event");
    if (burst >= 0.5) reasons.push("chat burst");
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
