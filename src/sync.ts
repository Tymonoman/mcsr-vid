import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readWavMono16 } from "./wav.js";
import { detectThump, type ThumpDetection } from "./thumpDetect.js";
import { detectMatchStart, type MatchStartDetection } from "./countdownDetect.js";

const SAMPLE_RATE = 8000;
// SEARCH_RADIUS_SEC (clip B): widened 8->20. B's recovered time is exact regardless of how far
// off expectedClipBCueSec was, as long as the thump falls inside the search window — so this
// directly buys tolerance for a bigger B-side coarse-estimate error, no accuracy tradeoff.
// PROBE_RADIUS_SEC (clip A): widened 3->8. This only avoids losing the thump out of the probe
// entirely; it does NOT correct for error in expectedClipACueSec — the recovery formula assumes
// the probe is centered exactly on A's real thump, so any A-side estimate error still propagates
// 1:1 into the output. Fixing that needs independently detecting A's own thump (not implemented).
const PROBE_RADIUS_SEC = 8;
const SEARCH_RADIUS_SEC = 20;
/**
 * Half-width of the window each clip's own thump is hunted in. Wider than SEARCH_RADIUS_SEC
 * because absolute detection has nothing to fall back on: if the thump is outside this window,
 * that clip simply has no answer of its own.
 */
const DETECT_RADIUS_SEC = 25;
/**
 * How far the two independent detections may disagree with the correlation before we stop
 * believing any of them.
 *
 * This is a consistency check, not the source of precision: the offset actually used comes from
 * the correlation, which is sample-accurate, while the detections only have to corroborate it.
 * So the tolerance is set by detector jitter — the envelope walk-back lands tens of milliseconds
 * from the correlation's alignment even on clean audio (45ms, measured) — and not by how
 * accurate the final sync needs to be.
 */
const AGREEMENT_TOLERANCE_SEC = 0.1;
/** Two correlation alignments closer than this are the same match, not competing ones. */
const RIVAL_SEPARATION_SEC = 1;
/**
 * How far the winning correlation peak must stand clear of its best rival, as a fraction of its
 * own height, before the alignment is treated as unambiguous.
 */
const MIN_CORRELATION_UNIQUENESS = 0.25;
const COARSE_STRIDE_SAMPLES = 80; // 10ms steps at 8kHz
// World-load "thump" precedes the actual match start by the ready-countdown most players run
// (verified against https://www.youtube.com/watch?v=Aa_Md_gZRuw: thump @0:05, start @0:15).
// It's a loud, sharp transient — a far more reliable correlation anchor than the near-silent
// instant match start itself — so we correlate on it and add this back to recover match start.
export const THUMP_LEAD_SEC = 10;

export interface SyncResult {
  /** Corrected time (sec) within clip A where match start falls. */
  clipACueTimeSec: number;
  /** Corrected time (sec) within clip B where match start falls. */
  clipBCueTimeSec: number;
  /**
   * 0-1, and comparable between matches. High only when independent evidence agrees; a single
   * confident-looking measurement never earns it alone.
   */
  confidence: number;
  /**
   * `(thumpB - thumpA) - relativeOffsetFromCorrelation`, in seconds, or null when both clips
   * were not detected. A residual with a known null distribution — unlike a correlation peak
   * height, a value near zero here is real evidence.
   */
  residualSec: number | null;
  /** Which evidence agreed, for the sync marker the editor sees. */
  detail: string;
}

/** Confidence at or above which a video detection is trusted as an absolute anchor. */
const VIDEO_TRUSTED = 0.08;

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

/**
 * Prefix sums of the search buffer and its squares, so the local mean and variance of any
 * window are O(1) instead of O(N) per lag.
 */
function prefixSums(x: Float32Array): { sum: Float64Array; sumSq: Float64Array } {
  const sum = new Float64Array(x.length + 1);
  const sumSq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) {
    sum[i + 1] = sum[i]! + x[i]!;
    sumSq[i + 1] = sumSq[i]! + x[i]! * x[i]!;
  }
  return { sum, sumSq };
}

/**
 * Normalized cross-correlation at one lag, in [-1, 1].
 *
 * The division is by the *local* standard deviation of the search window, not by a constant.
 * Dividing by `probe.length` alone (with both buffers scaled by their global RMS, as this did
 * before) leaves the score proportional to how loud the search window happens to be there, so
 * it systematically prefers loud regions and is unbounded above. Measured, that scored a decoy
 * thump 4.3 seconds from the truth at 1.34 — nine times the 0.15 accept threshold. `probe` is
 * mean-centred by `normalize`, so the search window's mean drops out of the numerator.
 */
function correlateAt(
  probe: Float32Array,
  search: Float32Array,
  lag: number,
  sums: { sum: Float64Array; sumSq: Float64Array },
): number {
  const n = probe.length;
  let dot = 0;
  for (let i = 0; i < n; i++) dot += probe[i]! * search[lag + i]!;
  const mean = (sums.sum[lag + n]! - sums.sum[lag]!) / n;
  const variance = (sums.sumSq[lag + n]! - sums.sumSq[lag]!) / n - mean * mean;
  if (!(variance > 0)) return 0;
  // `probe` has unit RMS after normalize(), so its own norm is exactly sqrt(n).
  return dot / (n * Math.sqrt(variance));
}

/**
 * Coarse-to-fine normalized cross-correlation: where `probe` best matches within `search`.
 *
 * Returns the runner-up peak as well as the winner, and that is the load-bearing part. NCC is
 * amplitude-invariant by construction, so a re-log that replays the same world-load sound
 * correlates exactly as well as the real one — the winner's height cannot tell them apart, but
 * the *gap* to a well-separated rival can. Without this the correlation reports a decoy with
 * total confidence.
 */
function findBestLag(
  probe: Float32Array,
  search: Float32Array,
): { lag: number; peak: number; runnerUp: number } {
  const maxLag = search.length - probe.length;
  if (maxLag <= 0) throw new Error("search buffer must be longer than probe buffer");
  const sums = prefixSums(search);

  const coarse: Array<{ lag: number; score: number }> = [];
  for (let lag = 0; lag <= maxLag; lag += COARSE_STRIDE_SAMPLES) {
    coarse.push({ lag, score: correlateAt(probe, search, lag, sums) });
  }
  coarse.sort((a, b) => b.score - a.score);
  const bestCoarse = coarse[0]!;

  // A rival must be a genuinely different alignment, not the shoulder of the same peak.
  const separation = RIVAL_SEPARATION_SEC * SAMPLE_RATE;
  const rival = coarse.find((c) => Math.abs(c.lag - bestCoarse.lag) >= separation);

  const fineStart = Math.max(0, bestCoarse.lag - COARSE_STRIDE_SAMPLES);
  const fineEnd = Math.min(maxLag, bestCoarse.lag + COARSE_STRIDE_SAMPLES);
  let bestLag = bestCoarse.lag;
  let bestScore = -Infinity;
  for (let lag = fineStart; lag <= fineEnd; lag++) {
    const score = correlateAt(probe, search, lag, sums);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  return { lag: bestLag, peak: bestScore, runnerUp: rival ? rival.score : 0 };
}

/**
 * Locates match start in BOTH clips.
 *
 * Three measurements, deliberately not one: each clip's thump found on its own terms, plus the
 * cross-correlation between them. The correlation is precise about the *relative* offset and
 * says nothing about the absolute one — its result reduces to `expectedA + (thumpB - thumpA)`,
 * so clip A's estimate error passes straight through. That was tolerable when the editor nudged
 * the whole timeline into place by hand; now that timeline zero *is* the thump, an A-side error
 * moves the video's start, the intro and every chapter with it.
 *
 * So the absolute detections supply the anchor, the correlation supplies the precision, and
 * their disagreement is the confidence. Two independently-derived values agreeing to within a
 * few frames is strong evidence; either one alone is not.
 *
 * `expectedClipACueSec`/`expectedClipBCueSec` are the coarse API-derived match-start estimates
 * (matchOffsetIntoClipSec). Everything is anchored on the world-load thump rather than match
 * start itself, because the thump is a loud transient and match start is near-silent.
 */
export async function computeSyncOffset(
  clipAPath: string,
  clipBPath: string,
  expectedClipACueSec: number,
  expectedClipBCueSec: number,
  signal?: AbortSignal,
): Promise<SyncResult> {
  // Look at the picture first. MCSR freezes both players through the countdown, so match start
  // is visible in each VOD on its own — no cross-clip comparison, and so no dependency on the
  // two streams sharing anything. See the note on countdownDetect.ts for why that matters more
  // than it sounds: measured on match 12296170, audio correlation between the two POVs peaked at
  // 0.03-0.13 and was 12-32s wrong, because opponents play separate worlds with their own
  // microphones and music. There is no shared "world-load thump" to correlate on.
  const [videoA, videoB] = await Promise.all([
    detectMatchStart(clipAPath, expectedClipACueSec, DETECT_RADIUS_SEC, signal),
    detectMatchStart(clipBPath, expectedClipBCueSec, DETECT_RADIUS_SEC, signal),
  ]);

  const videoResult = fromVideo(videoA, videoB, expectedClipACueSec, expectedClipBCueSec);
  if (videoResult) return videoResult;

  return audioFallback(clipAPath, clipBPath, expectedClipACueSec, expectedClipBCueSec, signal);
}

/**
 * Both clips seen, or one clip seen and the other left on its coarse estimate.
 *
 * Returns null when the picture supports nothing at all — both players tabbed out, or a stream
 * layout the freeze heuristic does not recognise — so the caller can try audio instead.
 */
function fromVideo(
  videoA: MatchStartDetection,
  videoB: MatchStartDetection,
  expectedA: number,
  expectedB: number,
): SyncResult | null {
  const okA = videoA.matchStartSec !== null && videoA.confidence >= VIDEO_TRUSTED;
  const okB = videoB.matchStartSec !== null && videoB.confidence >= VIDEO_TRUSTED;
  if (!okA && !okB) return null;

  const describe = () =>
    `countdown freeze A ${okA ? `${videoA.matchStartSec!.toFixed(2)}s (${videoA.detail})` : `not found (${videoA.detail})`}; ` +
    `B ${okB ? `${videoB.matchStartSec!.toFixed(2)}s (${videoB.detail})` : `not found (${videoB.detail})`}`;

  // Each clip is anchored on its own evidence, so one player tabbing out costs only that clip's
  // precision — it cannot drag the other POV out of alignment, which a purely relative sync
  // would have done.
  return {
    clipACueTimeSec: okA ? videoA.matchStartSec! : expectedA,
    clipBCueTimeSec: okB ? videoB.matchStartSec! : expectedB,
    confidence:
      okA && okB
        ? Math.min(1, 0.6 + Math.min(videoA.confidence, videoB.confidence))
        : Math.min(0.5, 0.3 + (okA ? videoA.confidence : videoB.confidence)),
    residualSec: null,
    detail:
      okA && okB
        ? `video: both countdowns found — ${describe()}`
        : `video: one countdown found — ${describe()}`,
  };
}

/**
 * The original audio path, kept for footage the freeze heuristic cannot read. It aligns the two
 * POVs to each other rather than anchoring either absolutely, and on real MCSR footage it mostly
 * abstains — which is the honest outcome, not a regression.
 */
async function audioFallback(
  clipAPath: string,
  clipBPath: string,
  expectedClipACueSec: number,
  expectedClipBCueSec: number,
  signal?: AbortSignal,
): Promise<SyncResult> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "mcsr-sync-"));
  try {
    const expectedThumpA = expectedClipACueSec - THUMP_LEAD_SEC;
    const expectedThumpB = expectedClipBCueSec - THUMP_LEAD_SEC;
    // ffmpeg clamps a negative -ss to 0, so the window may not begin where we asked; carry the
    // real start or every recovered time is shifted by the difference.
    const windowAStart = Math.max(0, expectedThumpA - DETECT_RADIUS_SEC);
    const windowBStart = Math.max(0, expectedThumpB - DETECT_RADIUS_SEC);

    const windowAPath = path.join(tmpDir, "a.wav");
    const windowBPath = path.join(tmpDir, "b.wav");
    await extractMonoWav(clipAPath, windowAStart, DETECT_RADIUS_SEC * 2, windowAPath, signal);
    await extractMonoWav(clipBPath, windowBStart, DETECT_RADIUS_SEC * 2, windowBPath, signal);

    const [wavA, wavB] = await Promise.all([readWavMono16(windowAPath), readWavMono16(windowBPath)]);

    const detA = detectThump(wavA.samples, windowAStart, wavA.sampleRate);
    const detB = detectThump(wavB.samples, windowBStart, wavB.sampleRate);

    const anchorA = detA.confidence > 0 ? detA.timeSec : expectedThumpA;
    const relative = correlateClips(wavA, windowAStart, anchorA, wavB, windowBStart);

    return reconcile({ detA, detB, relative, expectedThumpA, expectedThumpB });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * The offset from a moment in clip A to the same moment in clip B, and how well the waveforms
 * matched there. Independent of either clip's absolute position.
 */
function correlateClips(
  wavA: { samples: Float32Array; sampleRate: number },
  windowAStart: number,
  anchorASec: number,
  wavB: { samples: Float32Array; sampleRate: number },
  windowBStart: number,
): { offsetSec: number; peak: number; uniqueness: number } | null {
  const rate = wavA.sampleRate;
  const centre = Math.round((anchorASec - windowAStart) * rate);
  const half = Math.round(PROBE_RADIUS_SEC * rate);
  const from = Math.max(0, centre - half);
  const to = Math.min(wavA.samples.length, centre + half);
  // Nothing to correlate: the probe would be empty, or longer than the buffer searched.
  if (to - from < rate || wavB.samples.length <= to - from) return null;

  const probe = normalize(wavA.samples.subarray(from, to));
  const search = normalize(wavB.samples);
  const { lag, peak, runnerUp } = findBestLag(probe, search);

  // `lag` is where the probe's first sample lands in B, so the probe's start maps from
  // (windowAStart + from/rate) in A to (windowBStart + lag/rate) in B.
  const offsetSec = windowBStart + lag / rate - (windowAStart + from / rate);
  const uniqueness = peak > 0 ? 1 - Math.max(0, runnerUp) / peak : 0;
  return { offsetSec, peak, uniqueness };
}

/**
 * Turns three measurements into one anchor plus an honest confidence.
 *
 * The ordering matters more than the arithmetic. Agreement between the detector and the
 * correlation is only evidence when the two could have disagreed — and they cannot when both
 * are looking at the same ambiguity. A re-log that replays the world-load sound produces a
 * second, equally good candidate; the detector picks the louder one and NCC, being
 * amplitude-invariant, matches it just as well. The two then "agree", on the wrong answer.
 *
 * So ambiguity is checked first and vetoes everything: if either the correlation or a detection
 * had a close rival, no amount of agreement rescues it. Only once the alignment is unambiguous
 * does agreement between independent measurements mean what it looks like it means.
 */
function reconcile(input: {
  detA: ThumpDetection;
  detB: ThumpDetection;
  relative: { offsetSec: number; peak: number; uniqueness: number } | null;
  expectedThumpA: number;
  expectedThumpB: number;
}): SyncResult {
  const { detA, detB, relative, expectedThumpA, expectedThumpB } = input;
  const cue = (thumpSec: number) => thumpSec + THUMP_LEAD_SEC;
  const CONFIDENT = 0.4;

  const residualSec =
    relative && detA.confidence > 0 && detB.confidence > 0
      ? detB.timeSec - detA.timeSec - relative.offsetSec
      : null;
  const agree = residualSec !== null && Math.abs(residualSec) <= AGREEMENT_TOLERANCE_SEC;
  const both = detA.confidence > CONFIDENT && detB.confidence > CONFIDENT;

  const describe = (verdict: string) =>
    `${verdict} (thump A ${detA.confidence.toFixed(2)}, B ${detB.confidence.toFixed(2)}` +
    `${relative ? `, xcorr ${relative.peak.toFixed(2)} uniq ${relative.uniqueness.toFixed(2)}` : ", xcorr unavailable"}` +
    `${residualSec === null ? "" : `, residual ${(residualSec * 1000).toFixed(0)}ms`})`;

  const coarse = (verdict: string, confidence = 0): SyncResult => ({
    clipACueTimeSec: cue(expectedThumpA),
    clipBCueTimeSec: cue(expectedThumpB),
    confidence,
    residualSec,
    detail: describe(verdict),
  });

  if (!relative) return coarse("no usable audio evidence, kept coarse estimates");

  // A clip containing two rival thumps vetoes everything, including the correlation. The
  // correlation cannot break the tie either — measured, it prefers whichever is *louder*,
  // because NCC normalises over the whole probe window rather than per event, so a replayed
  // world-load that is louder than the real one wins outright and then "agrees" with the
  // detector that made the same mistake. Being 4 seconds wrong here moves the published
  // video's start; keeping the coarse estimate merely leaves it where it already was.
  if (detA.ambiguous || detB.ambiguous) {
    return coarse("AMBIGUOUS — a rival thump matched nearly as well, kept coarse estimates");
  }

  // The alignment itself is ambiguous: a rival lag matched nearly as well, so the offset could
  // belong to either. Nothing downstream can recover from picking wrong, so do not pick.
  if (relative.uniqueness < MIN_CORRELATION_UNIQUENESS) {
    return coarse("AMBIGUOUS — a rival alignment matched nearly as well, kept coarse estimates");
  }

  // Two confident detections contradicting an unambiguous correlation: refuse rather than
  // average. Averaging a right answer with a wrong one is a wrong answer, better presented.
  if (both && !agree) {
    return coarse("CONFLICT — detections disagree with the correlation, kept coarse estimates");
  }

  // Anchor absolutely on A and take the relative offset from the correlation: differencing two
  // independent detections is much noisier than the correlation's own alignment.
  if (both) {
    return {
      clipACueTimeSec: cue(detA.timeSec),
      clipBCueTimeSec: cue(detA.timeSec + relative.offsetSec),
      confidence: Math.min(1, 0.7 + 0.3 * Math.min(detA.confidence, detB.confidence)),
      residualSec,
      detail: describe("three-way agreement"),
    };
  }

  // Neither clip could be pinned down on its own, but the waveforms align unambiguously. This is
  // the behaviour the pipeline has always had, and it is still worth having: the two POVs will
  // match each other exactly, while where the pair sits in absolute time is only as good as the
  // API estimate. Capped below the "verified" band so the marker says so.
  return {
    clipACueTimeSec: cue(expectedThumpA),
    clipBCueTimeSec: cue(expectedThumpA + relative.offsetSec),
    confidence: Math.max(0, Math.min(0.4, relative.peak)),
    residualSec,
    detail: describe("relative only — POVs aligned to each other, absolute start unverified"),
  };
}
