/**
 * What happened to a match after it left the pipeline: the upload record that joins a thumbnail
 * variant to a videoId and its CTR row.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { matchDir } from "./config.js";
import { listProcessedMatchIds } from "./matchStatus.js";

const UPLOAD_FILE = "youtube.json";

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
 * Whatever video in the match folder is not a POV clip (`<nickname>.mp4`), a render intermediate
 * or a Short: `npm run export:fast` writes `final-<id>.mp4`, `scripts/export.sh` writes
 * `final.mp4`, and a hand export can be named anything.
 *
 * Ambiguity is reported rather than guessed at: uploading the wrong four-gigabyte file to a
 * public channel is not a mistake worth being clever about.
 */
export function findExportedVideo(
  matchId: number,
  povNicknames: string[],
): { path: string } | { error: string } {
  const dir = matchDir(matchId);
  if (!existsSync(dir)) return { error: `No working directory for match ${matchId}` };

  const povFiles = new Set(povNicknames.map((n) => `${n}.mp4`));
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(mp4|mov|mkv|webm)$/i.test(e.name))
    .map((e) => e.name)
    // Everything named overlay* is a render intermediate, not the finished video: the timer
    // strip, the intro card and the split stills. Matched by prefix rather than by name so the
    // codec changes those artifacts have been through (overlay.mov -> overlay-timer.mp4,
    // overlay-intro.mov -> overlay-intro.webm) cannot turn one of them into an upload candidate.
    //
    // `.part.` catches anything still being written. Both writers in this project rename into
    // place on success — src/atomicOutput.ts writes `<name>.part<ext>`, scripts/export.sh writes
    // `final.part.mp4` — precisely so a truncated file is never mistaken for a finished one.
    // Without this the upload panel would offer `final.part.mp4` while an export was still
    // running, and publish half a video.
    .filter(
      (name) =>
        !povFiles.has(name) &&
        !name.startsWith("overlay") &&
        // A Short is its own deliverable, uploaded as a separate video — not a candidate for
        // "the finished match export". Without this the Shorts pipeline makes every rendered
        // match ambiguous, which silently disables the upload panel and the preview player.
        !name.startsWith("short-") &&
        !name.includes(".part.") &&
        name !== "sync-preview.mp4",
    );

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
