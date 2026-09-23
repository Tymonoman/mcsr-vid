/**
 * The /watch skill (the claude-watch plugin's `watch.py`, `config.watchScript`) run on each
 * player's own POV clip, for the Short's picker: 100 stills of the match at 512 px — against the
 * picker's proxy, where each POV is a quarter of a 640x360 frame, enough to read hearts, a hotbar
 * or a stream's alerts — and the stream's speech, when watch.py has a Whisper key.
 *
 * The window is the match: from sync.json's offset (the second of the clip where RTA 0:00 falls)
 * through the run's end, so clip time t is match time t − offset. watch.py is always given
 * --start/--end/--fps, which is its uniform sampler; ffmpeg's fps filter hands slot i the last
 * frame before (i + ½)/fps, so a still is half an interval later than the t= watch.py prints
 * beside it (2.7 s at 100 stills over 8:55 — read off a streamer's timer, 13473906, 23 Sept 2026).
 * The times here are computed from the index instead.
 *
 * Files, in the match's directory: `short-watch-<side>/` is watch.py's own out dir (frames/,
 * report.md) plus `watch.json`, the parsed result and the arguments it was run with. A
 * `watch.json` newer than the clip and made with the same arguments is the answer.
 *
 * Nothing here may fail a pick: every failure drops that POV's input and logs why. Only an abort
 * rejects.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { povClipPath } from "../pipeline/syncEdit.js";
import { readSyncOffsets } from "../pipeline/syncFile.js";
import { runMsOf } from "./shortMoment.js";

export interface PovWatch {
  side: "left" | "right";
  /** watch.py's stills, in order, on the match clock. */
  frames: Array<{ path: string; matchSec: number }>;
  /** The stream's speech on the match clock; null when watch.py had no Whisper key or heard nothing. */
  transcript: Array<{ matchSec: number; text: string }> | null;
  /** What watch.py said it did (frames, transcript source) and anything this module decided. */
  notes: string[];
}

export const watchDir = (dir: string, side: PovWatch["side"]): string =>
  path.join(dir, `short-watch-${side}`);

const MAX_FRAMES = 100;
/** The finish and the frame after it, as the picker allows a window to run. */
const RUN_SLACK_SEC = 3;
/** One POV's 9 minutes of 1080p60 took 128 s at nice 19 on the lab's 4 cores under load 5. */
const WATCH_TIMEOUT_MS = 15 * 60_000;

/** Whether watch.py will find a Whisper key where it looks: the environment, then its own .env. */
function whisperKey(): boolean {
  if (process.env.GROQ_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()) return true;
  try {
    const env = readFileSync(path.join(os.homedir(), ".config/watch/.env"), "utf8");
    return /^\s*(GROQ|OPENAI)_API_KEY\s*=\s*["']?[^\s"']/m.test(env);
  } catch {
    return false;
  }
}

/** watch.py to completion: its stdout, or a rejection naming the last thing it said. */
function runWatch(args: string[], signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a stop takes the ffmpeg it runs with it.
    const proc = spawn("nice", ["-n", "19", "python3", ...args], { detached: true, stdio: "pipe" });
    let stdout = "";
    let tail = "";
    const kill = () => {
      try {
        process.kill(-proc.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      kill();
      tail = `timed out after ${WATCH_TIMEOUT_MS / 60_000} min`;
    }, WATCH_TIMEOUT_MS);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (tail = (tail + d.toString()).slice(-1000)));
    proc.on("error", (err) => (tail = err.message));
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve(stdout);
      else reject(new Error(`watch.py exited ${code}: ${tail.trim().split("\n").pop() ?? ""}`));
    });
  });
}

/** "11:24" or "1:02:03" → seconds. */
const seconds = (clock: string): number => clock.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);

/**
 * watch.py's stdout, its report in markdown, on the match clock. `offsetSec` (its --start) and
 * `fps` are what it was run with; the stills are timed from their index (see the file comment),
 * the transcript from its `[mm:ss]` stamps (whole seconds of the clip).
 */
export function parseWatchOutput(
  stdout: string,
  run: { side: PovWatch["side"]; offsetSec: number; fps: number; endSec: number },
): PovWatch {
  const [head = "", transcriptPart = ""] = stdout.split(/^## Transcript$/m);
  const frames = [...head.matchAll(/^- `(.+\.jpg)` \(t=[\d:]+\)$/gm)].map((m, i) => ({
    path: m[1]!,
    matchSec: Math.round(((i + 0.5) / run.fps) * 10) / 10,
  }));
  const lines = [...transcriptPart.matchAll(/^\[(\d+:\d{2})\] (.+)$/gm)]
    .map((m) => ({ matchSec: Math.max(0, seconds(m[1]!) - run.offsetSec), text: m[2]!.trim() }))
    .filter((l) => l.matchSec <= run.endSec && l.text !== "");
  const notes = [...head.matchAll(/^- \*\*(Frames|Transcript):\*\* (.+)$/gm)].map((m) => `${m[1]}: ${m[2]}`);
  return { side: run.side, frames, transcript: lines.length > 0 ? lines : null, notes };
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFile(`${file}.part`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(`${file}.part`, file);
}

/** One POV: the cached result, a fresh run, or null and a log line saying why there is none. */
async function watchOne(
  match: MatchInfo,
  side: PovWatch["side"],
  script: string,
  signal: AbortSignal | undefined,
  log: (line: string) => void,
): Promise<PovWatch | null> {
  const dir = matchDir(match.id);
  const nick = match.players[side === "left" ? 0 : 1]?.nickname;
  const clip = nick ? povClipPath(dir, nick) : null;
  if (!clip || !existsSync(clip)) {
    log(`watch ${side}: no clip (${clip ?? "no player"}) — skipped`);
    return null;
  }
  const sync = readSyncOffsets(dir);
  const offsetSec = sync?.[side] ?? config.preRollSec;
  const endSec = runMsOf(match) / 1000 + RUN_SLACK_SEC;
  const fps = Math.min(2, MAX_FRAMES / endSec);
  const out = watchDir(dir, side);
  const notes = sync ? [] : [`no sync.json: the clip placed at preRollSec ${config.preRollSec} s`];
  const whisper = whisperKey();
  if (!whisper) notes.push("--no-whisper: no GROQ_API_KEY or OPENAI_API_KEY");
  // prettier-ignore
  const args = [
    script, clip,
    "--start", offsetSec.toFixed(3), "--end", (offsetSec + endSec).toFixed(3), "--fps", String(fps),
    "--max-frames", String(MAX_FRAMES), "--resolution", "512", "--no-hook-microscope",
    "--out-dir", out, ...(whisper ? [] : ["--no-whisper"]),
  ];

  const cacheFile = path.join(out, "watch.json");
  if (existsSync(cacheFile) && statSync(cacheFile).mtimeMs > statSync(clip).mtimeMs) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as PovWatch & { args: string[] };
      if (JSON.stringify(cached.args) === JSON.stringify(args)) {
        const { args: _args, ...watched } = cached;
        log(`watch ${side}: ${path.relative(dir, cacheFile)} is newer than ${nick}.mp4 — kept`);
        return watched;
      }
    } catch {
      // Unreadable: watch again.
    }
  }
  const started = Date.now();
  log(`watch ${side}: ${nick}.mp4 ${offsetSec.toFixed(1)}–${(offsetSec + endSec).toFixed(1)} s (nice 19)`);
  const parsed = parseWatchOutput(await runWatch(args, signal), {
    side,
    offsetSec,
    fps,
    endSec,
  });
  if (parsed.frames.length === 0) throw new Error("watch.py listed no frames");
  const watched = { ...parsed, notes: [...parsed.notes, ...notes] };
  await writeJsonAtomic(cacheFile, { ...watched, args });
  log(
    `watch ${side}: ${watched.frames.length} stills, ${watched.transcript?.length ?? "no"} transcript lines in ${Math.round((Date.now() - started) / 1000)} s`,
  );
  return watched;
}

/**
 * /watch on both players' clips of one game, one after the other (each is a full decode of the
 * clip). What failed is left out and logged; an abort rejects.
 */
export async function watchPovs(
  match: MatchInfo,
  opts: { signal?: AbortSignal; log?: (line: string) => void } = {},
): Promise<PovWatch[]> {
  const log = opts.log ?? (() => {});
  const script = config.watchScript;
  if (!script) return [];
  if (!existsSync(script)) {
    log(`watch: ${script} not found — the pick goes on without /watch`);
    return [];
  }
  const out: PovWatch[] = [];
  for (const side of ["left", "right"] as const) {
    opts.signal?.throwIfAborted();
    try {
      const watched = await watchOne(match, side, script, opts.signal, log);
      if (watched) out.push(watched);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      log(`watch ${side}: ${describeError(err)} — the pick goes on without it`);
    }
  }
  return out;
}
