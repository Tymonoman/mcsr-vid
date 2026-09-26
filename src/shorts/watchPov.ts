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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { povClipPath } from "../pipeline/syncEdit.js";
import { readSyncOffsets } from "../pipeline/syncFile.js";
import { watchFraction } from "./pickProgress.js";
import { boxFailure, type LogExtra } from "./shortLog.js";
import { runMsOf } from "./shortMoment.js";

/** A line of the pick's story (videoPick.ts writes it to the match's Short log). */
type Log = (line: string, extra?: LogExtra) => void;

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

/** A failed run: `message` in the operator's words, `detail` what watch.py last said. */
class WatchFailure extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

/**
 * What a failed watch.py run means, from its exit and its stderr's tail: the box's own failures
 * (python3 or ffmpeg missing, the disk full, the memory cap), the time limit, or its last line.
 */
export function watchFailure(
  code: number | null,
  tail: string,
  timedOut = false,
  signal: string | null = null,
): string {
  if (timedOut) return `watch.py ran over ${WATCH_TIMEOUT_MS / 60_000} min and was stopped`;
  const box = boxFailure("/watch", tail, { code, signal });
  if (box) return box;
  if (/ffmpeg is not installed/.test(tail)) return "/watch failed: ffmpeg is not installed in this container";
  if (code === 127) return "/watch failed: python3 is not installed in this container";
  return `watch.py exited ${code}: ${tail.trim().split("\n").pop() ?? ""}`;
}

/**
 * Why a POV has no transcript, or null when it has one. watch.py survives a Whisper failure — it
 * prints "[watch] whisper fallback failed: …" and goes on with the stills — so the reason is in
 * its stderr, not its exit. `transient`: worth another run next time (not cached).
 */
export function transcriptProblem(
  stderr: string,
  whisper: boolean,
  lines: number,
): { text: string; transient: boolean } | null {
  if (lines > 0) return null;
  if (!whisper)
    return {
      text: "no transcript — no GROQ_API_KEY (add it to /app/.env for the streamers' speech)",
      transient: false,
    };
  const failed = /whisper fallback failed: (.*)/.exec(stderr)?.[1]?.trim();
  if (!failed) return { text: "no transcript — Whisper heard no speech in the match", transient: false };
  if (/\b401\b|unauthori[sz]ed|invalid.api.key/i.test(failed))
    return {
      text: "no transcript — Groq refused the key (401): replace GROQ_API_KEY in /app/.env (console.groq.com → API Keys)",
      transient: true,
    };
  if (/\b429\b|rate.?limit|too many requests/i.test(failed))
    return {
      text: "no transcript — Groq rate-limited the transcription (429); the next pick tries again",
      transient: true,
    };
  if (/no audio/i.test(failed))
    return { text: "no transcript — the clip has no audio track", transient: false };
  return { text: `no transcript — Whisper failed: ${failed}`, transient: true };
}

/**
 * watch.py to completion: its stdout and stderr, or a `WatchFailure`. `poll` is handed its stderr
 * so far on every line and once a second (the stills land in silence).
 */
function runWatch(
  args: string[],
  signal: AbortSignal | undefined,
  poll: (stderr: string) => void = () => {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a stop takes the ffmpeg it runs with it.
    const proc = spawn("nice", ["-n", "19", "python3", ...args], { detached: true, stdio: "pipe" });
    let stdout = "";
    let tail = "";
    let timedOut = false;
    const kill = () => {
      try {
        process.kill(-proc.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, WATCH_TIMEOUT_MS);
    const ticker = setInterval(() => poll(tail), 1000);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => {
      tail = (tail + d.toString()).slice(-4000);
      poll(tail);
    });
    proc.on("error", (err) => (tail += `\n${err.message}`));
    proc.on("close", (code, sig) => {
      clearTimeout(timer);
      clearInterval(ticker);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0 && !timedOut) resolve({ stdout, stderr: tail });
      else reject(new WatchFailure(watchFailure(code, tail, timedOut, sig), tail.trim()));
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
  log: Log,
  progress: (fraction: number) => void,
): Promise<PovWatch | null> {
  const dir = matchDir(match.id);
  const nick = match.players[side === "left" ? 0 : 1]?.nickname;
  const clip = nick ? povClipPath(dir, nick) : null;
  if (!clip || !existsSync(clip)) {
    log(
      `/watch skipped on the ${side} POV: no clip on disk (${clip ?? "no player"}) — npm run download-vods -- ${match.id} fetches it while the VOD lasts`,
      { level: "warn" },
    );
    return null;
  }
  const sync = readSyncOffsets(dir);
  const offsetSec = sync?.[side] ?? config.preRollSec;
  const endSec = runMsOf(match) / 1000 + RUN_SLACK_SEC;
  const fps = Math.min(2, MAX_FRAMES / endSec);
  const out = watchDir(dir, side);
  const notes = sync ? [] : [`no sync.json: the clip placed at preRollSec ${config.preRollSec} s`];
  if (!sync && side === "left")
    log(
      `no sync.json for #${match.id}: the stills are placed by the coarse estimate and may sit seconds off — npm run sync-status -- ${match.id}`,
      { level: "warn" },
    );
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
        log(`/watch on ${nick}'s stream is up to date — kept (${watched.frames.length} stills)`);
        return watched;
      }
    } catch {
      // Unreadable: watch again.
    }
  }
  const started = Date.now();
  log(`running /watch on ${nick}'s stream (${side}, ${Math.round(endSec)} s of match, nice 19)`);
  const framesOnDisk = () => {
    try {
      return readdirSync(path.join(out, "frames")).filter((f) => /^frame_\d+\.jpg$/.test(f)).length;
    } catch {
      return 0;
    }
  };
  const run = await runWatch(args, signal, (stderr) =>
    progress(watchFraction(stderr, framesOnDisk(), MAX_FRAMES)),
  );
  const parsed = parseWatchOutput(run.stdout, { side, offsetSec, fps, endSec });
  if (parsed.frames.length === 0) throw new WatchFailure("watch.py listed no frames", run.stderr.trim());
  const missing = transcriptProblem(run.stderr, whisper, parsed.transcript?.length ?? 0);
  // Without a key the --no-whisper note already says why.
  const watched = {
    ...parsed,
    notes: [...parsed.notes, ...notes, ...(missing && whisper ? [missing.text] : [])],
  };
  // A Whisper failure that may pass (a rate limit, a key since fixed) is not kept: the next pick
  // runs /watch again rather than inheriting the missing transcript.
  if (!missing?.transient) await writeJsonAtomic(cacheFile, { ...watched, args });
  const secs = Math.round((Date.now() - started) / 1000);
  log(
    `/watch on ${nick}: ${watched.frames.length} stills, ${missing ? missing.text : `transcript: ${watched.transcript!.length} lines`} (${secs} s)`,
    missing?.transient ? { level: "warn", detail: run.stderr.trim() } : {},
  );
  return watched;
}

/**
 * /watch on both players' clips of one game, one after the other (each is a full decode of the
 * clip). What failed is left out and logged; an abort rejects.
 */
export async function watchPovs(
  match: MatchInfo,
  opts: {
    signal?: AbortSignal;
    log?: Log;
    /** How far each POV's run is, 0–1 (pickProgress.ts `watchFraction`); 1 once it is over, however it ended. */
    onProgress?: (side: PovWatch["side"], fraction: number) => void;
  } = {},
): Promise<PovWatch[]> {
  const log = opts.log ?? (() => {});
  const script = config.watchScript;
  // Both are said in the match's log: a pick that ran without /watch must say so the morning
  // after (13617328's nightly pick, 24 Sept 2026, had no stills and no line saying why).
  if (!script) {
    log(
      "/watch is off (watchScript is null in mcsr-vid.config.json) — the model picks from the video alone",
      {
        level: "warn",
      },
    );
    return [];
  }
  if (!existsSync(script)) {
    log(
      `/watch is not installed (${script} not found) — the model picks from the video alone; set watchScript in mcsr-vid.config.json to a path this server can see (the lab's: /app/.tools/watch/scripts/watch.py) and restart the dashboard, which reads the config at boot`,
      { level: "warn" },
    );
    return [];
  }
  const out: PovWatch[] = [];
  for (const side of ["left", "right"] as const) {
    opts.signal?.throwIfAborted();
    try {
      opts.onProgress?.(side, 0);
      const watched = await watchOne(match, side, script, opts.signal, log, (f) =>
        opts.onProgress?.(side, f),
      );
      if (watched) out.push(watched);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const nick = match.players[side === "left" ? 0 : 1]?.nickname ?? side;
      log(`/watch failed on ${nick}'s stream: ${describeError(err)} — the pick goes on without it`, {
        level: "warn",
        ...(err instanceof WatchFailure && err.detail ? { detail: err.detail } : {}),
      });
    }
    opts.onProgress?.(side, 1);
  }
  return out;
}
