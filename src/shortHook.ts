import type { ShortMoment } from "./shortMoment.js";
import { HOOK_PLACEHOLDER, SEPARATOR } from "./title.js";

/**
 * The line that has to earn the scroll, written from what the window actually contains.
 *
 * Deliberately describes the moment rather than the match: a Short's viewer has no idea who
 * these players are, so "doogile takes the lead here" means nothing to them while "both blind
 * at the same time" is legible to anyone. The reference channels' best-performing Shorts do the
 * same — @MCSR-Vault's 42k-view Short is titled "when you mess up at the SAME TIME".
 */
export function buildShortHook(moment: ShortMoment, leftNickname: string, rightNickname: string): string {
  const types = new Set(moment.events.map((e) => e.type));
  const has = (t: string) => types.has(t);
  const died = has("projectelo.timeline.death_spawnpoint") || has("projectelo.timeline.death");

  if (moment.reason.includes("both players within seconds")) {
    if (died) return "both of them die at the same time";
    if (has("projectelo.timeline.blind_travel")) return "both blind at the same time";
    if (has("story.enter_the_end")) return "into the End together";
    return "the exact same moment, twice";
  }
  if (moment.reason.includes("lead change")) {
    if (died) return "one death changes the whole race";
    return "watch the lead flip here";
  }
  if (has("projectelo.timeline.dragon_death") || has("end.kill_dragon")) {
    return `${leftNickname} vs ${rightNickname}, decided`;
  }
  if (died) return "this is where it falls apart";
  if (has("projectelo.timeline.blind_travel")) return "the blind travel that decided it";
  return `${leftNickname} vs ${rightNickname}`;
}

/**
 * The line the Short actually burns in, in the order the evidence ranks the sources.
 *
 * The operator's own title hook wins, because it is the one line on the upload somebody has
 * already judged, and a Short and its long-form video sell the same match — they should not
 * disagree about why it is worth watching. Failing that, the ranked suggestions the title editor
 * offers: the channel audit measured rivalry-framed hooks at 9.36% CTR against 2.25% for
 * descriptive ones, and `buildHookSuggestions` sorts on exactly that, so its first entry beats
 * anything derived from the 30-second window alone. `buildShortHook` stays as the last resort,
 * for a match whose numbers yield no suggestion at all.
 *
 * Pure — the caller reads the title file — so this is testable and cannot stall a render on IO.
 */
export function resolveShortHook(
  editedTitle: string | null | undefined,
  suggestions: readonly string[],
  fallback: string,
): string {
  // Split before trimming: an operator who cleared the hook but left the separator leaves a
  // first line of " | a vs b | ...", and trimming first eats the leading space the separator
  // needs, which turns an empty hook into a hook of "| a vs b".
  const firstLine = editedTitle?.split("\n")[0] ?? "";
  // An untouched title still carries the literal placeholder: that is the empty box, not a hook.
  if (!firstLine.includes(HOOK_PLACEHOLDER)) {
    const hook = firstLine.split(SEPARATOR)[0]!.trim();
    if (hook !== "") return hook;
  }
  return suggestions.find((s) => s.trim() !== "")?.trim() ?? fallback;
}
