import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readWavMono16 } from "./wav.js";

const SAMPLE_RATE = 8000;
const PROBE_RADIUS_SEC = 3;
const SEARCH_RADIUS_SEC = 8;
const COARSE_STRIDE_SAMPLES = 80; // 10ms steps at 8kHz

export interface SyncResult {
  /** Corrected time (sec) within clip B where the match-start cue actually falls. */
  clipBCueTimeSec: number;
  /** Normalized cross-correlation peak, roughly 0-1. Higher is more trustworthy. */
  confidence: number;
}

function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function extractMonoWav(
  videoPath: string,
  startSec: number,
  durationSec: number,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await runFfmpeg(
    [
      "-y",
      "-ss",
      String(Math.max(0, startSec)),
      "-t",
      String(durationSec),
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "wav",
      outPath,
    ],
    signal,
  );
}

function normalize(samples: Float32Array): Float32Array {
  let mean = 0;
  for (const s of samples) mean += s;
  mean /= samples.length;

  let energy = 0;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]! - mean;
    out[i] = v;
    energy += v * v;
  }
  const rms = Math.sqrt(energy / samples.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= rms;
  return out;
}

function correlateAt(probe: Float32Array, search: Float32Array, lag: number): number {
  let sum = 0;
  for (let i = 0; i < probe.length; i++) {
    sum += probe[i]! * search[lag + i]!;
  }
  return sum / probe.length;
}

/** Coarse-to-fine normalized cross-correlation: finds where `probe` best matches within `search`. */
function findBestLag(probe: Float32Array, search: Float32Array): { lag: number; confidence: number } {
  const maxLag = search.length - probe.length;
  if (maxLag <= 0) throw new Error("search buffer must be longer than probe buffer");

  let bestCoarseLag = 0;
  let bestCoarseScore = -Infinity;
  for (let lag = 0; lag <= maxLag; lag += COARSE_STRIDE_SAMPLES) {
    const score = correlateAt(probe, search, lag);
    if (score > bestCoarseScore) {
      bestCoarseScore = score;
      bestCoarseLag = lag;
    }
  }

  const fineStart = Math.max(0, bestCoarseLag - COARSE_STRIDE_SAMPLES);
  const fineEnd = Math.min(maxLag, bestCoarseLag + COARSE_STRIDE_SAMPLES);
  let bestLag = bestCoarseLag;
  let bestScore = -Infinity;
  for (let lag = fineStart; lag <= fineEnd; lag++) {
    const score = correlateAt(probe, search, lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  return { lag: bestLag, confidence: bestScore };
}

/**
 * Refines the match-start alignment between two VOD clips using audio cross-correlation.
 * `expectedClipACueSec`/`expectedClipBCueSec` are the coarse API-derived estimates
 * (matchOffsetIntoClipSec from Phase 2) of when the match starts within each clip.
 */
export async function computeSyncOffset(
  clipAPath: string,
  clipBPath: string,
  expectedClipACueSec: number,
  expectedClipBCueSec: number,
  signal?: AbortSignal,
): Promise<SyncResult> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "mcsr-sync-"));
  try {
    const probeWavPath = path.join(tmpDir, "probe.wav");
    const searchWavPath = path.join(tmpDir, "search.wav");

    const probeStart = expectedClipACueSec - PROBE_RADIUS_SEC;
    const searchStart = expectedClipBCueSec - SEARCH_RADIUS_SEC;

    await extractMonoWav(clipAPath, probeStart, PROBE_RADIUS_SEC * 2, probeWavPath, signal);
    await extractMonoWav(clipBPath, searchStart, SEARCH_RADIUS_SEC * 2, searchWavPath, signal);

    const [probeWav, searchWav] = await Promise.all([
      readWavMono16(probeWavPath),
      readWavMono16(searchWavPath),
    ]);

    const probe = normalize(probeWav.samples);
    const search = normalize(searchWav.samples);

    const { lag, confidence } = findBestLag(probe, search);
    // `lag` locates the *start* of the matched probe window within search; the cue itself
    // is at the probe's center (PROBE_RADIUS_SEC into it), so shift by that to recover it.
    const clipBCueTimeSec =
      Math.max(0, searchStart) + lag / searchWav.sampleRate + PROBE_RADIUS_SEC;

    return { clipBCueTimeSec, confidence };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
