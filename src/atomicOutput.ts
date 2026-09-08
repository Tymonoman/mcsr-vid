import { rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Renders to a temporary sibling and renames only on success.
 *
 * Every stage-completion check is an `existsSync` on the artifact, and Remotion writes
 * progressively, so a killed render must never leave a full-named truncated file.
 * Renaming within a directory is atomic on POSIX, so the final name only ever appears
 * on a completed render; a crash leaves `<name>.part.<ext>`, which nothing treats as an
 * artifact and the next run overwrites.
 *
 * The extension is kept in the temporary name because ffmpeg picks its muxer from it.
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
