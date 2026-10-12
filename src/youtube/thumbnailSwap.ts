/**
 * "Put on YouTube" / "Undo on YouTube": a tile of the re-rendered set (`thumbnail-new/`,
 * src/thumbnails/rerender.ts) onto a long-form already on the channel, and back. Each is one
 * operator press (a live-channel change: CLAUDE.md, "nothing irreversible without the operator");
 * nothing schedules either.
 *
 * Before the first put on a video, the image it wears is downloaded from YouTube itself into
 * `thumbnail-youtube-<videoId>.jpg` — kept once per video and never overwritten, so Undo always
 * goes back to what that video had before the dashboard touched it.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { blockedOnDisk } from "../dashboard/matchStatus.js";
import { NEW_DIR } from "../thumbnails/rerender.js";
import { readManifest } from "../thumbnails/thumbnailVariants.js";
import { liveThumbnail, setThumbnail } from "./youtube.js";
import { longFormRecord, onVideo, readUpload, writeUpload, type UploadRecord } from "./youtubeStore.js";

export const undoFile = (videoId: string): string => `thumbnail-youtube-${videoId}.jpg`;
/** A 1280x720 JPEG is tens of kilobytes; anything this small is not the picture. */
const MIN_COPY_BYTES = 5_000;

/** A refusal the route answers as 409: nothing was sent to YouTube. */
export class SwapRefused extends Error {}

export interface SwapResult {
  videoId: string;
  title: string;
  set: NonNullable<UploadRecord["thumbnailSet"]>;
}

/** `{ variant }` puts that new-design tile on; `{ undo: true }` puts back the image kept before the first put. */
export const swapThumbnail = (
  matchId: number,
  what: { variant: string } | { undo: true },
  fetchImpl: typeof fetch = fetch,
): Promise<SwapResult> => onVideo(matchId, () => swap(matchId, what, fetchImpl));

async function swap(
  matchId: number,
  what: { variant: string } | { undo: true },
  fetchImpl: typeof fetch,
): Promise<SwapResult> {
  const dir = matchDir(matchId);
  // Same gate every other YouTube write in this codebase goes through (hasBlockedPlayer,
  // youtubeUpload.ts): a runner's no is a block, and this is a write to the live channel.
  if (blockedOnDisk(dir))
    throw new SwapRefused(`Match ${matchId} has a blocked player — uploads of it are refused`);
  const record = await longFormRecord(matchId);
  if (!record) throw new SwapRefused(`Match ${matchId} has no long-form of its own on the channel`);
  const kept = path.join(dir, undoFile(record.videoId));
  const undo = "undo" in what;

  let file = kept;
  if (undo) {
    if (!existsSync(kept))
      throw new SwapRefused("Nothing to undo: no thumbnail was put on this video from here");
  } else {
    const tile = (await readManifest(path.join(dir, NEW_DIR)))?.variants.find((v) => v.key === what.variant);
    if (!tile)
      throw new SwapRefused(`No new-design thumbnail "${what.variant}" — re-render the thumbnails first`);
    file = path.join(dir, NEW_DIR, tile.file);
  }

  // Reads the video first: refuses another channel's, and names what it wears now.
  const live = await liveThumbnail(record.videoId, config.youtubeChannelId, fetchImpl);
  if (!undo && !existsSync(kept)) {
    // Kept once and never replaced, so it has to be the real picture: a 16:9 one at full size
    // (below 1280 wide is a 4:3 letterboxed sddefault/hqdefault) and a body that is an image
    // rather than an empty or placeholder answer. Anything less refuses — expected of a private or
    // scheduled video, though YouTube's answer for one was never captured.
    const res = live.url && live.width >= 1280 ? await fetchImpl(live.url).catch(() => null) : null;
    const bytes = res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    if (!bytes || bytes.length < MIN_COPY_BYTES) {
      throw new SwapRefused(
        "Could not keep a full-size copy of the thumbnail YouTube shows now (no image 1280 wide and 5 KB or more came back), so there would be nothing to undo to — nothing changed; press again once the video is public",
      );
    }
    await writeFile(kept, bytes);
  }

  await setThumbnail(record.videoId, file, fetchImpl);
  const at = new Date().toISOString();
  const set = undo ? { variant: null, at } : { variant: what.variant, at, from: NEW_DIR };
  // Read again: Adopt writes the record without waiting its turn. The finish ledger's thumbnail
  // step counts as done, so a later Finish does not put the live set's pick over this image.
  const latest = await readUpload(matchId);
  if (latest?.videoId === record.videoId) {
    await writeUpload(matchId, {
      ...latest,
      thumbnailSet: set,
      finished: { ...latest.finished, thumbnail: null },
    });
  }
  return { videoId: record.videoId, title: live.title, set };
}
