import type { MatchInfo } from "../api/types.js";
import { MILESTONES, arrivals } from "../shorts/raceGap.js";

/**
 * The first line of a match's pinned comment: one question a viewer can answer without knowing
 * the result (30 Sept 2026: the description and the cards already carry the subscribe ask, so the
 * comment asks for a reply instead of repeating it).
 *
 * It is built from the race facts the Short's captions use (`arrivals`, src/shorts/raceGap.ts),
 * from `match.timelines` alone. Nothing here reads `match.result`, so it cannot name a winner, and
 * it says nobody is ahead either: only the two players, in the order the video shows them, and
 * where the race was closest.
 *
 * "who would you have backed at the fortress, edcr or doogile?" asks about the rung, from the
 * bastion to the stronghold, where the two reached it closest together (the later one on a tie).
 * The nether and the end are left out: `behind` ("INTO THE END") does not read after "backed",
 * and the end is where the game is decided. A race with no such rung gets the plain prediction.
 * A joined series holds every game, so one game's rung would be wrong for it: it is asked about
 * as a series.
 */
export function pinnedQuestion(match: MatchInfo, series = false): string | null {
  const [left, right] = match.players;
  if (!left || !right) return null;
  const pair = `${left.nickname} or ${right.nickname}`;
  if (series) return `who do you have taking the series, ${pair}?`;

  const reached = arrivals(match);
  let closest: { gapMs: number; rung: number } | null = null;
  for (let rung = 1; rung < MILESTONES.length - 1; rung++) {
    const { left: l, right: r } = reached[rung]!;
    if (l === undefined || r === undefined) continue;
    const gapMs = Math.abs(l - r);
    if (!closest || gapMs <= closest.gapMs) closest = { gapMs, rung };
  }
  return closest
    ? `who would you have backed ${MILESTONES[closest.rung]!.behind.toLowerCase()}, ${pair}?`
    : `who do you have winning this one, ${pair}?`;
}
