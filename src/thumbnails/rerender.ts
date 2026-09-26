/**
 * "Re-render thumbnails": every variant drawn again with today's design, for a match rendered
 * before it — including a Studio upload whose directory never had thumbnail files. The stills a
 * pipeline run finds on disk are kept (`variantStillReusable`), so without this a new layout only
 * ever reached matches rendered after it.
 *
 * The set from before the first re-render (the variant PNGs, the manifest and `thumbnail.png`,
 * the image the video went up with) is kept in `thumbnail-prev/` for good: a second re-render,
 * the bulk after a single one, must not replace the old design with the first new one — it is the
 * "old" of Studio's Test & Compare, and for a private or scheduled video, where "Put on YouTube"
 * refuses, the only copy off YouTube. A failed render puts back the set it started from.
 * On an uploaded match `thumbnail.png` is not touched by a re-render: changing what YouTube shows
 * is a separate, explicit press (src/youtube/thumbnailSwap.ts).
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { getMatch, getUser } from "../api/mcsrApi.js";
import { readUpload } from "../youtube/youtubeStore.js";
import {
  abTestKey,
  manifestPath,
  readManifest,
  renderThumbnailVariants,
  rerenderedAfter,
  type VariantRecord,
  type VariantsManifest,
} from "./thumbnailVariants.js";
import type { ThumbnailProgress } from "./thumbnailRender.js";

export const PREV_DIR = "thumbnail-prev";
/**
 * The set a re-render started from, while it runs; removed once it has settled. Still there at the
 * start of the next one means a restart cut a render short, and it is put back first. Finish
 * leaves the thumbnail alone while it exists (src/youtube/youtubeUpload.ts).
 */
export const RUNNING_DIR = "thumbnail-rerendering";

/** `thumbnail.json`, `thumbnail.png` and every `thumbnail.<pose-pair>.png`. */
const isThumbnailFile = (name: string): boolean =>
  name === "thumbnail.json" || /^thumbnail\.(.+\.)?png$/.test(name);

/** Copies the current thumbnail set into `outDir/<into>`, made afresh. Returns what it copied. */
export async function copyThumbnails(outDir: string, into: string): Promise<string[]> {
  const files = (await readdir(outDir)).filter(isThumbnailFile);
  if (files.length === 0) return [];
  const to = path.join(outDir, into);
  await rm(to, { recursive: true, force: true });
  await mkdir(to);
  for (const f of files) await copyFile(path.join(outDir, f), path.join(to, f));
  return files;
}

/** Puts `outDir/<from>` back over whatever a failed render left. */
export async function restoreThumbnails(outDir: string, from: string): Promise<string[]> {
  const dir = path.join(outDir, from);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  for (const f of files) await copyFile(path.join(dir, f), path.join(outDir, f));
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
  await restoreThumbnails(outDir, RUNNING_DIR);
  if (!existsSync(path.join(outDir, PREV_DIR))) await copyThumbnails(outDir, PREV_DIR);
  const started = await copyThumbnails(outDir, RUNNING_DIR);
  // The stills are overwritten one by one from here, so the manifest stops vouching for them
  // first: no Finish, playlist retry or upload may send a half-drawn set as the confirmed pick.
  const before = await readManifest(outDir);
  if (before) {
    const drawing = { ...before, chosenBy: "auto", rerenderedAt: new Date().toISOString() };
    await writeFile(manifestPath(outDir), JSON.stringify(drawing, null, 2), "utf8");
  }
  try {
    const manifest = await (deps.render ?? renderThumbnailVariants)({
      match,
      userLeft,
      userRight,
      outDir,
      poses: config.thumbnailVariants,
      fresh: true,
      onProgress: deps.onProgress,
      signal: deps.signal,
    });
    // Nothing on the channel yet: the new pick is what an upload sends, so thumbnail.png (what the
    // publish set, the bundle and Studio are handed) follows it.
    const chosen = manifest.variants.find((v) => v.key === manifest.chosen);
    if (chosen && !(await readUpload(matchId))) {
      await copyFile(path.join(outDir, chosen.file), path.join(outDir, "thumbnail.png"));
    }
    return manifest;
  } catch (err) {
    await restoreThumbnails(outDir, RUNNING_DIR);
    // A render that failed before writing its manifest must not leave one naming files it never drew.
    if (!started.includes("thumbnail.json")) await rm(manifestPath(outDir), { force: true });
    throw err;
  } finally {
    await rm(path.join(outDir, RUNNING_DIR), { recursive: true, force: true });
  }
}

/**
 * The A/B tab's row for an uploaded video (src/dashboard/youtubeRoutes.ts): the variant it went up
 * with, as it was drawn then. A re-render after the upload redrew the live set — the providers of
 * the new look would add "(facing)" and credit it with the old image's clicks — so that set is
 * read from `thumbnail-prev/`. A video whose thumbnail was swapped on YouTube wore two images and
 * gets a row of its own.
 */
export async function abRowFor(
  dir: string,
  u: {
    source: string;
    uploadedAt?: string;
    publishedAt?: string;
    thumbnailVariant?: string | null;
    thumbnailSet?: unknown;
  },
): Promise<{ key: string; variant: VariantRecord | undefined }> {
  const live = await readManifest(dir);
  const worn = rerenderedAfter(live, u.uploadedAt ?? u.publishedAt)
    ? await readManifest(path.join(dir, PREV_DIR))
    : live;
  // A dashboard upload recorded which variant it sent; a Studio upload did not, and the
  // manifest's `chosen` is the one the dashboard handed over to be uploaded.
  const variantKey = u.source === "channel" ? (worn?.chosen ?? undefined) : u.thumbnailVariant;
  const variant = worn?.variants.find((v) => v.key === variantKey);
  const key = u.thumbnailSet ? "(swapped)" : variantKey ? abTestKey(variantKey, variant) : "(unknown)";
  return { key, variant };
}
