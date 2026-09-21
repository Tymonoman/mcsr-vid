/**
 * The next fixed publish slot that nothing else has taken.
 *
 * Browse is three quarters of this channel's traffic, and browse rewards a slot the audience
 * can expect; `publishHourUtc` is the active competitor's measured slot (see src/config.ts).
 *
 * One slot a day, though: two videos published into the same hour compete with each other for
 * the same browse impressions, and three matches rendered overnight are three matches ready by
 * breakfast. So a day another video already claims is skipped rather than doubled up on, and the
 * kit proposes tomorrow — which is also how a week of renders turns into a week of uploads.
 *
 * `minLeadMs` skips a slot that is too close to upload for: a scheduled time YouTube has already
 * passed rejects the whole upload, and an 800 MB file is not on the platform in five minutes.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { channelUploadsSnapshot, describesMatch } from "./channelUploads.js";
import { msUntilNextRun } from "../dashboard/nightly.js";
import { allUploads, readUpload } from "./youtubeStore.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which UTC day and hour a moment falls on. A ranked match and a playoff series have their own
 * hours (`publishHourUtc`, `seriesPublishHourUtc`), so a day another kind has claimed is still
 * free for this one: the test is the slot, not the day.
 */
const slotOf = (ms: number): string => `${Math.floor(ms / DAY_MS)}:${new Date(ms).getUTCHours()}`;

export function nextPublishSlot(
  nowMs: number,
  hourUtc: number,
  /** RFC 3339 times other videos are already scheduled for — see `claimedPublishTimes`. */
  claimedAt: readonly string[] = [],
  minLeadMs = 60 * 60 * 1000,
): Date {
  const taken = new Set(
    claimedAt
      .map((at) => Date.parse(at))
      // A slot in the past cannot collide with one we are about to propose, and an unparseable
      // date is not a reason to push every upload a day out.
      .filter((ms) => Number.isFinite(ms) && ms > nowMs)
      .map(slotOf),
  );
  let at = nowMs + msUntilNextRun(nowMs, hourUtc);
  if (at - nowMs < minLeadMs) at += DAY_MS;
  while (taken.has(slotOf(at))) at += DAY_MS;
  return new Date(at);
}

/** The hour a match publishes at: a series video (`series.json` in its directory) has its own. */
export const publishHourFor = (matchDir: string): number =>
  existsSync(path.join(matchDir, "series.json")) ? config.seriesPublishHourUtc : config.publishHourUtc;

/**
 * The publish times already spoken for, for everything but this match.
 *
 * Two sources, because uploading is half manual: what the channel says is scheduled (a Studio
 * upload with a future `publishAt`, src/youtube/channelUploads.ts) and what this dashboard recorded when
 * it uploaded (`youtube.json`). This match's own scheduling is excluded — a match already booked
 * into tomorrow's slot must not push its own kit into the day after.
 */
export async function claimedPublishTimes(exceptMatchId: number): Promise<string[]> {
  const channel = channelUploadsSnapshot();
  // Every video of this match, not the first: a Short's description carries the same
  // `/matches/<id>` link, so excluding one video by id let the Short stand in for the long-form
  // and the match's own booked slot pushed its kit into the day after.
  const ownVideoId = (await readUpload(exceptMatchId))?.videoId;
  const uploads = await allUploads();
  return [
    ...channel
      .filter((v) => !describesMatch(exceptMatchId, v) && v.videoId !== ownVideoId)
      .map((v) => v.publishAt),
    ...uploads.filter((u) => u.matchId !== exceptMatchId).map((u) => u.record.publishAt),
  ].filter((at): at is string => typeof at === "string" && at.trim() !== "");
}
