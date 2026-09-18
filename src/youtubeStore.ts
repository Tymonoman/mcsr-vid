/**
 * What happened to a match after it left the pipeline: the upload record that joins a thumbnail
 * variant to a videoId and its CTR row.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { matchDir } from "./config.js";
import { listProcessedMatchIds } from "./matchStatus.js";
import { readManifest } from "./thumbnailVariants.js";
import { HOOK_PLACEHOLDER, metaPaths } from "./title.js";

/** The long-form and the Short are two videos with two records. */
export type UploadKind = "video" | "short";

const UPLOAD_FILE: Record<UploadKind, string> = { video: "youtube.json", short: "youtube-short.json" };

/**
 * Per step: null for done, the error text for failed, absent for not attempted (a Short has no
 * thumbnail, a private video cannot be commented on). What "Finish on YouTube" reports — and what
 * it reads back to know which steps it must not do a second time.
 */
export interface FinishedSteps {
  thumbnail?: string | null;
  playlists?: string | null;
  comment?: string | null;
  tags?: string | null;
}

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
  /** Absent on records written before Studio uploads were persisted: those were the dashboard's. */
  source?: "dashboard" | "studio";
  /** What `finishOnYouTube` did to it, once it has run. */
  finished?: FinishedSteps;
}

const recordPath = (matchId: number, kind: UploadKind): string =>
  path.join(matchDir(matchId), UPLOAD_FILE[kind]);

export async function readUpload(matchId: number, kind: UploadKind = "video"): Promise<UploadRecord | null> {
  const file = recordPath(matchId, kind);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as UploadRecord;
  } catch {
    // A truncated record must not hide the rest of the dashboard; treated as "not uploaded",
    // which is recoverable by uploading again, rather than throwing on every page load.
    return null;
  }
}

export async function writeUpload(
  matchId: number,
  record: UploadRecord,
  kind: UploadKind = "video",
): Promise<void> {
  await writeFile(recordPath(matchId, kind), JSON.stringify(record, null, 2), "utf8");
}

const readIfPresent = async (file: string): Promise<string | null> =>
  existsSync(file) ? readFile(file, "utf8") : null;

/**
 * The title, description and tags an upload sends, read off the same files the publish kit
 * pastes from (server.ts `readMeta`: the `.edited.txt` sibling wins over the generated text).
 * Title is the first line only — the lines under it are guidance for the terminal (src/title.ts)
 * — with the thumbnail manifest's headline standing in for `<HOOK>` when nobody edited one in;
 * a title that still carries the placeholder is the caller's to refuse.
 *
 * The Short's text is the render's own (`short-<id>.title.txt`, first line); its tags are the
 * long-form's, so both halves of a match are one channel to YouTube.
 */
export async function uploadTextFor(
  matchId: number,
  kind: UploadKind,
): Promise<{ title: string; description: string; tags: string[] }> {
  const dir = matchDir(matchId);
  const base = kind === "short" ? `short-${matchId}` : `match-${matchId}`;
  // The Short's title and description are the render's own and have no editable sibling; the
  // long-form's convention is `metaPaths`, shared with the title editor and the publish kit.
  const edited = (what: "title" | "description") =>
    kind === "video" ? readIfPresent(metaPaths(matchId, what).edited) : Promise.resolve(null);
  const titleText =
    (await edited("title")) ?? (await readIfPresent(path.join(dir, `${base}.title.txt`))) ?? "";
  let title = titleText.split("\n")[0]!.trim();
  if (title.includes(HOOK_PLACEHOLDER)) {
    const hook = (await readManifest(dir))?.hookText?.trim();
    if (hook) title = title.replace(HOOK_PLACEHOLDER, hook);
  }
  const description =
    (await edited("description")) ?? (await readIfPresent(path.join(dir, `${base}.description.txt`))) ?? "";
  const tags = ((await readIfPresent(path.join(dir, `match-${matchId}.tags.txt`))) ?? "")
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
  return { title, description, tags };
}

/**
 * The first comment on a match video, which the operator pins in Studio (pinning has no API).
 * The publish kit shows the same line. What the video is and where to report a sync slip, in
 * the operator's own voice; no question, no subscribe ask, and never the winner.
 */
export const PINNED_COMMENT =
  "both povs are the players own streams, synced on the countdown. if the timer looks off anywhere drop the timestamp here and ill fix it";

/**
 * The match whose record already names this video id, across BOTH kinds, or null.
 *
 * `allUploads` reads only `youtube.json`, so a check built on it cannot see a Short — and the
 * Short of a match is exactly the id an operator is most likely to paste by mistake, since both
 * sit next to each other in Studio.
 */
export async function videoIdOwner(videoId: string): Promise<{ matchId: number; kind: UploadKind } | null> {
  for (const matchId of listProcessedMatchIds()) {
    for (const kind of ["video", "short"] as const) {
      if ((await readUpload(matchId, kind))?.videoId === videoId) return { matchId, kind };
    }
  }
  return null;
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
 * or a Short: `npm run export:fast` writes `final-<id>.mp4`, the retired melt export wrote
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
    // place on success — src/atomicOutput.ts writes `<name>.part<ext>`, exportFast.ts writes
    // `final-<id>.part.mp4` — precisely so a truncated file is never mistaken for a finished one.
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
        // `export:fast --seconds` writes smoke-<id>.mp4: a range, never the deliverable.
        !name.startsWith("smoke-") &&
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
