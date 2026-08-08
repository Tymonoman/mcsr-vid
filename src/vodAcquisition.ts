import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { MatchInfo, MatchVod } from "./types.js";

const PRE_ROLL_SEC = 150; // buffer before the estimated match start, for the sync step to search within
const POST_ROLL_SEC = 60; // buffer after the estimated match end
const DEFAULT_RUN_SEC = 900; // fallback when result.time is missing/zero (e.g. forfeits)

export interface VodWindow {
  playerUuid: string;
  playerNickname: string;
  sourceUrl: string;
  path: string;
  /** Seconds into the *original* VOD where the match is estimated to start (date - vod.startsAt). */
  matchOffsetIntoVodSec: number;
  /** Seconds into the *downloaded clip* where the match is estimated to start. */
  matchOffsetIntoClipSec: number;
}

function estimatedRunSec(match: MatchInfo): number {
  return match.result.time > 0 ? match.result.time / 1000 : DEFAULT_RUN_SEC;
}

function runYtDlp(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited with code ${code} (args: ${args.join(" ")})`));
    });
  });
}

/** Downloads a trimmed window of one player's VOD around the match, without pulling the full broadcast. */
export async function downloadVodWindow(
  match: MatchInfo,
  vod: MatchVod,
  outDir: string,
): Promise<VodWindow> {
  const player = match.players.find((p) => p.uuid === vod.uuid);
  const playerNickname = player?.nickname ?? vod.uuid;

  // `date` is the match's *completion* timestamp (verified against real footage: the on-screen
  // result time at `date - vod.startsAt` matches `result.time` exactly), not its start — so the
  // start has to be derived by subtracting the run duration.
  const matchEndIntoVodSec = match.date - vod.startsAt;
  const runSec = estimatedRunSec(match);
  const matchStartIntoVodSec = matchEndIntoVodSec - runSec;
  const windowStartSec = Math.max(0, matchStartIntoVodSec - PRE_ROLL_SEC);
  const windowEndSec = matchEndIntoVodSec + POST_ROLL_SEC;
  const matchOffsetIntoClipSec = matchStartIntoVodSec - windowStartSec;

  await mkdir(outDir, { recursive: true });
  const outputTemplate = path.join(outDir, `${playerNickname}.%(ext)s`);

  await runYtDlp([
    "--download-sections",
    `*${windowStartSec}-${windowEndSec}`,
    "-f",
    "bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "--no-part",
    "--force-overwrites",
    "-o",
    outputTemplate,
    vod.url,
  ]);

  return {
    playerUuid: vod.uuid,
    playerNickname,
    sourceUrl: vod.url,
    path: path.join(outDir, `${playerNickname}.mp4`),
    matchOffsetIntoVodSec: matchStartIntoVodSec,
    matchOffsetIntoClipSec,
  };
}

/** Downloads trimmed windows for every vod attached to the match. Matches may have 0, 1, or 2 vod entries. */
export async function downloadMatchVods(match: MatchInfo, outDir: string): Promise<VodWindow[]> {
  const results: VodWindow[] = [];
  for (const vod of match.vod) {
    results.push(await downloadVodWindow(match, vod, outDir));
  }
  return results;
}
