import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
   * `manual` — a human matched the two countdowns in the dashboard's sync editor, which outranks
   * every other source and is never overwritten by a re-run.
   */
  source: "countdown" | "coarse" | "derived" | "manual";
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

/**
 * Whether `sync.json` was written after the finished export was — in which case the export
 * placed the clips by numbers the operator has since corrected, and uploading it publishes the
 * misalignment the correction was for. One video reached the channel exactly that way. Pure mtime
 * arithmetic: the export reads the file at its start, so a newer file is a newer decision.
 * `syncAt` is null when there is no sync.json, which is never stale.
 *
 * ponytail: a save made *during* an encode lands before the encode's rename and reads as fresh;
 * compare against the export job's start time if that ever bites.
 */
export function exportStale(
  matchDir: string,
  videoPath: string,
): { stale: boolean; syncAt: Date | null; exportAt: Date } {
  const exportAt = statSync(videoPath).mtime;
  const file = syncFilePath(matchDir);
  const syncAt = existsSync(file) ? statSync(file).mtime : null;
  return { stale: syncAt !== null && syncAt.getTime() > exportAt.getTime(), syncAt, exportAt };
}

/** The one refusal, worded once: the upload, the nightly's skip line and the adopt route all say it. */
export const staleExportMessage = (matchId: number): string =>
  `sync changed after this export — re-export first (npm run export:fast -- ${matchId})`;
