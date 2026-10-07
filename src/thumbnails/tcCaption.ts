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
import { buildHookSuggestions, hookLabelProblem, spoilsTheResult, type HookInput } from "../pipeline/hooks.js";
import { hookProblem } from "../shorts/videoPick.js";

/** The caption's own hard cap — well under a nameplate's 56px budget at 14 uppercase characters. */
export const CAPTION_MAX_CHARS = 14;

/**
 * Compresses one `hooks.ts` chip to the caption's shape, or null when the text does not match a
 * known template (a future hooks.ts addition, or a carried/typed hook this module was never meant
 * to take). Every branch here is a literal `candidates()` template in `src/pipeline/hooks.ts` —
 * add one there, add its shortening here.
 */
export function shortenHookChip(hook: string): string | null {
  const h = hook.trim();
  let m: RegExpMatchArray | null;

  if ((m = h.match(/^Decided by (\d+) milliseconds$/i))) return `${m[1]} MS`;
  if ((m = h.match(/^Decided by (\d+(?:\.\d)?) seconds?$/i))) return `${m[1]}S DECIDED`;
  if ((m = h.match(/^A sub-(\d+) to win it$/i))) return `SUB-${m[1]}`;
  if (/^Does the lead ever settle\?$/i.test(h)) return "LEAD SETTLE?";
  if ((m = h.match(/^Can a (\d+):(\d+) lead survive\?$/i))) return `${m[1]}:${m[2]} LEAD?`;
  if ((m = h.match(/^Can a (\d+)-second lead survive\?$/i))) return `${m[1]}S LEAD?`;
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
export function pickCaption(input: HookInput, players: readonly { nickname: string }[]): CaptionResult | null {
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
