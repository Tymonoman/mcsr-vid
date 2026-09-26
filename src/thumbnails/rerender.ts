/**
 * "Re-render thumbnails": every variant drawn again with today's design, for a match rendered
 * before it — including a Studio upload whose directory never had thumbnail files. The stills a
 * pipeline run finds on disk are kept (`variantStillReusable`), so without this a new layout only
 * ever reached matches rendered after it.
 *
 * A match already on the channel (`isUploaded`) gets the new set in its own folder, `thumbnail-new/`, and its
 * live set (`thumbnail.png`, the variant PNGs, `thumbnail.json`) is never touched: uploads, Finish,
 * the channel scan, the A/B tab and the publish set read exactly what they read before. Changing
 * what YouTube shows is a separate press (src/youtube/thumbnailSwap.ts). A match not on the channel
 * has nothing to protect, so its live set is drawn again the way a pipeline run draws it.
 */
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { getMatch, getUser } from "../api/mcsrApi.js";
import { isUploaded } from "../dashboard/matchShelf.js";
import { renderThumbnailVariants, type VariantsManifest } from "./thumbnailVariants.js";
import type { ThumbnailProgress } from "./thumbnailRender.js";

export const NEW_DIR = "thumbnail-new";

export interface RerenderDeps {
  render?: typeof renderThumbnailVariants;
  onProgress?: (p: ThumbnailProgress) => void;
  signal?: AbortSignal;
}

export async function rerenderThumbnails(
  matchId: number,
  deps: RerenderDeps = {},
): Promise<VariantsManifest> {
  const dir = matchDir(matchId);
  if (!existsSync(dir)) throw new Error(`Match ${matchId} has no directory on this box`);
  const match = await getMatch(matchId);
  const [left, right] = match.players;
  if (!left || !right) throw new Error(`Match ${matchId} does not have two players`);
  const [userLeft, userRight] = await Promise.all([getUser(left.uuid), getUser(right.uuid)]);
  let outDir = dir;
  // On the channel by any of the three routes: its record, the channel scan's pairing (a series'
  // games — the series is game 1's upload — or a Studio upload not recorded yet), the manual tick.
  if (await isUploaded(matchId)) {
    // Started afresh: a set cut short by a crash or a restart has no manifest, so it shows nothing
    // until a re-render lands one (each still is renamed into place whole; the manifest comes last).
    outDir = path.join(dir, NEW_DIR);
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir);
  }
  return (deps.render ?? renderThumbnailVariants)({
    match,
    userLeft,
    userRight,
    outDir,
    poses: config.thumbnailVariants,
    fresh: true,
    onProgress: deps.onProgress,
    signal: deps.signal,
  });
}
