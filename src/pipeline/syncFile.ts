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
): { stale: boolean; syncAt: Date | null; exportAt: Date; staleMatchId: number | null } {
  const exportAt = statSync(videoPath).mtime;
  const syncAtOf = (dir: string): Date | null => {
    const file = syncFilePath(dir);
    return existsSync(file) ? statSync(file).mtime : null;
  };
  // The series rule applies to the series video only: game 1's own export, asked about by its
  // own name, is one game like any other.
  const games = path.basename(videoPath).startsWith("series-") ? seriesGames(matchDir) : [];
  if (games.length === 0) {
    const syncAt = syncAtOf(matchDir);
    const stale = syncAt !== null && syncAt.getTime() > exportAt.getTime();
    return { stale, syncAt, exportAt, staleMatchId: stale ? Number(path.basename(matchDir)) || null : null };
  }
  // A series video (src/playoffs/series.ts) is every game's export: a game whose sync moved after its
  // own export is the one to re-export, and a game re-exported after the join wants the join
  // redone — which `staleMatchId: null` says, so the message can name the right command.
  let newestSync: Date | null = null;
  for (const g of games) {
    const syncAt = syncAtOf(g.dir);
    if (syncAt && (newestSync === null || syncAt > newestSync)) newestSync = syncAt;
    // A game's export lives in the series once the join has deleted it (src/playoffs/series.ts), so
    // the series' own time is what its sync is measured against then.
    const ref = existsSync(g.final) ? statSync(g.final).mtime : exportAt;
    if (syncAt && syncAt.getTime() > ref.getTime())
      return { stale: true, syncAt, exportAt, staleMatchId: g.matchId };
  }
  const rejoin = games.some(
    (g) => existsSync(g.final) && statSync(g.final).mtime.getTime() > exportAt.getTime(),
  );
  return { stale: rejoin, syncAt: newestSync, exportAt, staleMatchId: null };
}

/** The games a series record in `matchDir` names — their directories and exports — or none. */
function seriesGames(matchDir: string): Array<{ matchId: number; dir: string; final: string }> {
  const file = path.join(matchDir, "series.json");
  if (!existsSync(file)) return [];
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as { games?: Array<{ matchId: number }> };
    return (record.games ?? []).map((g) => {
      const dir = path.join(path.dirname(matchDir), String(g.matchId));
      return { matchId: g.matchId, dir, final: path.join(dir, `final-${g.matchId}.mp4`) };
    });
  } catch {
    return [];
  }
}

/**
 * The one refusal, worded once: the upload, the nightly's skip line and the adopt route all say
 * it. `staleMatchId` is `exportStale`'s: the game of a series whose export is behind its sync,
 * or null when the games are fine and the series itself is behind them.
 */
export const staleExportMessage = (matchId: number, staleMatchId: number | null = matchId): string =>
  staleMatchId === null
    ? `a game was re-exported after the series was joined — re-join it (npm run series -- ${matchId} --join-only)`
    : staleMatchId === matchId
      ? `sync changed after this export — re-export first (npm run export:fast -- ${matchId})`
      : `sync of game #${staleMatchId} changed after its export — re-export that game first (npm run export:fast -- ${staleMatchId}); the series re-joins itself`;
