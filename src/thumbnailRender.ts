import { copyFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_POSES } from "./thumbnailProps.js";
import { renderThumbnailVariants } from "./thumbnailVariants.js";
import type { MatchInfo, UserDetails } from "./types.js";

/**
 * `renderStill` has no progress API, so the webpack bundle is the only sub-step that can report
 * anything — and it is also the slow one, which is why the thumbnail stage used to sit at no
 * percent at all for most of its run.
 */
export interface ThumbnailProgress {
  phase: "bundling" | "rendering";
  percent: number;
}

export interface RenderThumbnailArgs {
  match: MatchInfo;
  userLeft: UserDetails;
  userRight: UserDetails;
  outPath: string;
  onProgress?: (p: ThumbnailProgress) => void;
  signal?: AbortSignal;
}

export interface RenderThumbnailResult {
  path: string;
}

/**
 * Renders the single default-pose thumbnail, for `npm run generate-thumbnail`.
 *
 * A thin wrapper over the variant renderer so there is one code path that bundles, selects the
 * composition and writes atomically. The pipeline calls `renderThumbnailVariants` directly with
 * the configured pose list; this exists for the standalone CLI, which wants exactly one image at
 * a caller-chosen path.
 */
export async function renderThumbnail(args: RenderThumbnailArgs): Promise<RenderThumbnailResult> {
  const outDir = path.dirname(args.outPath);
  await renderThumbnailVariants({
    match: args.match,
    userLeft: args.userLeft,
    userRight: args.userRight,
    outDir,
    poses: [DEFAULT_POSES],
    onProgress: args.onProgress,
    signal: args.signal,
  });

  // The variant renderer always leaves the chosen render at `thumbnail.png`; honour an outPath
  // that asked for something else rather than silently ignoring it.
  const canonical = path.join(outDir, "thumbnail.png");
  if (path.resolve(canonical) !== path.resolve(args.outPath)) {
    await copyFile(canonical, args.outPath);
  }
  return { path: args.outPath };
}
