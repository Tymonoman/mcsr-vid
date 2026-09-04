/**
 * Finds the world-load "thump" in ONE clip, with no reference clip to compare against.
 *
 * The pipeline used to locate the thump only *relatively*, by correlating clip A against clip B.
 * That aligns the two POVs with each other but inherits whatever error clip A's API-derived
 * estimate had — and since the timeline is now anchored on the thump, that error moves the
 * published video's zero, its intro, and every chapter. So each clip gets an absolute detection
 * of its own, and sync.ts reconciles the two against the correlation.
 *
 * The feature is the *log-domain* rise of the low band. Working in the log domain is what makes
 * it scale-free: a stream that is uniformly 10x louder produces an identical onset curve, so one
 * threshold works for a quiet capture and a loud one. Absolute energy does not have that
 * property, which is the flaw in the old confidence score (see sync.ts).
 *
 * What matters as much as finding the thump is *refusing to*. A player tabbed out has no thump
 * at all, and a re-log or the previous match's world load can sit inside the search window as a
 * louder decoy. A bare "loudest peak" always returns something, so confidence here is
 * prominence AND uniqueness: how far the best peak stands above the local background, times how
 * far it stands above the runner-up. Both collapse in exactly the cases where we must not guess.
 */

/** Everything here runs at the rate sync.ts extracts audio at. */
export const DETECT_SAMPLE_RATE = 8000;

/**
 * The thump is a broadband transient dominated by low frequencies. 250 Hz is inferred, not
 * measured off a real world-load — treat it as a tuning knob, not a constant of nature, and
 * re-measure against a real VOD if detection starts abstaining on genuine matches.
 */
const LOW_BAND_HZ = 250;
/** Hop between analysis frames: 16 ms, ~1 frame at 60fps. */
const HOP = 128;
/** Rise measured over 16 hops = 256 ms — long enough to ignore a single noisy frame. */
const RISE_LAG_HOPS = 16;
/** Envelope smoothing. Short enough to keep the attack sharp. */
const ENVELOPE_TAU_MS = 20;
/** Two peaks closer than this are the same event, not competitors. */
const PEAK_SEPARATION_SEC = 1;
/** Below this many robust deviations above background, a peak is indistinguishable from noise. */
const MIN_PROMINENCE = 4;
const FULL_PROMINENCE = 12;
/** A runner-up within half the winner's height makes the choice a coin flip. */
const UNIQUENESS_SCALE = 0.5;
/**
 * Below this, a peak has a rival close enough that picking between them is guesswork.
 * Separate from confidence on purpose: a clip can contain a loud, unmistakable transient and
 * still be ambiguous because it contains *two* of them.
 */
const MIN_UNIQUENESS = 0.35;

export interface ThumpDetection {
  /** Seconds into the *clip* (not the window) where the thump's onset is. */
  timeSec: number;
  /** 0-1. Zero means "no defensible answer" — the caller must not use timeSec. */
  confidence: number;
  /** Robust z-score of the winning peak over the window's background. */
  prominence: number;
  /** 1 - (runner-up / winner). Near 0 means a decoy is competing with the real thump. */
  uniqueness: number;
  /** A transient stands clearly above the background — whether or not it is the right one. */
  found: boolean;
  /**
   * A real transient was found, but a rival matched it closely: the clip contains competing
   * candidates, such as a re-log replaying the same world-load sound inside the pre-roll.
   *
   * This is emphatically not the same as `!found`. "No thump here" is safe to fall back from;
   * "two thumps and no way to choose" is a trap, because the wrong one is a confident, sharp,
   * entirely plausible answer that agrees with anything else that made the same mistake.
   */
  ambiguous: boolean;
}

/** One RBJ biquad pass. Two poles is plenty to separate a bass thump from speech and music. */
function lowpass(x: Float32Array, cutoffHz: number, sampleRate: number): Float32Array {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * 0.707);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** Rectify and one-pole smooth into an amplitude envelope. */
function envelope(x: Float32Array, tauMs: number, sampleRate: number): Float32Array {
  const a = Math.exp(-1 / ((tauMs / 1000) * sampleRate));
  const out = new Float32Array(x.length);
  let e = 0;
  for (let i = 0; i < x.length; i++) {
    e = a * e + (1 - a) * Math.abs(x[i]!);
    out[i] = e;
  }
  return out;
}

function median(values: Float32Array | number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * @param samples  mono audio of the search window
 * @param windowStartSec  where that window begins within the clip, so the result is clip-absolute
 */
export function detectThump(
  samples: Float32Array,
  windowStartSec: number,
  sampleRate: number = DETECT_SAMPLE_RATE,
): ThumpDetection {
  const none: ThumpDetection = {
    timeSec: windowStartSec,
    confidence: 0,
    prominence: 0,
    uniqueness: 0,
    found: false,
    ambiguous: false,
  };
  const env = envelope(lowpass(samples, LOW_BAND_HZ, sampleRate), ENVELOPE_TAU_MS, sampleRate);

  const frameCount = Math.floor(env.length / HOP);
  if (frameCount <= RISE_LAG_HOPS * 2) return none;
  const framed = new Float32Array(frameCount);
  for (let n = 0; n < frameCount; n++) framed[n] = env[n * HOP + HOP - 1]!;

  // Log rise over RISE_LAG_HOPS. The subtraction of logs is a ratio, so a constant gain on the
  // whole clip cancels exactly — this is the scale-free property the old score lacked.
  const EPS = 1e-6;
  const rise: number[] = [];
  for (let n = RISE_LAG_HOPS; n < frameCount; n++) {
    rise.push(Math.log(framed[n]! + EPS) - Math.log(framed[n - RISE_LAG_HOPS]! + EPS));
  }
  if (rise.length === 0) return none;

  // Median/MAD rather than mean/stddev: a real thump is itself a huge outlier, and would drag a
  // mean-based background up toward itself and hide its own prominence.
  const background = median(rise);
  const mad = median(rise.map((v) => Math.abs(v - background))) || 1e-9;

  const separation = Math.max(1, Math.round(PEAK_SEPARATION_SEC / (HOP / sampleRate)));
  const ranked = rise.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const peaks: Array<{ v: number; i: number }> = [];
  for (const candidate of ranked) {
    if (peaks.some((p) => Math.abs(p.i - candidate.i) < separation)) continue;
    peaks.push(candidate);
    if (peaks.length >= 2) break;
  }
  const best = peaks[0];
  if (!best) return none;
  const runnerUp = peaks[1];

  const prominence = (best.v - background) / (1.4826 * mad);
  const uniqueness = runnerUp === undefined ? 1 : 1 - Math.max(0, runnerUp.v) / Math.max(1e-9, best.v);
  const confidence =
    clamp01((prominence - MIN_PROMINENCE) / (FULL_PROMINENCE - MIN_PROMINENCE)) *
    clamp01(uniqueness / UNIQUENESS_SCALE);

  // The rise peaks partway *up* the attack, not at its foot. Walk back to where the envelope was
  // still near the floor to recover the onset itself, which is the instant we actually align on.
  const peakSample = (best.i + RISE_LAG_HOPS) * HOP;
  const lookback = Math.round(0.4 * sampleRate);
  let localMax = 0;
  for (let i = Math.max(0, peakSample - lookback); i < Math.min(env.length, peakSample + lookback); i++) {
    localMax = Math.max(localMax, env[i]!);
  }
  let onset = peakSample;
  for (let i = peakSample; i > Math.max(0, peakSample - lookback); i--) {
    if (env[i]! < 0.2 * localMax) {
      onset = i;
      break;
    }
  }

  const found = prominence >= MIN_PROMINENCE;
  return {
    timeSec: windowStartSec + onset / sampleRate,
    confidence,
    prominence,
    uniqueness,
    found,
    ambiguous: found && uniqueness < MIN_UNIQUENESS,
  };
}
