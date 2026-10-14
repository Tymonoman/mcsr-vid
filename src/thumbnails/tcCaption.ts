/**
 * The Test & Compare caption: a short on-image fact for the thumbnail's `caption` prop
 * (remotion/types.ts, `.thumb-caption` in overlay.source.css). `npm run tc-thumbs` is the only
 * caller — the normal render path never sets this prop.
 *
 * The caption is always derived from `hooks.ts`'s own candidate list (`buildHookSuggestions`),
 * never from a hand-typed or carried hook: those are prose ("THE DUALITY OF MAN") that does not
 * compress losslessly to 14 characters, while every `hooks.ts` candidate is already one of a
 * handful of fixed, factual templates (see `candidates()`) that `shortenHookChip` below knows how
 * to compress exactly. `hooks.ts`'s own weight order picks the best fact for the match; this
 * module only shortens whichever one comes out on top (trying the next if a template is somehow
 * unrecognised or the shortened text would run over the limit).
 */
import {
  buildHookSuggestions,
  hookLabelProblem,
  spoilsTheResult,
  type HookInput,
} from "../pipeline/hooks.js";
import { hookProblem } from "../shorts/videoPick.js";

/**
 * The caption's own hard cap. Tightened from 14 to 9 on 8 Oct 2026 (chip-truth): the caption now
 * renders bigger (`.thumb-caption`, `remotion/overlay.source.css`, 56px to 76px) so it is actually
 * readable at YouTube's 168x94 thumbnail size, and a bigger glyph needs more room per character —
 * verified by rendering stills and reading the PNGs at that size. 9 is the longest of the task's
 * own approved tokens ("1:36 LEAD"); everything shorter ("58 MS", "SUB-9") clears it with room to
 * spare, and a template whose output would run longer (the rematch chip, the dragon-kill one) is
 * simply skipped by `pickCaption` rather than crammed down further.
 */
export const CAPTION_MAX_CHARS = 9;

/**
 * Compresses one `hooks.ts` chip to the caption's shape, or null when the text does not match a
 * known template (a future hooks.ts addition, or a carried/typed hook this module was never meant
 * to take) — null also for a template with no clean short form (8 Oct 2026 chip-truth): a caption
 * is a clean token or nothing, never a broken-English squeeze. Every branch here is a literal
 * `candidates()` template in `src/pipeline/hooks.ts` — add one there, add its shortening here.
 */
export function shortenHookChip(hook: string): string | null {
  const h = hook.trim();
  let m: RegExpMatchArray | null;

  if ((m = h.match(/^Decided by (\d+) milliseconds?$/i))) return `${m[1]} MS`;
  // A decimal margin ("Decided by 1.3 seconds") has no clean token at this budget: "1.3 SEC" is
  // ten characters, and gluing the unit onto the digit ("1.3S") is exactly the misread this fix
  // exists to stop (Monocraft's S reads as a 5 right after a digit) — dropped, not abbreviated.
  // A whole number of seconds keeps a space before its unit, so there is nothing to misread.
  if ((m = h.match(/^Decided by (\d+) seconds?$/i))) return `${m[1]} SEC`;
  if ((m = h.match(/^A sub-(\d+) to win it$/i))) return `SUB-${m[1]}`;
  // "Does the lead ever settle?" has no short form that still reads as English ("LEAD SETTLE?"
  // was backwards grammar) and no number to turn into a token, so it is dropped outright.
  if ((m = h.match(/^Can a (\d+):(\d+) lead survive\?$/i))) return `${m[1]}:${m[2]} LEAD`;
  // Same fix as the margin above: no "S" glued onto the digit, and no "?" either. Written M:SS
  // like the minute form ("0:48 LEAD"): a bare "38 LEAD" left the viewer asking 38 of what.
  if ((m = h.match(/^Can a (\d+)-second lead survive\?$/i))) return `0:${m[1].padStart(2, "0")} LEAD`;
  if ((m = h.match(/^(\d+) deaths and still this close$/i))) return `${m[1]} DEATHS`;
  if (/^Not a single death between them$/i.test(h)) return "0 DEATHS";
  if ((m = h.match(/^Rematch: .+ leads (\d+)-(\d+)$/i))) return `${m[1]}-${m[2]} REMATCH`;
  if ((m = h.match(/^Rematch: (\d+)-(\d+) all time$/i))) return `${m[1]}-${m[2]} REMATCH`;
  if (/^Their first 1v1$/i.test(h)) return "FIRST 1V1";
  if (/^It ended in a forfeit$/i.test(h)) return "A FORFEIT";
  if (/^One of them never killed the dragon$/i.test(h)) return "NO DRAGON KILL";
  return null;
}

export interface CaptionResult {
  caption: string;
  /** The hooks.ts chip it was shortened from, for the CLI's own output. */
  source: string;
  /** hookProblem's reason, hookLabelProblem's reason, and spoilsTheResult — all must clear. */
  checks: { hookProblem: string | null; hookLabelProblem: string | null; spoilsTheResult: boolean };
}

/**
 * The caption for one match: the highest-weighted `hooks.ts` candidate that both shortens to a
 * known template and passes every check a hook has to clear — `hookProblem` already covers
 * `spoilsTheResult`, `HOOK_SEED_RANK_ELO` and `hookLabelProblem`, so the three are also reported
 * individually (the task's own checklist) even though `hookProblem === null` implies all three.
 * Null only when nothing in the candidate list shortens and passes, which no real match has hit.
 */
export function pickCaption(
  input: HookInput,
  players: readonly { nickname: string }[],
): CaptionResult | null {
  for (const chip of buildHookSuggestions(input, 8)) {
    const short = shortenHookChip(chip);
    if (!short || short.length > CAPTION_MAX_CHARS) continue;
    const checks = {
      hookProblem: hookProblem(short, CAPTION_MAX_CHARS, players),
      hookLabelProblem: hookLabelProblem(short, players),
      spoilsTheResult: spoilsTheResult(short),
    };
    if (checks.hookProblem === null) return { caption: short, source: chip, checks };
  }
  return null;
}
