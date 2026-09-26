/**
 * "Re-render thumbnails": every variant drawn again with today's design, for a match rendered
 * before it — including a Studio upload whose directory never had thumbnail files. The stills a
 * pipeline run finds on disk are kept (`variantStillReusable`), so without this a new layout only
 * ever reached matches rendered after it.
 *
 * One generation of the old set is kept in `thumbnail-prev/` (the variant PNGs, the manifest and
 * `thumbnail.png`), and a failed render puts it back. `thumbnail.png` itself is not touched by a
 * re-render: it is the image the video went up with, and changing what YouTube shows is a
 * separate, explicit press (src/youtube/thumbnailSwap.ts).
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { getMatch, getUser } from "../api/mcsrApi.js";
import { manifestPath, renderThumbnailVariants, type VariantsManifest } from "./thumbnailVariants.js";
import type { ThumbnailProgress } from "./thumbnailRender.js";

export const PREV_DIR = "thumbnail-prev";

/** `thumbnail.json`, `thumbnail.png` and every `thumbnail.<pose-pair>.png`. */
const isThumbnailFile = (name: string): boolean =>
  name === "thumbnail.json" || /^thumbnail\.(.+\.)?png$/.test(name);

/** Copies the current set into `thumbnail-prev/`, replacing the generation before it. Returns what it kept. */
export async function backupThumbnails(outDir: string): Promise<string[]> {
  const files = (await readdir(outDir)).filter(isThumbnailFile);
  if (files.length === 0) return [];
  const prev = path.join(outDir, PREV_DIR);
  await rm(prev, { recursive: true, force: true });
  await mkdir(prev);
  for (const f of files) await copyFile(path.join(outDir, f), path.join(prev, f));
  return files;
}

/** Puts the backed-up set back over whatever a failed render left. */
export async function restoreThumbnails(outDir: string): Promise<string[]> {
  const prev = path.join(outDir, PREV_DIR);
  if (!existsSync(prev)) return [];
  const files = await readdir(prev);
  for (const f of files) await copyFile(path.join(prev, f), path.join(outDir, f));
  // A render that failed before writing its manifest must not leave one naming files it never drew.
  if (!files.includes("thumbnail.json")) await rm(manifestPath(outDir), { force: true });
  return files;
}

export interface RerenderDeps {
  render?: typeof renderThumbnailVariants;
  onProgress?: (p: ThumbnailProgress) => void;
  signal?: AbortSignal;
}

export async function rerenderThumbnails(
  matchId: number,
  deps: RerenderDeps = {},
): Promise<VariantsManifest> {
  const outDir = matchDir(matchId);
  if (!existsSync(outDir)) throw new Error(`Match ${matchId} has no directory on this box`);
  const match = await getMatch(matchId);
  const [left, right] = match.players;
  if (!left || !right) throw new Error(`Match ${matchId} does not have two players`);
  const [userLeft, userRight] = await Promise.all([getUser(left.uuid), getUser(right.uuid)]);
  const backedUp = await backupThumbnails(outDir);
  try {
    return await (deps.render ?? renderThumbnailVariants)({
      match,
      userLeft,
      userRight,
      outDir,
      poses: config.thumbnailVariants,
      fresh: true,
      onProgress: deps.onProgress,
      signal: deps.signal,
    });
  } catch (err) {
    if (backedUp.length) await restoreThumbnails(outDir);
    throw err;
  }
}
