import type { MatchInfo } from "../api/types.js";
import { config, type Config } from "../config.js";
import { MILESTONES, arrivals, decidedAtMs } from "../shorts/raceGap.js";
import { formatShortTime } from "../../remotion/format.js";
import { chooseBannerMoves } from "./explainMoves.js";
import { chooseTeaser } from "./teaser.js";

/**
 * The retention opening's big lines over the finished frame (proposal approved 19 Oct 2026):
 * transparent full-frame stills (`remotion/Banner.tsx`) that `export:fast` lays over the output
 * for [fromMs, toMs) of the race clock — negative is the intro card and the countdown.
 *
 * None of them names a player or reads `match.result`: the stakes line is the format, COMING UP
 * and the explain lines are the teaser's and the moves' own words, and a gap chip says how far
 * apart, never who is ahead — and never in the last minute before the game is decided.
 */
export type BannerKind = "stakes" | "comingUp" | "explain" | "gap" | "title";

export interface Banner {
  kind: BannerKind;
  /** The gold line; "" for a chip or a title, which have one line. */
  head: string;
  /** The rows under it ("\n" breaks a row), or the chip's or title's one line. */
  text: string;
  fromMs: number;
  toMs: number;
}

export const STAKES = { head: "SAME SEED. SAME WORLD.", text: "FIRST TO KILL THE DRAGON WINS" };
/** From the video's first frame: the race clock reads at most this far back at frame 0. */
const BEFORE_START_MS = -60_000;
const GAP_CHIP_MS = 4000;
/** No chip in the last minute before the game is decided: that is the finish, not the race. */
export const GAP_CHIP_BEFORE_DECIDED_MS = 60_000;

/** "FORTRESS: 2.9s APART" at the second arrival of each split, both players' first arrivals. */
export function gapChips(match: MatchInfo): Banner[] {
  const decided = decidedAtMs(match);
  if (decided === null) return [];
  return arrivals(match).flatMap((a, i) => {
    if (a.left === undefined || a.right === undefined) return [];
    const second = Math.max(a.left, a.right);
    if (second + GAP_CHIP_MS > decided - GAP_CHIP_BEFORE_DECIDED_MS) return [];
    const gap = (Math.abs(a.left - a.right) / 1000).toFixed(1);
    const text = `${MILESTONES[i]!.label.toUpperCase()}: ${gap}s APART`;
    return [{ kind: "gap" as const, head: "", text, fromMs: second, toMs: second + GAP_CHIP_MS }];
  });
}

type BannerConfig = Pick<
  Config,
  "stakesLine" | "explainMovesStyle" | "explainMovesSec" | "teaserAtSec" | "teaserSec" | "gapChips"
>;

/** Every banner the settings ask for, in time order; none while every switch is off. */
export function bannersFor(match: MatchInfo, cfg: BannerConfig = config): Banner[] {
  const out: Banner[] = [];
  if (cfg.stakesLine) out.push({ kind: "stakes", ...STAKES, fromMs: BEFORE_START_MS, toMs: 0 });
  if (cfg.explainMovesStyle === "banner") {
    const teaser = cfg.teaserAtSec === null ? null : chooseTeaser(match);
    const from = (cfg.teaserAtSec ?? 0) * 1000;
    const to = from + cfg.teaserSec * 1000;
    // Gone before the moment it promises, as the panel's card is.
    if (teaser && to <= teaser.momentMs)
      out.push({
        kind: "comingUp",
        head: `COMING UP AT ${formatShortTime(teaser.momentMs)}`,
        text: teaser.text,
        fromMs: from,
        toMs: to,
      });
    if (cfg.explainMovesSec !== null) {
      const len = cfg.explainMovesSec * 1000;
      const runEnd = match.result.time > 0 ? match.result.time : Infinity;
      // One at a time: a banner waits for the one before it; one that would reach the finish is dropped.
      let free = -Infinity;
      for (const move of chooseBannerMoves(match)) {
        const fromMs = Math.max(move.atMs, free);
        if (fromMs + len > runEnd) continue;
        out.push({ kind: "explain", head: move.head, text: move.line, fromMs, toMs: fromMs + len });
        free = fromMs + len;
      }
    }
  }
  if (cfg.gapChips) out.push(...gapChips(match));
  return out.sort((a, b) => a.fromMs - b.fromMs);
}
