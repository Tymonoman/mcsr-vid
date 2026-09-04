import { rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Renders to a temporary sibling and renames only on success.
 *
 * Every stage-completion check in this project is `existsSync` on the artifact —
 * `pipeline.ts` skips the render when `overlay.mov` is present, `matchStatus.ts`
 * reports the same to the TUI and the dashboard. Remotion writes that file
 * progressively, so a render killed partway (OOM against the container's memory
 * cap, a container restart, Ctrl-C) leaves a truncated `overlay.mov` that every
 * one of those checks reads as "done". The next run then reuses several gigabytes
 * of corrupt video and reports success.
 *
 * Renaming within a directory is atomic on POSIX, so the final name only ever
 * appears on a completed render. A crash leaves `<name>.part.<ext>` behind, which
 * nothing treats as an artifact and the next run overwrites.
 *
 * The extension is preserved in the temporary name because ffmpeg picks its muxer
 * from it — `overlay.mov.part` would not produce ProRes.
 */
export async function atomicOutput<T>(
  finalPath: string,
  render: (tempPath: string) => Promise<T>,
): Promise<T> {
  const ext = path.extname(finalPath);
  const tempPath = `${finalPath.slice(0, finalPath.length - ext.length)}.part${ext}`;

  // A leftover from a previous crash would otherwise confuse the muxer.
  await rm(tempPath, { force: true });

  const result = await render(tempPath);
  await rename(tempPath, finalPath);
  return result;
}
