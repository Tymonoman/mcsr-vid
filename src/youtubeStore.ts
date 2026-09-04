/**
 * What happened to a match after it left the pipeline.
 *
 * The pipeline stops at a Kdenlive project — the finished video is exported by hand — so
 * nothing in this repo previously knew whether a match had been published, let alone as which
 * video. That record is what turns a pile of renders into a channel you can reason about, and
 * it is the join key thumbnail A/B testing needs: variant -> videoId -> CTR row.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { listProcessedMatchIds } from "./matchStatus.js";

export const UPLOAD_FILE = "youtube.json";

export interface UploadRecord {
  videoId: string;
  /** RFC 3339. When the upload completed, not when YouTube publishes it. */
  uploadedAt: string;
  /** RFC 3339 scheduled publish time, or null for "published on upload". */
  publishAt: string | null;
  privacyStatus: string;
  /** Which thumbnail variant was live at upload time — the A/B grouping key. */
  thumbnailVariant: string | null;
  title: string;
}

const matchDir = (matchId: number): string => path.join(config.mediaDir, String(matchId));
const recordPath = (matchId: number): string => path.join(matchDir(matchId), UPLOAD_FILE);

export async function readUpload(matchId: number): Promise<UploadRecord | null> {
  const file = recordPath(matchId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as UploadRecord;
  } catch {
    // A truncated record must not hide the rest of the dashboard; treated as "not uploaded",
    // which is recoverable by uploading again, rather than throwing on every page load.
    return null;
  }
}

export async function writeUpload(matchId: number, record: UploadRecord): Promise<void> {
  await writeFile(recordPath(matchId), JSON.stringify(record, null, 2), "utf8");
}

/** Every match that has been uploaded, for the stats table. */
export async function allUploads(): Promise<Array<{ matchId: number; record: UploadRecord }>> {
  const entries = await Promise.all(
    listProcessedMatchIds().map(async (matchId) => ({ matchId, record: await readUpload(matchId) })),
  );
  return entries.filter((e): e is { matchId: number; record: UploadRecord } => e.record !== null);
}

/**
 * The finished video to upload, or null.
 *
 * The pipeline never produces one: it writes two POV clips, the overlay, and a Kdenlive project
 * you export from by hand. So the convention is "whatever video file in the match folder is not
 * one of the two POV clips" — export into the match folder and it is found automatically. The
 * POV clips are named `<nickname>.mp4`, and they are the only ones the pipeline itself writes.
 *
 * Ambiguity is reported rather than guessed at: uploading the wrong four-gigabyte file to a
 * public channel is not a mistake worth being clever about.
 */
export function findExportedVideo(matchId: number, povNicknames: string[]): { path: string } | { error: string } {
  const dir = matchDir(matchId);
  if (!existsSync(dir)) return { error: `No working directory for match ${matchId}` };

  const povFiles = new Set(povNicknames.map((n) => `${n}.mp4`));
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(mp4|mov|mkv|webm)$/i.test(e.name))
    .map((e) => e.name)
    // overlay.mov and overlay-intro.mov are render intermediates, not the finished video.
    .filter((name) => !povFiles.has(name) && !name.startsWith("overlay") && name !== "sync-preview.mp4");

  if (candidates.length === 0) {
    return {
      error:
        `No exported video in ${dir}. Export the finished render from Kdenlive into that folder ` +
        `(any name except the two POV clips), or give an explicit path.`,
    };
  }
  if (candidates.length > 1) {
    return { error: `Several possible videos in ${dir}: ${candidates.join(", ")}. Give an explicit path.` };
  }
  return { path: path.join(dir, candidates[0]!) };
}
