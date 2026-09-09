import { askReasoner } from "./reasoner.js";
import { leadChangeTimes, type ShortMoment } from "./shortMoment.js";
import type { MatchInfo } from "./types.js";

/**
 * The reasoner's second opinion on which candidate the Short cuts.
 *
 * `distinctShortMoments` ranks windows by weights that are informed guesses; a model reading
 * the same events — who did what, when, and where chat lit up — can tell a build-up from a
 * coincidence in a way a weight table cannot. It only ever chooses among the heuristic's
 * candidates and nudges the start by a few seconds, so the worst answer is one of the
 * candidates the panel was already offering. Anything it does not answer, or answers out of
 * bounds, leaves the heuristic order exactly as it was.
 *
 * It is never told who won: `match.result` stays out of the input, and the finish is visible
 * only as a `dragon_death` event like any other. Nothing it says is published — `why` is a
 * line on the operator's panel — so a hook is not asked for.
 */

/** The most the start may move, seconds. Enough to tidy an opening, not enough to find another moment. */
export const MAX_SHIFT_SEC = 4;
const CHAT_BUCKET_SEC = 2;

export const SHORT_REASON_TASK = `Two Minecraft speedrunners race the same seed side by side; a 22-second vertical Short is cut from one moment of the race. Below are the candidate windows a heuristic ranked (best first, index 0), the timeline events inside each (type, seconds into the run, which player), the times the lead changed hands, and, when chat was saved, how many chat messages arrived in each 2-second bucket of the window. Choose the window that makes the best Short: something happens in the first two seconds or the viewer scrolls, the biggest beat lands past the middle, and a moment both players share beats a solo one. You may move the start by at most ${MAX_SHIFT_SEC} seconds either way. Reply with {"pick": <candidate index>, "shiftSec": <-${MAX_SHIFT_SEC}..${MAX_SHIFT_SEC}>, "why": "<one short sentence for the operator>"}.`;

export interface ShortReasonOptions {
  leftUuid: string;
  rightUuid: string;
  runMs: number;
  chatAtSec?: readonly number[];
}

const sec = (ms: number) => Math.round(ms / 100) / 10;

/** Everything the reasoner is shown. Built separately so the CLI can print it and a test can check what is not in it. */
export function shortReasonInput(
  match: MatchInfo,
  moments: readonly ShortMoment[],
  opts: ShortReasonOptions,
) {
  const nick = new Map(match.players.map((p) => [p.uuid, p.nickname]));
  const chat = opts.chatAtSec ?? [];
  return {
    players: [nick.get(opts.leftUuid), nick.get(opts.rightUuid)],
    runSec: sec(opts.runMs),
    leadChangesAtSec: leadChangeTimes(match, opts.leftUuid, opts.rightUuid).map(sec),
    candidates: moments.map((m, index) => ({
      index,
      startSec: sec(m.startMs),
      endSec: sec(m.endMs),
      score: Number(m.score.toFixed(2)),
      reason: m.reason,
      events: m.events.map((e) => ({ type: e.type, atSec: sec(e.time), player: nick.get(e.uuid) })),
      ...(chat.length > 0
        ? {
            chatPer2s: Array.from(
              { length: Math.ceil((m.endMs - m.startMs) / 1000 / CHAT_BUCKET_SEC) },
              (_, i) => {
                const from = m.startMs / 1000 + i * CHAT_BUCKET_SEC;
                return chat.filter((t) => t >= from && t < from + CHAT_BUCKET_SEC).length;
              },
            ),
          }
        : {}),
    })),
  };
}

export interface ShortReasonResult {
  /** The candidates, the reasoner's choice first (shifted) when it gave a valid one. */
  moments: ShortMoment[];
  reasoner: { applied: boolean; why?: string };
}

/** The answer applied, or the input untouched when it is null or out of bounds. Pure, for the test. */
export function applyShortReason(
  moments: readonly ShortMoment[],
  answer: unknown,
  runMs: number,
): ShortReasonResult {
  const keep: ShortReasonResult = { moments: [...moments], reasoner: { applied: false } };
  if (typeof answer !== "object" || answer === null) return keep;
  const { pick, shiftSec, why } = answer as { pick?: unknown; shiftSec?: unknown; why?: unknown };
  const chosen = typeof pick === "number" && Number.isInteger(pick) ? moments[pick] : undefined;
  if (!chosen) return keep;
  const shift = typeof shiftSec === "number" && Number.isFinite(shiftSec) ? shiftSec : 0;
  if (Math.abs(shift) > MAX_SHIFT_SEC) return keep;
  const startMs = chosen.startMs + Math.round(shift * 1000);
  const endMs = chosen.endMs + Math.round(shift * 1000);
  if (startMs < 0 || endMs > runMs) return keep;
  // ponytail: events entering the shifted window are not re-scored — only the fallback hook
  // line reads them, and a 4 s shift rarely moves one; re-run the scorer if that ever matters.
  const moved: ShortMoment = {
    ...chosen,
    startMs,
    endMs,
    events: chosen.events.filter((e) => e.time >= startMs && e.time < endMs),
  };
  return {
    moments: [moved, ...moments.filter((m) => m !== chosen)],
    reasoner: { applied: true, ...(typeof why === "string" && why.trim() ? { why: why.trim() } : {}) },
  };
}

/** The whole exchange; `ask` is injected so the test never spawns a CLI. */
export async function reasonShortMoments(
  match: MatchInfo,
  moments: readonly ShortMoment[],
  opts: ShortReasonOptions,
  ask: typeof askReasoner = askReasoner,
): Promise<ShortReasonResult> {
  if (moments.length < 2) return { moments: [...moments], reasoner: { applied: false } };
  const answer = await ask(SHORT_REASON_TASK, shortReasonInput(match, moments, opts));
  return applyShortReason(moments, answer, opts.runMs);
}
