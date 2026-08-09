import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { MatchInfo, MatchVod } from "./types.js";

// Shared with renderOverlay.ts so the overlay clip uses the same windowing convention as the VODs.
export const PRE_ROLL_SEC = 150; // buffer before the estimated match start, for the sync step to search within
export const POST_ROLL_SEC = 60; // buffer after the estimated match end
export const DEFAULT_RUN_SEC = 900; // fallback when result.time is missing/zero (e.g. forfeits)

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

export function estimatedRunSec(match: MatchInfo): number {
  return match.result.time > 0 ? match.result.time / 1000 : DEFAULT_RUN_SEC;
}

export interface RunOpts {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/** Parses a percent out of a `yt-dlp --newline` progress line, e.g. `[download]  45.2% of ...`. */
export function parseYtDlpPercent(line: string): number | null {
  const m = /\[download\]\s+([\d.]+)%/.exec(line);
  return m ? parseFloat(m[1]!) : null;
}

function runYtDlp(args: string[], opts: RunOpts = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const finalArgs = opts.onProgress ? [...args, "--newline"] : args;
    const proc = spawn("yt-dlp", finalArgs, {
      stdio: opts.onProgress ? ["ignore", "pipe", "inherit"] : "inherit",
      signal: opts.signal,
    });
    if (opts.onProgress) {
      let buf = "";
      proc.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const percent = parseYtDlpPercent(line);
          if (percent !== null) opts.onProgress!(percent);
        }
      });
    }
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
  opts: RunOpts = {},
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

  await runYtDlp(
    [
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
    ],
    opts,
  );

  return {
    playerUuid: vod.uuid,
    playerNickname,
    sourceUrl: vod.url,
    path: path.join(outDir, `${playerNickname}.mp4`),
    matchOffsetIntoVodSec: matchStartIntoVodSec,
    matchOffsetIntoClipSec,
  };
}

export interface DownloadProgress {
  index: number;
  total: number;
  playerNickname: string;
  percent: number;
}

/** Downloads trimmed windows for every vod attached to the match. Matches may have 0, 1, or 2 vod entries. */
export async function downloadMatchVods(
  match: MatchInfo,
  outDir: string,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<VodWindow[]> {
  const results: VodWindow[] = [];
  const total = match.vod.length;
  for (let i = 0; i < total; i++) {
    const vod = match.vod[i]!;
    const nickname = match.players.find((p) => p.uuid === vod.uuid)?.nickname ?? vod.uuid;
    results.push(
      await downloadVodWindow(match, vod, outDir, {
        signal,
        onProgress:
          onProgress && ((percent) => onProgress({ index: i, total, playerNickname: nickname, percent })),
      }),
    );
  }
  return results;
}
