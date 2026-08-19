import type { VodWindow } from "./vodAcquisition.js";
import { type ChapterMarker, formatChapters } from "./chapters.js";

const FORMAT_HASHTAGS = ["#MCSRRanked", "#MinecraftSpeedrun", "#Minecraft", "#Speedrunning"];
const CHECKPOINT_HASHTAGS = ["#Nether", "#Bastion", "#Fortress", "#End"];

function slugTag(nickname: string): string {
  return `#${nickname.replace(/[^a-zA-Z0-9]/g, "")}`;
}

/** Twitch's own deep-link format: `?t=<seconds>s` seeks the VOD player to that exact moment. */
function vodDeepLink(window: VodWindow): string {
  return `${window.sourceUrl}?t=${Math.max(0, Math.round(window.matchOffsetIntoVodSec))}s`;
}

export interface DescriptionExtrasInput {
  leftNickname: string;
  rightNickname: string;
  leftWindow: VodWindow;
  rightWindow: VodWindow;
  chapters: ChapterMarker[];
}

/**
 * Builds the auto-computable slice of a video description: watch links deep-linked to the exact
 * match moment in each player's own VOD, chapters, and a wider hashtag block (checkpoint tags +
 * both player names, matching what competitor channels already do). Paste this under the
 * hand-written title/result/head-to-head lines from the template in
 * branding/YOUTUBE_STUDIO_SETUP.md — this doesn't replace that template, it fills in the parts
 * the pipeline can compute reliably.
 */
export function buildDescriptionExtras(input: DescriptionExtrasInput): string {
  const { leftNickname, rightNickname, leftWindow, rightWindow, chapters } = input;

  const watchLinks = [
    `Watch ${leftNickname}: ${vodDeepLink(leftWindow)}`,
    `Watch ${rightNickname}: ${vodDeepLink(rightWindow)}`,
  ].join("\n");

  const hashtags = [...FORMAT_HASHTAGS, slugTag(leftNickname), slugTag(rightNickname), ...CHECKPOINT_HASHTAGS].join(
    " ",
  );

  return [
    watchLinks,
    "",
    "Chapters:",
    formatChapters(chapters),
    "",
    "MCSR Replayoffs is an independent fan project, not affiliated with MCSR Ranked.",
    "Spot a sync issue or a stat error? Flag it — this pipeline is actively maintained, not fire-and-forget automation.",
    "",
    hashtags,
  ].join("\n");
}
