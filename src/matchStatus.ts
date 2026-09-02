import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { getMatch } from "./mcsrApi.js";
import type { StageId } from "./pipeline.js";

export interface MatchStatusEntry {
  matchId: number;
  leftNickname: string;
  rightNickname: string;
  stages: Record<StageId, boolean>;
  /** Path to the .kdenlive file if it exists, else null. */
  projectPath: string | null;
}

/**
 * Scans `<config.mediaDir>/*` for match working directories and reports, per match,
 * which pipeline stages have already produced their cache-marker file — the same
 * files `runPipeline` (src/pipeline.ts) checks via `existsSync` to skip/reuse a stage.
 */
/**
 * Match ids that already have a working directory, ascending. Purely a directory
 * listing — no API calls — so it is safe to call on a hot path such as filtering
 * suggestions. Use this rather than `listMatchStatuses()` when all you need is "have I
 * touched this match before?": that function fires one API request per match.
 */
export function listProcessedMatchIds(): number[] {
  if (!existsSync(config.mediaDir)) return [];
  return readdirSync(config.mediaDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b);
}

export async function listMatchStatuses(): Promise<MatchStatusEntry[]> {
  const matchIds = listProcessedMatchIds();

  return Promise.all(
    matchIds.map(async (matchId): Promise<MatchStatusEntry> => {
      const outDir = path.join(config.mediaDir, String(matchId));

      let leftNickname = "?";
      let rightNickname = "?";
      let vodsDownloaded = false;
      try {
        const match = await getMatch(matchId);
        const [playerLeft, playerRight] = match.players;
        leftNickname = playerLeft?.nickname ?? "?";
        rightNickname = playerRight?.nickname ?? "?";
        vodsDownloaded =
          !!playerLeft &&
          !!playerRight &&
          existsSync(path.join(outDir, `${playerLeft.nickname}.mp4`)) &&
          existsSync(path.join(outDir, `${playerRight.nickname}.mp4`));
      } catch {
        // Match API unreachable/gone; fall back to nicknames "?" and download/sync unknown (false).
      }

      const projectFilePath = path.join(outDir, `match-${matchId}.kdenlive`);
      const hasProject = existsSync(projectFilePath);

      // "fetch" has no durable artifact of its own — the dir existing means it ran once.
      // "sync" doesn't produce a file either; it's a pass-through check keyed on the VODs
      // it consumes, so it's "done" exactly when both VODs are (matching pipeline.ts's treatment).
      const stages: Record<StageId, boolean> = {
        fetch: true,
        download: vodsDownloaded,
        sync: vodsDownloaded,
        render: existsSync(path.join(outDir, "overlay.mov")),
        thumbnail: existsSync(path.join(outDir, "thumbnail.png")),
        write: hasProject,
      };

      return {
        matchId,
        leftNickname,
        rightNickname,
        stages,
        projectPath: hasProject ? path.resolve(projectFilePath) : null,
      };
    }),
  );
}
