import type { VodWindow } from "./vodAcquisition.js";
import { matchPageUrl } from "../api/mcsrApi.js";
import { type ChapterMarker, filterChapterGap, formatChapters } from "./chapters.js";
import { eloAtMatchStart } from "./overlayProps.js";
import { playoffParagraph, playoffPhrase, seedOrdinal, type PlayoffContext } from "../playoffs/playoffs.js";
import type { MatchInfo, UserDetails } from "../api/types.js";

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

export function seedPhrase(match: MatchInfo): string | null {
  return match.seedType ? humanise(match.seedType, "seed") : null;
}

export function bastionPhrase(match: MatchInfo): string | null {
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
  /** `config.copyVariety`; absent/false is today's single phrasing. */
  copyVariety?: boolean;
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

  // Lowercase throughout, like the operator's own comments under the videos (18 Sept 2026:
  // "make it read like the comments I write myself"). Nicknames keep their own casing.
  const format = input.playoff
    ? playoffPhrase(input.playoff.season, input.playoff.round, input.playoff.gameNo)
    : "mcsr ranked 1v1 on the same seed";
  // "a minecraft speedrun race" is the category keyword inside the first 25 words: the 22 Sept
  // 2026 audit found it in none of fourteen descriptions.
  const head = `${left} vs ${right}, ${format}. a minecraft speedrun race, both streams side by side with the split timer in the middle. ${left} came in at ${leftElo} elo, ${right} at ${rightElo}.`;

  // Runners search by seed type — the closest competitor puts it in every title. It goes last
  // so the nicknames and the format keep the front of the Show-more preview.
  const seed = [seedPhrase(match), bastionPhrase(match)].filter(Boolean).join(", ");
  return seed ? `${head} ${seed}.` : head;
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
    subscribeLineFor(matchId, input.copyVariety),
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
    // (src/youtube/channelUploads.ts): keep the line however the label changes.
    `match page: ${matchPageUrl(matchId, userLeft.nickname, input.match.season)}`,
    // A playlist link is the one thing in a description that turns one view into a session.
    ...(input.playlistUrl ? [`all the matches: ${input.playlistUrl}`] : []),
    // The one line that can earn before the Partner Programme does.
    ...(input.supportUrl ? [`tip jar: ${input.supportUrl}`] : []),
    "",
    closerFor(matchId, input.copyVariety),
    "",
    HASHTAGS.join(" "),
  ].join("\n");
}

/**
 * The subscribe ask, one plain line in the operator's lowercase voice and with a reason: the 29 Sept
 * 2026 plan (item 4) found the description not asking at all. It is its own paragraph after the
 * opening one, on every video and every series, and `refreshDescription` adds it to a description
 * rendered before. The pinned comment does not repeat it (30 Sept 2026: that would be a third
 * copy beside the cards and this): it asks a question instead (`pinnedQuestion`).
 *
 * `SUBSCRIBE_LINE_VARIANTS[0]` and this constant are the same string: every caller that read
 * `SUBSCRIBE_LINE` before `copyVariety` existed keeps reading today's exact line.
 */
export const SUBSCRIBE_LINE_VARIANTS: readonly string[] = [
  "a new match every day. subscribe to catch the next one.",
  "a new match drops every day. subscribe to catch the next one.",
  "a new match every day. subscribe and youll catch the next one.",
  "one new match every day. subscribe to catch the next one.",
];
export const SUBSCRIBE_LINE = SUBSCRIBE_LINE_VARIANTS[0]!;

/**
 * A deterministic index into one `copyVariety` pool, mixed from the match id and a salt that is
 * fixed per pool (`SALT_CLOSER`/`SALT_SUBSCRIBE` here, a sync-sentence salt in youtubeStore.ts).
 * Plain `matchId % length` made the closer, the subscribe line and the pinned comment's sync
 * sentence move in lockstep — always the same one of only 4 fixed profiles, since all three pools
 * are keyed off the identical `matchId % 4` (review finding, 7 Oct 2026). The salt is mixed in
 * after the id is spread, then multiplied again: XOR-ing a small salt into the id first only
 * flipped its low bits, which left the pools 90% in step (15 Oct 2026). Now each pool's index is
 * independent of the others' — all 64 (closer, subscribe, sync) triples about equally likely.
 */
export function variantIndex(matchId: number, salt: number, length: number): number {
  let h = Math.imul(matchId >>> 0, 2654435761) >>> 0;
  h = Math.imul((h ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0, 0xc2b2ae35) >>> 0;
  // `^` converts both operands through ToInt32, so a value with the top bit set would come out
  // negative without this final `>>> 0`, and `% length` would stay negative too.
  h = (h ^ (h >>> 16)) >>> 0;
  return h % length;
}

const SALT_CLOSER = 0;
const SALT_SUBSCRIBE = 1;

/**
 * One of `SUBSCRIBE_LINE_VARIANTS`, by match id — the same one every time a given match is
 * rendered or re-uploaded. `copyVariety` off (the default, or no id to key off) is always index 0,
 * byte for byte what every description carried before this existed. Salted differently from
 * `closerFor` so the two lines of the same match don't always change together.
 */
export function subscribeLineFor(matchId: number | undefined, copyVariety: boolean | undefined): string {
  if (!copyVariety || matchId === undefined) return SUBSCRIBE_LINE_VARIANTS[0]!;
  return SUBSCRIBE_LINE_VARIANTS[variantIndex(matchId, SALT_SUBSCRIBE, SUBSCRIBE_LINE_VARIANTS.length)]!;
}

/**
 * "last time they met: <link>", one line with the other links when the pair has an earlier
 * long-form on the channel. The 30 Sept 2026 post-mortem: nothing in a description sent a viewer
 * onward, and Suggested viewers watch 4.1 minutes a view against Browse's 1.15. The earlier video
 * is only known at upload time, so `uploadTextFor` adds the line (`lastMeetingFor`), once: a
 * description that has it is returned as it is.
 */
export const LAST_MEETING = "last time they met: ";

export function withLastMeeting(description: string, videoId: string | null): string {
  if (!videoId || description.includes(LAST_MEETING)) return description;
  const line = `${LAST_MEETING}https://youtu.be/${videoId}`;
  // Before the playlist and tip-jar lines, else at the end of the links block. No template, no line.
  const links = description.search(/^(?:all the matches: |tip jar: )/m);
  if (links >= 0) return `${description.slice(0, links)}${line}\n${description.slice(links)}`;
  const closer = description.search(/\n\n(?:fan channel, |#MCSR)/);
  return closer < 0 ? description : `${description.slice(0, closer)}\n${line}${description.slice(closer)}`;
}

/**
 * The last line before the hashtags, on every video and every series. What the video is and
 * what is the channel's own work — the sync and the data layer — said plainly, so a reviewer
 * (or a viewer) does not read the channel as a compilation of other people's streams; the
 * monetisation audit of 22 Sept 2026 asked for the transformation to be legible.
 *
 * Byte-identical across 93% of descriptions for 7 weeks was the loudest "this is scripted" tell
 * the 6 Oct 2026 packaging audit found (`packaging.md` #4) — `CLOSER_VARIANTS` gives it 3 more
 * phrasings of the same three facts (unaffiliated fan channel, the sync/elo source, the invite to
 * report a sync slip), picked by match id when `copyVariety` is on. Every variant still starts
 * with "fan channel, " so `refreshDescription`'s drift patch keeps finding the line to replace.
 * `CLOSER_VARIANTS[0]` is this constant, unchanged: `copyVariety` off is byte for byte today's.
 */
export const CLOSER_VARIANTS: readonly string[] = [
  "fan channel, mcsr ranked has no idea i exist. both streams are synced to the frame off the countdown, the splits and elo come straight from the ranked api. if the sync looks off anywhere say where in the comments and ill fix it.",
  "fan channel, mcsr ranked has no idea i exist. the povs are synced to the frame off the countdown and the splits and elo come straight from the ranked api. drop a timestamp in the comments if the sync looks off anywhere and ill fix it.",
  "fan channel, mcsr ranked has no idea i exist. both povs are lined up to the frame on the countdown, the splits and elo are pulled right from the ranked api. if anything looks out of sync just say where in the comments and ill fix it.",
  "fan channel, mcsr ranked has no idea i exist. the two streams are synced to the frame off the countdown, splits and elo straight from the ranked api. say where in the comments if the sync looks off anywhere and ill fix it.",
];
export const CLOSER = CLOSER_VARIANTS[0]!;

/**
 * One of `CLOSER_VARIANTS`, by match id — the same one every time a given match is rendered or
 * re-uploaded. `copyVariety` off (the default, or no id to key off) is always index 0. Salted
 * differently from `subscribeLineFor` (see `variantIndex`) so the two paragraphs don't always
 * change together.
 */
export function closerFor(matchId: number | undefined, copyVariety: boolean | undefined): string {
  if (!copyVariety || matchId === undefined) return CLOSER_VARIANTS[0]!;
  return CLOSER_VARIANTS[variantIndex(matchId, SALT_CLOSER, CLOSER_VARIANTS.length)]!;
}

/** One game of a series, as its lines in the series description. */
export interface SeriesDescriptionGame {
  matchId: number;
  gameNo: number;
  /** Where the game starts in the joined video — its chapter. */
  startSec: number;
  /** `seedPhrase` of the game's world ("desert temple seed"), never the bracket seed; null when unknown. */
  seed?: string | null;
  pageUrl: string;
  /** Each player's stream, deep-linked to the game's start; absent when a VOD was never found. */
  streams: Array<{ nickname: string; url: string }>;
  /**
   * This game's own split/Result chapters (7 Oct 2026), already shifted to where they land in
   * the *joined* video (`buildChapters(splits, match, gameMatchStarts[i]).slice(1)` —
   * `src/playoffs/series.ts`; the slice drops `buildChapters`' own "Start" marker, which is
   * pinned to 0:00 of a single match and would be wrong here: the header line below is this
   * game's 0:00). Empty when the game has no split data.
   */
  chapters: ChapterMarker[];
}

export interface SeriesDescriptionInput {
  season: number;
  round: string;
  bestOf: number;
  /** In the video's seat order (game 1's), with the bracket's labels and frozen ratings. */
  left: { nickname: string; label: string; seasonEloRate: number };
  right: { nickname: string; label: string; seasonEloRate: number };
  games: SeriesDescriptionGame[];
  bracketUrl: string;
  playlistUrl?: string;
  supportUrl?: string;
  /** Game 1's id — the series' own id, for `copyVariety`'s phrasing pick. */
  matchId?: number;
  /** `config.copyVariety`; absent/false is today's single phrasing. */
  copyVariety?: boolean;
}

/** "as the 1st seed" / "from the lcq" — the label in a sentence. */
const seedClause = (label: string): string =>
  label.toUpperCase() === "LCQ" ? "from the lcq" : `as the ${seedOrdinal(label).toLowerCase()}`;

/**
 * The description of a whole series (src/playoffs/series.ts): every game of it in one video. The same
 * shape as a match's — opening, chapters, links, the closer — with a chapter per game and a
 * link line per game. Game 1's `/matches/<id>` link comes first because that segment is what
 * pairs a channel upload to its match (src/youtube/channelUploads.ts), and the series is game 1's
 * directory. No score anywhere: the chapter count already says how long it went, the dots on
 * the video say the rest as it happens.
 *
 * Each game's header ("game 2 · desert temple seed") is followed by that game's own
 * `g.chapters` (7 Oct 2026, the 7 Oct audit: "per-split chapters inside each game would give
 * Google more key moments") — the world's seed type, which the tags carry too, never the
 * bracket seed or a score. The whole merged list is re-filtered to YouTube's 10s minimum once
 * more (`filterChapterGap`), since a game's own chapter can land within that gap of its header
 * or of the next game's.
 */
export function buildSeriesDescription(input: SeriesDescriptionInput): string {
  const { left, right } = input;
  const format = `${playoffPhrase(input.season, input.round)}, best of ${input.bestOf}`;
  return [
    `${left.nickname} vs ${right.nickname}, ${format}. every game of the series, a minecraft speedrun race with both streams side by side and the split timer in the middle. ${left.nickname} came in ${seedClause(left.label)} at ${left.seasonEloRate} elo, ${right.nickname} ${seedClause(right.label)} at ${right.seasonEloRate}.`,
    "",
    subscribeLineFor(input.matchId, input.copyVariety),
    "",
    formatChapters(
      filterChapterGap(
        input.games.flatMap((g) => [
          { label: `game ${g.gameNo}${g.seed ? ` · ${g.seed}` : ""}`, timeSec: g.startSec },
          ...g.chapters,
        ]),
      ),
    ),
    "",
    ...input.games.map(
      (g) =>
        `game ${g.gameNo}: ${g.pageUrl}` +
        g.streams.map((s) => ` · ${s.nickname}'s stream ${s.url}`).join(""),
    ),
    `bracket: ${input.bracketUrl}`,
    "official broadcast: https://twitch.tv/mcsrranked · https://youtube.com/@MCSR_Ranked",
    ...(input.playlistUrl ? [`all the matches: ${input.playlistUrl}`] : []),
    ...(input.supportUrl ? [`tip jar: ${input.supportUrl}`] : []),
    "",
    closerFor(input.matchId, input.copyVariety),
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
  // The Twitch name where it differs from the nickname: the broadcast and the reaction channels
  // call Pinne "Skycrab" and lowk3y_ "Lowkey", and that is what a viewer types.
  const twitchName = (user: UserDetails): string | null => {
    const name = user.connections?.twitch?.name;
    return name && name.toLowerCase() !== user.nickname.toLowerCase() ? name : null;
  };
  const wanted = [
    userLeft.nickname,
    userRight.nickname,
    twitchName(userLeft),
    twitchName(userRight),
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
