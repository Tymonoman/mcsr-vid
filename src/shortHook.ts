import path from "node:path";
import { readFile } from "node:fs/promises";
import { HASHTAGS } from "./description.js";
import { buildHookSuggestions } from "./hooks.js";
import { computeMetrics } from "./matchScore.js";
import type { ShortMoment } from "./shortMoment.js";
import { readManifest } from "./thumbnailVariants.js";
import { buildTitle, HOOK_PLACEHOLDER, SEPARATOR } from "./title.js";
import type { MatchInfo, UserDetails } from "./types.js";

/** YouTube's hard cap on a title, and the tags that ride along on every Short. */
const TITLE_MAX_CHARS = 100;
const SHORT_TAGS = " #minecraft #mcsr";

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

/**
 * The hook a render of this moment would burn in, wiring and all.
 *
 * Exists so the dashboard can show the same line the CLI will use rather than the per-moment
 * fallback: the resolution above is pure, and the inputs it resolves *between* — the operator's
 * edited title file and the ranked hook suggestions — were assembled inline in the CLI, where
 * nothing else could reach them. `versus` is left out here exactly as it is there: the rematch
 * chip costs one more API call and neither a render nor a panel load is the place to spend it.
 *
 * Users come from the caller because both callers already have them (the CLI needs the ratings
 * for the board, the route fetches them once for the panel).
 */
export async function resolveShortHookFor(input: {
  matchId: number;
  match: MatchInfo;
  moment: ShortMoment;
  userLeft: UserDetails;
  userRight: UserDetails;
  /** The match's working directory, where the pipeline writes the title files. */
  matchDir: string;
}): Promise<string> {
  const { matchId, match, moment, userLeft, userRight, matchDir } = input;
  // Sized against the *title* budget on purpose: when the operator has written a title hook this
  // is literally that line, so the two must be the same length of thing.
  const budget = buildTitle({ leftNickname: userLeft.nickname, rightNickname: userRight.nickname });
  const editedTitle = await readFile(path.join(matchDir, `match-${matchId}.title.edited.txt`), "utf8").catch(
    () => null,
  );
  // The thumbnail already committed to a hook when the pipeline ran, and rank chips read *live*
  // rank — measured on one match: thumbnail "#3 vs #17" at render time, Short "#3 vs #21" an hour
  // later. A viewer sees both halves of a match; they must not disagree. So an operator-picked
  // title still wins, but the thumbnail's line beats a fresh suggestion.
  const committed = (await readManifest(matchDir))?.hookText ?? null;
  return resolveShortHook(
    editedTitle,
    [
      ...(committed ? [committed] : []),
      ...buildHookSuggestions({
        metrics: computeMetrics(match),
        match,
        userLeft,
        userRight,
        maxChars: budget.hookMax,
        minChars: budget.hookMin,
      }),
    ],
    buildShortHook(moment, userLeft.nickname, userRight.nickname),
  );
}

/**
 * The Short's own title: the hook, verbatim, plus the two tags Shorts browse traffic rides.
 *
 * Not the long-form title. That one leads with both nicknames because search is where a 12-minute
 * VOD gets found; a Short is found by a thumb that has already stopped scrolling, so the hook is
 * the whole line and the nicknames are in the description where they still count for search.
 */
export function buildShortTitle(hook: string): string {
  const text = hook.trim();
  // A rank hook already carries hashes — "#7 vs #11" — and YouTube reads any `#token` in a title
  // as a hashtag, showing the first three above the video. Appending two more would make that
  // "#7 #11 #minecraft" and bury the one that matters. The description carries the real hashtags
  // on every Short, so a hash-bearing hook stands alone.
  if (text.includes("#")) return text.length <= TITLE_MAX_CHARS ? text : cutAtWord(text, TITLE_MAX_CHARS);
  const budget = TITLE_MAX_CHARS - SHORT_TAGS.length;
  if (text.length <= budget) return `${text}${SHORT_TAGS}`;
  // Cut at a word boundary: a title truncated mid-word reads as a broken pipeline, and YouTube
  // truncates the tail again in the feed anyway.
  return `${cutAtWord(text, budget)}${SHORT_TAGS}`;
}

function cutAtWord(text: string, max: number): string {
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * The Short's description. Three lines, because nobody expands a Short's description: the names
 * and the format label for search, the match page for anyone who wants the numbers, and the same
 * hashtags the long-form upload carries so both halves of a match are one channel to YouTube.
 */
export function buildShortDescription(
  matchId: number,
  leftNickname: string,
  rightNickname: string,
  playlistUrl = "",
): string {
  return [
    `${leftNickname} vs ${rightNickname} — MCSR Ranked 1v1. Full synced dual-POV race on the channel.`,
    ...(playlistUrl ? [`Every match: ${playlistUrl}`] : []),
    `Match data: https://mcsrranked.com/matches/${matchId}`,
    HASHTAGS.join(" "),
  ].join("\n");
}
