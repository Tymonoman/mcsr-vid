import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Where match start actually falls inside each downloaded POV clip, as the sync stage decided it.
 *
 * The pipeline used to keep this in memory and spend it only on the .kdenlive placement, so
 * `export:fast` and the Short — which never see that project — fell back to the coarse download
 * estimate (`config.preRollSec`) and rendered the overlay seconds early. Persisting the numbers
 * next to the clips is what lets every consumer place them the same way.
 */
export interface SyncOffsets {
  /** Seconds into the left player's clip where match start falls. */
  left: number;
  /** Same, for the right player's clip. */
  right: number;
  /** 0-1, as computeSyncOffset reports it; below the threshold means `left`/`right` are coarse. */
  confidence: number;
  detail: string;
  /**
   * `countdown` — the detector's numbers were taken. `coarse` — they were not (too little
   * confidence, or the stage failed), so these are the download estimate. `derived` — read back
   * out of an already-generated .kdenlive by `npm run sync-status` (see syncStatusCli.ts).
   */
  source: "countdown" | "coarse" | "derived";
}

export const syncFilePath = (matchDir: string): string => path.join(matchDir, "sync.json");

export function writeSyncOffsets(matchDir: string, offsets: SyncOffsets): void {
  writeFileSync(syncFilePath(matchDir), `${JSON.stringify(offsets, null, 2)}\n`);
}

/** Null when the file is missing, unparsable, or does not carry two usable offsets. */
export function readSyncOffsets(matchDir: string): SyncOffsets | null {
  const file = syncFilePath(matchDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SyncOffsets;
    // A half-written or hand-edited file must degrade to "no sync data" rather than place a
    // clip at NaN, which ffmpeg accepts and renders as a black frame.
    return Number.isFinite(parsed.left) && Number.isFinite(parsed.right) ? parsed : null;
  } catch {
    return null;
  }
}
