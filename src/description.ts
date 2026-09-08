import type { VodWindow } from "./vodAcquisition.js";
import { type ChapterMarker, formatChapters } from "./chapters.js";
import { eloAtMatchStart } from "./overlayProps.js";
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
}

/**
 * The only 150-200 characters most viewers ever read, since that's all YouTube shows before
 * "Show more". Both nicknames go first because they are the search terms in this niche, and
 * "MCSR Ranked 1v1" lands before character 50 so it survives the mobile truncation.
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

  const head = `${left} vs ${right} — MCSR Ranked 1v1, ${leftElo} vs ${rightElo} elo.`;
  // Doubles as the "what does this channel add" line a YPP reviewer looks for.
  const body = "Full same-seed race, synced dual-POV with live split comparison.";

  // Runners search by seed type — the closest competitor puts it in every title. It goes after
  // the body so the nicknames and "MCSR Ranked 1v1" keep the front of the Show-more preview.
  const seed = [seedPhrase(match), bastionPhrase(match)].filter(Boolean).join(", ");
  return seed ? `${head} ${body} ${seed[0].toUpperCase()}${seed.slice(1)}.` : `${head} ${body}`;
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
    "Chapters:",
    formatChapters(chapters),
    "",
    // First in the links block, above the two that leave for Twitch: a playlist link is the one
    // thing in a description that turns one view into a session, and sessions are watch hours.
    ...(input.playlistUrl ? [`Every match on the channel: ${input.playlistUrl}`] : []),
    `Watch ${userLeft.nickname}'s POV: ${vodDeepLink(leftWindow)}`,
    `Watch ${userRight.nickname}'s POV: ${vodDeepLink(rightWindow)}`,
    `Match data: https://mcsrranked.com/matches/${matchId}`,
    "",
    // Below the links and above the disclaimer: the one line that can earn before the
    // Partner Programme does, and where the competitor puts its PayPal.me.
    ...(input.supportUrl ? [`Support the channel: ${input.supportUrl}`, ""] : []),
    "MCSR Replayoffs is an independent fan project, not affiliated with MCSR Ranked.",
    "Spot a sync issue or a stat error? Flag it — this pipeline is actively maintained, not fire-and-forget automation.",
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
