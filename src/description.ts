import type { VodWindow } from "./vodAcquisition.js";
import { type ChapterMarker, formatChapters } from "./chapters.js";
import { eloAtMatchStart } from "./overlayProps.js";
import { playoffLabel, playoffParagraph, type PlayoffContext } from "./playoffs.js";
import type { MatchInfo, UserDetails } from "./types.js";

// Three: over 15 YouTube voids all of them, and only the first three render above the title, so
// all of these are visible. No per-player tag — a nickname hashtag has no search volume of its
// own and would spend two of the three visible slots.
export const HASHTAGS = ["#MCSRRanked", "#MCSR", "#MinecraftSpeedrunning"];

/**
 * `DESERT_TEMPLE` -> "desert temple seed", `BRIDGE` -> "bridge bastion". An unknown enum value
 * degrades to its own lowercased words rather than throwing, so a seed type the API adds
 * tomorrow reads slightly odd instead of failing a render.
 */
function humanise(value: string, noun: string): string {
  return `${value.toLowerCase().replace(/_/g, " ")} ${noun}`;
}

function seedPhrase(match: MatchInfo): string | null {
  return match.seedType ? humanise(match.seedType, "seed") : null;
}

function bastionPhrase(match: MatchInfo): string | null {
  return match.bastionType ? humanise(match.bastionType, "bastion") : null;
}

/** Twitch's own deep-link format: `?t=<seconds>s` seeks the VOD player to that exact moment. */
function vodDeepLink(window: VodWindow): string {
  return `${window.sourceUrl}?t=${Math.max(0, Math.round(window.matchOffsetIntoVodSec))}s`;
}

export interface DescriptionInput {
  matchId: number;
  match: MatchInfo;
  userLeft: UserDetails;
  userRight: UserDetails;
  leftWindow: VodWindow;
  rightWindow: VodWindow;
  chapters: ChapterMarker[];
  /** `config.youtubePlaylistUrl`; empty or absent means no playlist line. */
  playlistUrl?: string;
  /** `config.supportUrl`; empty or absent means no tip-jar line. */
  supportUrl?: string;
  /** `playoffContextFor(match)`: the round and game replace "1v1" and earn a paragraph. */
  playoff?: PlayoffContext | null;
}

/**
 * The only 150-200 characters most viewers ever read, since that's all YouTube shows before
 * "Show more". Both nicknames go first because they are the search terms in this niche, and
 * "MCSR Ranked 1v1" lands before character 50 so it survives the mobile truncation (a playoff
 * opening is longer and does not; the round and game number are worth the cut).
 *
 * Written the way a person would type it: what the video is, in short sentences, and nothing
 * about how it was made. A viewer called the old copy out for reading like a machine wrote it.
 *
 * No result, ever: the description is read before the match is watched, and the ending is the
 * reason to watch it. Who won stays on the timer.
 */
function buildOpening(input: DescriptionInput): string {
  const { match, userLeft, userRight } = input;
  const left = userLeft.nickname;
  const right = userRight.nickname;

  // Match-time elo, not live elo: the live rating is the one now, not the one carried in.
  const leftElo = eloAtMatchStart(match, userLeft.uuid, userLeft.eloRate);
  const rightElo = eloAtMatchStart(match, userRight.uuid, userRight.eloRate);

  const format = input.playoff
    ? `MCSR Ranked S${input.playoff.season} Playoffs, ${playoffLabel(input.playoff)}`
    : "MCSR Ranked 1v1 on the same seed";
  const head = `${left} vs ${right}, ${format}. Both streams side by side, split timer between them. ${leftElo} vs ${rightElo} elo going in.`;

  // Runners search by seed type — the closest competitor puts it in every title. It goes last
  // so the nicknames and the format keep the front of the Show-more preview.
  const seed = [seedPhrase(match), bastionPhrase(match)].filter(Boolean).join(", ");
  return seed ? `${head} ${seed[0].toUpperCase()}${seed.slice(1)}.` : head;
}

/**
 * Builds the complete video description — paste it as-is, edit nothing.
 *
 * The keyword-rich opening is generated too, because a hand-written one was never used and the
 * "Show more" preview would otherwise open on two raw Twitch URLs, carrying zero keywords.
 */
export function buildDescription(input: DescriptionInput): string {
  const { matchId, userLeft, userRight, leftWindow, rightWindow, chapters } = input;

  return [
    buildOpening(input),
    "",
    // The series context a playoff viewer arrives with: which round, which game, which seeds.
    // Never the series score — that is as much of a spoiler as the result is.
    ...(input.playoff ? [playoffParagraph(input.playoff), ""] : []),
    // No "Chapters:" heading: YouTube reads the 0:00 list on its own, and the heading was one
    // more line between the preview and the links.
    formatChapters(chapters),
    "",
    `${userLeft.nickname}'s stream: ${vodDeepLink(leftWindow)}`,
    `${userRight.nickname}'s stream: ${vodDeepLink(rightWindow)}`,
    // The `/matches/<id>` segment is what pairs a Studio upload back to its match
    // (src/channelUploads.ts): keep the line however the label changes.
    `Match page: https://mcsrranked.com/matches/${matchId}`,
    // A playlist link is the one thing in a description that turns one view into a session.
    ...(input.playlistUrl ? [`All the matches: ${input.playlistUrl}`] : []),
    // The one line that can earn before the Partner Programme does.
    ...(input.supportUrl ? [`Tip jar: ${input.supportUrl}`] : []),
    "",
    "Fan project, not affiliated with MCSR Ranked. If the sync looks off anywhere, say so in the comments and I'll fix it.",
    "",
    HASHTAGS.join(" "),
  ].join("\n");
}

/** YouTube rejects any tag over 30 characters, silently dropping the rest of the list with it. */
const MAX_TAG_CHARS = 30;

/**
 * Tags for the upload. Nicknames first — they are the search terms in this niche — then the
 * format keywords, then the seed, and the broadest term last, because YouTube weights order.
 *
 * `maxTotalChars` is a parameter only so the length guard is reachable from a test; nothing
 * calls it with anything but the default. YouTube's real ceiling is 500.
 */
export function buildTags(
  match: MatchInfo,
  userLeft: UserDetails,
  userRight: UserDetails,
  maxTotalChars = 450,
): string[] {
  const wanted = [
    userLeft.nickname,
    userRight.nickname,
    "mcsr ranked",
    "mcsr",
    "minecraft speedrun",
    "minecraft speedrunning",
    "ranked 1v1",
    "speedrun race",
    seedPhrase(match),
    bastionPhrase(match),
    "minecraft",
  ];

  const tags: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const tag of wanted) {
    if (!tag || tag.length > MAX_TAG_CHARS) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    // The comma YouTube joins them with counts against the limit too.
    const next = total + tag.length + (tags.length ? 1 : 0);
    if (next > maxTotalChars) break;
    seen.add(key);
    tags.push(tag);
    total = next;
  }
  return tags;
}
