/**
 * "Put on YouTube" / "Undo on YouTube": the chosen thumbnail variant onto a long-form already on
 * the channel, and back. Each is one operator press (a live-channel change: CLAUDE.md, "nothing
 * irreversible without the operator"); nothing schedules either.
 *
 * Before the first swap the image the video wears is downloaded from YouTube itself into
 * `thumbnail-youtube-prev.jpg` — not copied from `thumbnail.png`, which "Use this" may already
 * have overwritten, and which a Studio upload never wore. Kept once and never overwritten, so
 * Undo always goes back to what the video had before the dashboard touched it.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { readManifest } from "../thumbnails/thumbnailVariants.js";
import { liveThumbnail, setThumbnail } from "./youtube.js";
import { allUploads, readUpload, writeUpload, type UploadRecord } from "./youtubeStore.js";

export const YOUTUBE_PREV_FILE = "thumbnail-youtube-prev.jpg";
/** A 1280x720 JPEG is tens of kilobytes; anything this small is not the picture. */
const MIN_COPY_BYTES = 5_000;

/** A refusal the route answers as 409: nothing was sent to YouTube. */
export class SwapRefused extends Error {}

/**
 * This match's long-form record, when its thumbnail is this directory's to set. A series' games
 * 2..n carry game 1's video id (the channel scan pairs every game's link), and the series'
 * thumbnail is game 1's: the lowest match id holding the id owns it. A Short is never here —
 * `youtube.json` is the long-form's record, and Shorts have no custom thumbnail.
 */
export async function longFormRecord(matchId: number): Promise<UploadRecord | null> {
  const record = await readUpload(matchId);
  if (!record) return null;
  const owner = (await allUploads()).find((u) => u.record.videoId === record.videoId)?.matchId ?? matchId;
  return owner < matchId ? null : record;
}

export interface SwapResult {
  videoId: string;
  title: string;
  set: { variant: string | null; at: string };
}

/** `undo: false` puts the chosen variant on; `undo: true` puts back the image kept before the first swap. */
export async function swapThumbnail(
  matchId: number,
  undo: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<SwapResult> {
  const dir = matchDir(matchId);
  const record = await longFormRecord(matchId);
  if (!record) throw new SwapRefused(`Match ${matchId} has no long-form of its own on the channel`);
  const prev = path.join(dir, YOUTUBE_PREV_FILE);

  let file: string;
  let variant: string | null = null;
  if (undo) {
    if (!existsSync(prev)) throw new SwapRefused("Nothing to undo: no thumbnail was swapped from here");
    file = prev;
  } else {
    const manifest = await readManifest(dir);
    const chosen = manifest?.variants.find((v) => v.key === manifest.chosen);
    // The same rule as Adopt: the renderer's default is not somebody having looked at it.
    if (!chosen || manifest?.chosenBy !== "operator") {
      throw new SwapRefused('No variant is confirmed — press "Use this" or "Keep this" on the one to put on');
    }
    file = path.join(dir, chosen.file);
    if (!existsSync(file)) throw new SwapRefused(`No thumbnail at ${file}`);
    variant = chosen.key;
  }

  // Reads the video first: refuses another channel's, and names what it wears now.
  const live = await liveThumbnail(record.videoId, config.youtubeChannelId, fetchImpl);
  if (!undo && !existsSync(prev)) {
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
    await writeFile(prev, bytes);
  }

  await setThumbnail(record.videoId, file, fetchImpl);
  const set = { variant, at: new Date().toISOString() };
  // The finish ledger's thumbnail step counts as done, so a later "Finish on YouTube" does not
  // put a different image over the one pressed here.
  await writeUpload(matchId, {
    ...record,
    thumbnailSet: set,
    finished: { ...record.finished, thumbnail: null },
  });
  return { videoId: record.videoId, title: live.title, set };
}
