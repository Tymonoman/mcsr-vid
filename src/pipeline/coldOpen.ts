import { spawn } from "node:child_process";
import { existsSync, linkSync, renameSync, rmSync, statSync, unlinkSync, utimesSync } from "node:fs";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { arrivals, decidedAtMs } from "../shorts/raceGap.js";
import { concatVideos, probeDuration } from "../playoffs/series.js";
import { exportOutputPath, readExportRecord, writeExportRecord, type ExportRecord } from "./exportFast.js";

/**
 * The cold open (retention opening, approved 19 Oct 2026): a few seconds of the race's closest
 * mid-race split in front of the video, in the normal layout — both POVs, the stats band, the
 * splits and the timer — with the saved title hook big at the top. A promise the race keeps.
 *
 * Two steps, because the title exists only once the hooks are saved and the render runs before:
 * `export:fast` chooses the moment (`chooseColdOpen`, recorded in `final-<id>.json`); when the
 * hooks are saved, before the long-form uploads, `export:fast --cold-open=<hook>` encodes the
 * window with the export's own encoder and `joinColdOpen` puts it in front with the concat demuxer
 * (`-c copy`, as a series joins its games). The export without it stays beside it as
 * `final-<id>.base.mp4` until the upload, so a changed hook rebuilds from it instead of stacking.
 *
 * The moment is mid-race only: never in the first minute, never in the minute before the game is
 * decided (`decidedAtMs`), and only where the two arrived at a split at most 5 s apart — a "close
 * race" promise on a blowout teaches the viewer the video lies. None qualifies, no cold open.
 */
export const COLD_OPEN_MAX_GAP_MS = 5000;
export const COLD_OPEN_EARLIEST_MS = 60_000;
export const COLD_OPEN_BEFORE_DECIDED_MS = 60_000;

/** The closest qualifying split, `sec` long and centred on its two arrivals, or null. */
export function chooseColdOpen(match: MatchInfo, sec: number): { fromMs: number; sec: number } | null {
  const decided = decidedAtMs(match);
  if (decided === null) return null;
  let best: { fromMs: number; gap: number } | null = null;
  for (const { left, right } of arrivals(match)) {
    if (left === undefined || right === undefined) continue;
    const gap = Math.abs(left - right);
    const fromMs = Math.round((left + right) / 2 - sec * 500);
    if (gap > COLD_OPEN_MAX_GAP_MS || fromMs < COLD_OPEN_EARLIEST_MS) continue;
    if (fromMs + sec * 1000 > decided - COLD_OPEN_BEFORE_DECIDED_MS) continue;
    if (!best || gap < best.gap) best = { fromMs, gap };
  }
  return best ? { fromMs: best.fromMs, sec } : null;
}

/** The export as it was before a cold open was joined in front of it. */
export const baseExportPath = (outDir: string, matchId: number): string =>
  path.join(outDir, `final-${matchId}.base.mp4`);

/** Every stream's parameters that `-c copy` needs equal, the SPS/PPS (extradata) included. */
export async function probeStreams(file: string): Promise<string[]> {
  const out = await new Promise<string>((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_data_hash",
        "SHA256",
        "-show_entries",
        "stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,time_base,sample_rate,channels,extradata_hash",
        "-of",
        "json",
        file,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let text = "";
    proc.stdout.on("data", (d: Buffer) => (text += d.toString()));
    proc.on("error", reject);
    proc.on("close", () => resolve(text));
  });
  const streams = (JSON.parse(out || "{}") as { streams?: Record<string, unknown>[] }).streams ?? [];
  return streams.map((s) => JSON.stringify(s));
}

export interface JoinDeps {
  probe: (file: string) => Promise<string[]>;
  join: (files: readonly string[], outPath: string) => Promise<void>;
  duration: (file: string) => Promise<number>;
}
const liveDeps: JoinDeps = { probe: probeStreams, join: concatVideos, duration: probeDuration };

/**
 * Undo a joined cold open: the base back as `final-<id>.mp4` (its own mtime with it, so
 * `exportStale` reads it as before) and the record without the cold open. No-op without one.
 */
export function restoreColdOpen(outDir: string, matchId: number): ExportRecord | null {
  const record = readExportRecord(outDir, matchId);
  if (!record || record.coldOpenSec === undefined) return record;
  const base = baseExportPath(outDir, matchId);
  if (!existsSync(base))
    throw new Error(`the cold open's base export (${path.basename(base)}) is gone — export the match again`);
  renameSync(base, exportOutputPath(outDir, matchId));
  const { coldOpenSec, coldOpenHook: _hook, ...rest } = record;
  const restored = { ...rest, matchStartSec: Math.round((record.matchStartSec - coldOpenSec) * 1000) / 1000 };
  writeExportRecord(outDir, matchId, restored);
  return restored;
}

/**
 * Put `segment` (the cold open, already encoded) in front of the export with `-c copy`, once:
 * a record that already carries a cold open is refused (`restoreColdOpen` first). Refuses a
 * segment whose streams differ from the export's in anything `-c copy` needs equal. The joined
 * file keeps the base's mtime, so a sync fix made after the export still reads as stale.
 */
export async function joinColdOpen(
  outDir: string,
  matchId: number,
  segment: string,
  hook: string,
  deps: JoinDeps = liveDeps,
): Promise<ExportRecord> {
  const record = readExportRecord(outDir, matchId);
  if (!record) throw new Error(`no export record (final-${matchId}.json) — export the match first`);
  if (record.coldOpenSec !== undefined) throw new Error("the export already has a cold open in front");
  const final = exportOutputPath(outDir, matchId);
  const [mine, theirs] = await Promise.all([deps.probe(segment), deps.probe(final)]);
  if (mine.length === 0 || JSON.stringify(mine) !== JSON.stringify(theirs))
    throw new Error(
      `the cold open's streams differ from the export's, so -c copy cannot join them:\n  cold open: ${mine.join(" ")}\n  export:    ${theirs.join(" ")}`,
    );
  const sec = Math.round((await deps.duration(segment)) * 1000) / 1000;
  if (!(sec > 0)) throw new Error("the cold open has no length");
  // `.part.` in the name: nothing takes it for the deliverable while it is written.
  const joined = path.join(outDir, `final-${matchId}.cold.part.mp4`);
  await deps.join([segment, final], joined);
  rmSync(`${joined}.txt`, { force: true }); // concatVideos' list file
  const base = baseExportPath(outDir, matchId);
  const { mtime, atime } = statSync(final);
  if (existsSync(base)) unlinkSync(base);
  // A second name for the export, then the joined file over the first: never a moment without one.
  linkSync(final, base);
  renameSync(joined, final);
  utimesSync(final, atime, mtime);
  const next: ExportRecord = {
    ...record,
    matchStartSec: Math.round((record.matchStartSec + sec) * 1000) / 1000,
    coldOpenSec: sec,
    coldOpenHook: hook,
  };
  writeExportRecord(outDir, matchId, next);
  return next;
}
