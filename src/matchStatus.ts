import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { describeError } from "./errorText.js";
import { getMatch } from "./mcsrApi.js";
import { SPLITS_MANIFEST } from "./overlayRender.js";
import type { StageId } from "./pipeline.js";

export interface MatchStatusEntry {
  matchId: number;
  leftNickname: string;
  rightNickname: string;
  stages: Record<StageId, boolean>;
  /** Path to the .kdenlive file if it exists, else null. */
  projectPath: string | null;
  /**
   * Why this entry is degraded, or null when it is fully trustworthy. Set when the MCSR API
   * lookup failed: nicknames then come off the downloaded filenames and their left/right order
   * is a guess. Without this the caller could not tell a stage that has not run from one whose
   * status could not be determined — both used to render identically.
   */
  error: string | null;
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
  return Promise.all(listProcessedMatchIds().map(matchStatusFor));
}

/**
 * One match's status, costing exactly one API request.
 *
 * Split out of `listMatchStatuses` because the dashboard's `GET /api/meta/:id` only ever wanted
 * two nicknames, and going through the list meant one request per *existing match directory*
 * on every metadata read — a linear tax on an API budgeted at 500 requests per 10 minutes.
 */
export async function matchStatusFor(matchId: number): Promise<MatchStatusEntry> {
  const outDir = path.join(config.mediaDir, String(matchId));

  // Read from disk first so the answer survives the API being down. The pipeline names each
  // clip `<nickname>.mp4`, so the files alone tell us the VODs are there — the API is only
  // needed to say which of the two is players[0].
  const downloadedNicknames = existsSync(outDir)
    ? readdirSync(outDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".mp4"))
        .map((entry) => entry.name.slice(0, -".mp4".length))
        .sort()
    : [];

  let leftNickname = "?";
  let rightNickname = "?";
  let vodsDownloaded = false;
  let error: string | null = null;
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
  } catch (err) {
    // Previously a bare `catch {}`: nicknames silently became "?" and download/sync were
    // forced to false even with both VODs sitting on disk, so an unreachable API was
    // indistinguishable from an unstarted match. Report both the degradation and what we
    // can still establish locally.
    error = describeError(err);
    vodsDownloaded = downloadedNicknames.length >= 2;
    [leftNickname = "?", rightNickname = "?"] = downloadedNicknames;
  }

  const projectFilePath = path.join(outDir, `match-${matchId}.kdenlive`);
  const hasProject = existsSync(projectFilePath);

  // "fetch" has no durable artifact of its own — the dir existing means it ran once.
  // "sync" doesn't produce a file either; it's a pass-through check keyed on the VODs
  // it consumes, so it's "done" exactly when both VODs are (matching pipeline.ts's treatment).
  const stages: Record<StageId, boolean> = {
    fetch: existsSync(outDir),
    download: vodsDownloaded,
    sync: vodsDownloaded,
    // All four, matching pipeline.ts's skip condition. Checking only the video let a match
    // report render:true and then re-render anyway, because the pipeline also wants the top
    // band, the intro card and the split stills before it will reuse the stage. The manifest
    // is written last and only once every still exists, so it stands in for all of them.
    render:
      existsSync(path.join(outDir, "overlay-timer.mp4")) &&
      existsSync(path.join(outDir, "overlay-top.png")) &&
      existsSync(path.join(outDir, "overlay-intro.webm")) &&
      existsSync(path.join(outDir, SPLITS_MANIFEST)),
    thumbnail: existsSync(path.join(outDir, "thumbnail.png")),
    write: hasProject,
  };

  return {
    matchId,
    leftNickname,
    rightNickname,
    stages,
    projectPath: hasProject ? path.resolve(projectFilePath) : null,
    error,
  };
}
