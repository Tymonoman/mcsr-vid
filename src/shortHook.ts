import type { ShortMoment } from "./shortMoment.js";

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
