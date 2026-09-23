import path from "node:path";
import { readFile } from "node:fs/promises";
import { matchPageUrl } from "../api/mcsrApi.js";
import { HASHTAGS } from "../pipeline/description.js";
import type { ShortMoment } from "./shortMoment.js";
import { shortHookFile, type ShortPick } from "./shortPlan.js";
import { SEPARATOR, titleName } from "../pipeline/title.js";

/** What every path that would render a Short without its confirmed hook says instead. */
export const WAITING_FOR_HOOK = "waiting for the Short's hook";

/**
 * The operator-confirmed Short hook (`short-<id>.hook.txt`, written only by the dashboard's hooks
 * route), or null. The one source of the line a Short burns in: the chips, the thumbnail's hook
 * and the model's `hookSuggestion` are suggestions the operator confirms, never used by
 * themselves.
 */
export const readShortHook = (dir: string, matchId: number): Promise<string | null> =>
  readFile(shortHookFile(dir, matchId), "utf8").then(
    (text) => text.split("\n")[0]!.trim() || null,
    () => null,
  );

/** `short-<id>.cut.json`: the window a render cut and the hook it burned in. */
export interface ShortCut {
  gameMatchId: number;
  startMs: number;
  endMs: number;
  pov: ShortPick["pov"];
  focus?: ShortPick["focus"];
  hook: string;
  /** The pick this cut came from (`ShortPick.createdAt`): a newer pick is a reason to re-cut. */
  pickCreatedAt: string;
  /** The operator named the window (`--at` / `--seconds`) rather than taking the pick's. */
  override?: boolean;
  renderedAt: string;
}

/** The last cut's record, or null (none yet, or one from before 23 Sept 2026 that carries no hook). */
export const readShortCut = (dir: string, matchId: number): Promise<ShortCut | null> =>
  readFile(path.join(dir, `short-${matchId}.cut.json`), "utf8").then(
    (text) => {
      const cut = JSON.parse(text) as Partial<ShortCut>;
      return typeof cut.hook === "string" ? (cut as ShortCut) : null;
    },
    () => null,
  );

/**
 * The closing card (decision 13): a window that stops before the match is decided asks who took
 * it; one that shows the finish only points at the long-form. A series' Short points at the
 * series.
 */
export const endCardText = (endsBeforeDecided: boolean, series: boolean): string =>
  `${endsBeforeDecided ? "WHO TOOK IT? " : ""}FULL ${series ? "SERIES" : "MATCH"} ON THE CHANNEL`;

/** YouTube's hard cap on a title, and the tags that ride along on a Short whose title has room. */
export const TITLE_MAX_CHARS = 100;
const SHORT_TAGS = " #mcsr #minecraft";

/**
 * A line written from what the window contains — one of the Short hook's suggestions (the
 * operator confirms the hook; nothing burns this in by itself).
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
 * The Short's own title (the operator's call, 23 Sept 2026): the confirmed Short hook, both
 * players as the long-form title spells them (`titleName`: Pinne is Skycrab), then the two
 * hashtags Shorts browse rides — only while the whole stays within YouTube's 100. A title longer
 * than 100 without them is returned as it is: the hooks route refuses such a hook before it is
 * saved, and the render refuses what it cannot upload.
 */
export function buildShortTitle(hook: string, leftNickname: string, rightNickname: string): string {
  const base = `${hook.trim()}${SEPARATOR}${titleName(leftNickname)} vs ${titleName(rightNickname)}`;
  return base.length + SHORT_TAGS.length <= TITLE_MAX_CHARS ? `${base}${SHORT_TAGS}` : base;
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
  supportUrl = "",
  /** The long form's format half (`playoffTitleTail`), so a playoff Short is not sold as a 1v1. */
  format = "MCSR Ranked 1v1",
  season?: number,
  /** What the long form is: a playoff series' Short points at the whole series (src/playoffs/series.ts). */
  what: "match" | "series" = "match",
): string {
  return [
    `${leftNickname} vs ${rightNickname}, ${format.toLowerCase()}. the whole ${what} is on the channel with both streams side by side.`,
    ...(playlistUrl ? [`all the matches: ${playlistUrl}`] : []),
    `match page: ${matchPageUrl(matchId, leftNickname, season)}`,
    ...(supportUrl ? [`tip jar: ${supportUrl}`] : []),
    HASHTAGS.join(" "),
  ].join("\n");
}
