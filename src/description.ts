import type { VodWindow } from "./vodAcquisition.js";
import { type ChapterMarker, formatChapters } from "./chapters.js";
import { eloAtMatchStart } from "./overlayProps.js";
import { formatShortTime } from "../remotion/format.js";
import type { MatchInfo, UserDetails } from "./types.js";

// Three, not the ten this used to emit. Over 15 YouTube voids all of them, 3-5 is the optimum,
// and only the first three render above the title — which here means all of them are visible.
// Per-player tags are gone deliberately: a nickname hashtag has no search volume of its own and
// spent two of the three visible slots.
const HASHTAGS = ["#MCSRRanked", "#MCSR", "#MinecraftSpeedrunning"];

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
}

/**
 * The only 150-200 characters most viewers ever read, since that's all YouTube shows before
 * "Show more". Both nicknames go first because they are the search terms in this niche, and
 * "MCSR Ranked 1v1" lands before character 50 so it survives the mobile truncation.
 *
 * The result clause is dropped entirely when the match has no winner recorded.
 */
function buildOpening(input: DescriptionInput): string {
  const { match, userLeft, userRight } = input;
  const left = userLeft.nickname;
  const right = userRight.nickname;

  // Match-time elo, not live elo. Reading the rating at render time is what turned a real
  // 106-point gap into a displayed 245-point one on the edcr vs doogile upload.
  const leftElo = eloAtMatchStart(match, userLeft.uuid, userLeft.eloRate);
  const rightElo = eloAtMatchStart(match, userRight.uuid, userRight.eloRate);

  const head = `${left} vs ${right} — MCSR Ranked 1v1, ${leftElo} vs ${rightElo} elo.`;
  // Doubles as the "what does this channel add" line a YPP reviewer looks for: the description
  // used to say only what the channel isn't ("not affiliated"), never what it contributes.
  const body = "Full same-seed race, synced dual-POV with live split comparison.";

  const winner = match.result.uuid;
  if (!winner) return `${head} ${body}`;

  const winnerName = winner === userLeft.uuid ? left : right;
  const outcome = match.forfeited
    ? `${winnerName} wins by forfeit`
    : `${winnerName} ${formatShortTime(match.result.time)}`;
  return `${head} ${body} Result: ${outcome}.`;
}

/**
 * Builds the complete video description — paste it as-is, edit nothing.
 *
 * This used to generate only the lower half, with the keyword-rich opening left to a hand-written
 * template in branding/YOUTUBE_STUDIO_SETUP.md. That template was never once used: all five live
 * uploads open with two raw Twitch URLs, which is the entire "Show more" preview and carries zero
 * keywords. Generating the whole thing removes the manual step instead of documenting it harder.
 */
export function buildDescription(input: DescriptionInput): string {
  const { matchId, userLeft, userRight, leftWindow, rightWindow, chapters } = input;

  return [
    buildOpening(input),
    "",
    "Chapters:",
    formatChapters(chapters),
    "",
    `Watch ${userLeft.nickname}'s POV: ${vodDeepLink(leftWindow)}`,
    `Watch ${userRight.nickname}'s POV: ${vodDeepLink(rightWindow)}`,
    `Match data: https://mcsrranked.com/matches/${matchId}`,
    "",
    "MCSR Replayoffs is an independent fan project, not affiliated with MCSR Ranked.",
    "Spot a sync issue or a stat error? Flag it — this pipeline is actively maintained, not fire-and-forget automation.",
    "",
    HASHTAGS.join(" "),
  ].join("\n");
}
