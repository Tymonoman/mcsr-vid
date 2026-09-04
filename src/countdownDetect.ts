import { spawn } from "node:child_process";

/**
 * Finds where gameplay actually starts in one VOD, by looking at the picture rather than the
 * audio.
 *
 * MCSR holds every player still through the 10-second pre-match countdown: the world is loaded,
 * the camera is locked, and the only thing moving on screen is the countdown digit. So a match
 * start is the *end of a long frozen stretch* — a near-zero frame difference for the better part
 * of ten seconds, ending in sustained motion that never stops. Measured on match 12296170 that
 * transition is a jump from ~0.3 to 50+ on a 0-255 mean-absolute-difference scale: not a
 * threshold that needs tuning so much as a cliff.
 *
 * This replaced cross-correlating the two players' audio, which cannot work here however well it
 * is implemented: MCSR opponents play separate worlds with their own microphones and music, so
 * the two streams share almost no audio. Measured on the same match, correlation between the two
 * VODs peaked at 0.03-0.13 and returned offsets 12 to 32 seconds from the truth, whichever
 * window it was given. See src/sync.ts, which now uses this and keeps audio only as corroboration.
 */

/** Analysis resolution. Tiny on purpose — this measures whether the frame changed, not how. */
const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 36;
const SAMPLE_FPS = 10;
/** The countdown is 10s; accept a shorter freeze so a late world-load still detects. */
const MIN_STILL_SEC = 5;
/** Motion must persist this long after the freeze, so a menu flicker is not read as the start. */
const SUSTAINED_SEC = 2;
/** ...and be moving for at least this fraction of that window. */
const SUSTAINED_FRACTION = 0.6;
/** Nominal countdown length, and so the gap from the freeze's start to gameplay. */
export const COUNTDOWN_SEC = 10;

export interface MatchStartDetection {
  /** Seconds into the clip where gameplay starts (RTA 0:00), or null if nothing qualified. */
  matchStartSec: number | null;
  /** 0-1. Zero means the picture does not support an answer; the caller must not use the time. */
  confidence: number;
  /** How long the player was frozen before it. Around 10s for a clean countdown. */
  stillRunSec: number;
  detail: string;
}

/** Mean absolute difference between consecutive downscaled grayscale frames. */
export function frameMotion(frames: Uint8Array[]): number[] {
  const motion: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!;
    const b = frames[i]!;
    let sum = 0;
    for (let k = 0; k < a.length; k++) sum += Math.abs(a[k]! - b[k]!);
    motion.push(sum / a.length);
  }
  return motion;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * The pure core: given a motion series, find the end of the freeze that precedes gameplay.
 *
 * `expectedIndex` is where the coarse API estimate says match start is. It only breaks ties
 * between qualifying candidates — a lone clear freeze wins wherever it sits — but a VOD can
 * easily contain several (the player idling in a menu, a previous match), and preferring the one
 * the rest of the pipeline already expects is the difference between correcting an estimate and
 * replacing it with an unrelated moment.
 */
export function findMatchStartIndex(
  motion: number[],
  expectedIndex: number,
  fps: number = SAMPLE_FPS,
): { index: number | null; confidence: number; stillRunSec: number; detail: string } {
  if (motion.length < fps * (MIN_STILL_SEC + SUSTAINED_SEC)) {
    return { index: null, confidence: 0, stillRunSec: 0, detail: "clip window too short to judge" };
  }

  // A cliff, not a tuned threshold: still frames sit near zero and moving ones an order of
  // magnitude above. Deriving it from the clip's own busy level keeps it scale-free across
  // capture settings, and the floor stops an entirely static window from splitting noise in two.
  const movingLevel = percentile(motion, 0.75);
  const threshold = Math.max(1.5, movingLevel * 0.12);
  const still = motion.map((m) => m < threshold);

  const minStill = Math.round(MIN_STILL_SEC * fps);
  const sustained = Math.round(SUSTAINED_SEC * fps);

  const candidates: Array<{ index: number; runFrames: number; sustainedFraction: number }> = [];
  let runStart = 0;
  for (let i = 1; i <= still.length; i++) {
    const ended = i === still.length || !still[i];
    if (!ended) continue;
    if (still[i - 1] === true) {
      // [runStart, i) is a still run — but only if it really started here.
      let s = i - 1;
      while (s > 0 && still[s - 1] === true) s--;
      runStart = s;
      const runFrames = i - runStart;
      if (runFrames >= minStill && i + sustained <= motion.length) {
        const after = still.slice(i, i + sustained);
        const movingFraction = after.filter((x) => !x).length / after.length;
        if (movingFraction >= SUSTAINED_FRACTION) {
          candidates.push({ index: i, runFrames, sustainedFraction: movingFraction });
        }
      }
    }
  }

  if (candidates.length === 0) {
    return {
      index: null,
      confidence: 0,
      stillRunSec: 0,
      detail: "no frozen countdown found — the player may have been tabbed out",
    };
  }

  // Nearest the expected start; the freeze length breaks a tie between equally close ones.
  candidates.sort(
    (a, b) =>
      Math.abs(a.index - expectedIndex) - Math.abs(b.index - expectedIndex) || b.runFrames - a.runFrames,
  );
  const best = candidates[0]!;
  const stillRunSec = best.runFrames / fps;
  const offBySec = Math.abs(best.index - expectedIndex) / fps;

  // A freeze the length of a real countdown, a decisive contrast, motion that keeps going, and a
  // position the coarse estimate agrees with. All four, or say so.
  const lengthScore = clamp01((stillRunSec - MIN_STILL_SEC) / (COUNTDOWN_SEC - MIN_STILL_SEC));
  const contrastScore = clamp01((movingLevel / Math.max(threshold, 1e-6) - 4) / 8);
  const priorScore = clamp01(1 - offBySec / 20);
  const confidence = lengthScore * contrastScore * priorScore * best.sustainedFraction;

  return {
    index: best.index,
    confidence,
    stillRunSec,
    detail:
      `${stillRunSec.toFixed(1)}s freeze, ${offBySec.toFixed(1)}s from the estimate, ` +
      `contrast ${(movingLevel / Math.max(threshold, 1e-6)).toFixed(1)}x` +
      (candidates.length > 1 ? `, ${candidates.length} candidates` : ""),
  };
}

/** Decodes a window of the clip as tiny grayscale frames. */
function readFrames(
  clipPath: string,
  startSec: number,
  durationSec: number,
  signal?: AbortSignal,
): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        String(Math.max(0, startSec)),
        "-t",
        String(durationSec),
        "-i",
        clipPath,
        "-vf",
        `fps=${SAMPLE_FPS},scale=${FRAME_WIDTH}:${FRAME_HEIGHT},format=gray`,
        "-f",
        "rawvideo",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"], signal },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (d: Buffer) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-400)}`));
      const buf = Buffer.concat(chunks);
      const size = FRAME_WIDTH * FRAME_HEIGHT;
      const frames: Uint8Array[] = [];
      for (let i = 0; i + size <= buf.length; i += size) {
        frames.push(new Uint8Array(buf.subarray(i, i + size)));
      }
      resolve(frames);
    });
  });
}

/**
 * @param expectedStartSec  the coarse API-derived match start within this clip
 * @param radiusSec         how far either side of it to look
 */
export async function detectMatchStart(
  clipPath: string,
  expectedStartSec: number,
  radiusSec = 25,
  signal?: AbortSignal,
): Promise<MatchStartDetection> {
  const windowStart = Math.max(0, expectedStartSec - radiusSec);
  let frames: Uint8Array[];
  try {
    frames = await readFrames(clipPath, windowStart, radiusSec * 2, signal);
  } catch (err) {
    // A clip with no readable video — an audio-only capture, a corrupt stream — is a reason to
    // fall through to the audio path, not to fail the run. Reported rather than swallowed: this
    // text reaches the sync marker in the project, so an unexpected ffmpeg failure is visible
    // instead of looking like an ordinary "player was tabbed out".
    if ((err as { name?: string }).name === "AbortError") throw err;
    return {
      matchStartSec: null,
      confidence: 0,
      stillRunSec: 0,
      detail: `no video to read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const motion = frameMotion(frames);
  // Motion index i is the difference between frames i and i+1, so it sits one frame in.
  const expectedIndex = Math.round((expectedStartSec - windowStart) * SAMPLE_FPS) - 1;
  const found = findMatchStartIndex(motion, expectedIndex);
  return {
    matchStartSec: found.index === null ? null : windowStart + (found.index + 1) / SAMPLE_FPS,
    confidence: found.confidence,
    stillRunSec: found.stillRunSec,
    detail: found.detail,
  };
}
