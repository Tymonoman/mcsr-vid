import type { MatchInfo } from "../api/types.js";
import { MILESTONES } from "../shorts/raceGap.js";

/**
 * "Explain the moves": one plain line in the meta column the first time either player reaches
 * each split, so a Minecraft player who has never followed speedrunning (about three quarters of
 * the views, 24 Sept 2026) sees why the runner goes where they go. It is also the channel's
 * answer to YPP's reused-content review, whose allowed example is a sports replay "where you
 * explain the moves".
 *
 * A line explains the move and never who is ahead: the same line whoever gets there first, and
 * nothing here reads `match.result`.
 */
export interface Move {
  /** The first arrival of either player, ms from match start. */
  atMs: number;
  /** The split, in the card's gold head. */
  head: string;
  /** Why the runner is there: rows split on "\n", as the card prints them. */
  line: string;
}

/**
 * The card breaks its rows where the "\n"s are, so the break falls between phrases rather than
 * wherever the width runs out. 26 characters of the 16 px line is the meta column's 308 px of
 * text; three rows is what fits under the head and above the band's bottom edge.
 */
export const MOVE_ROW_MAX_CHARS = 26;
export const MOVE_MAX_ROWS = 3;

/**
 * Keyed by the timeline event `MILESTONES` climbs on. Run past no-ai-slop, then corrected by the
 * operator (24 Sept 2026): the Nether is for rods, pearls and explosives; a blaze's rod is a coin
 * flip; the stronghold is preemptive navigation; the End is the dragon and the explosives.
 */
export const MOVE_LINES: Record<string, { head: string; line: string }> = {
  "story.enter_the_nether": { head: "NETHER", line: "FOR BLAZE RODS, ENDER\nPEARLS AND EXPLOSIVES" },
  "nether.find_bastion": { head: "BASTION", line: "TRADING GOLD TO PIGLINS\nFOR ENDER PEARLS" },
  "nether.find_fortress": {
    head: "FORTRESS",
    line: "BLAZES SPAWN ONLY HERE.\nEACH DROPS A ROD 50%\nOF THE TIME",
  },
  "projectelo.timeline.blind_travel": {
    head: "BLIND TRAVEL",
    // The blind portal is built for the ring strongholds generate in, not at one: the eyes find it.
    // The operator's pick of four rewrites (24 Sept 2026).
    line: "OUT OF THE NETHER,\nROUGHLY WHERE THE\nSTRONGHOLD SHOULD BE",
  },
  "story.follow_ender_eye": {
    head: "STRONGHOLD",
    line: "PREEMPTIVE NAVIGATION\nTO FIND THE PORTAL ROOM",
  },
  "story.enter_the_end": { head: "THE END", line: "KILLING THE DRAGON\nWITH EXPLOSIVES" },
};

/** Each split either player of the match reached, at its first arrival, in race order. */
export function chooseMoves(match: MatchInfo): Move[] {
  const seated = new Set(match.players.map((p) => p.uuid));
  return MILESTONES.flatMap(({ type }) => {
    const times = match.timelines.filter((e) => e.type === type && seated.has(e.uuid)).map((e) => e.time);
    return times.length > 0 ? [{ atMs: Math.min(...times), ...MOVE_LINES[type]! }] : [];
  }).sort((a, b) => a.atMs - b.atMs);
}
