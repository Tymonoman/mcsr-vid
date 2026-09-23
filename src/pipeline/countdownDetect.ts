import { spawn } from "node:child_process";

/**
 * Finds where gameplay actually starts in one VOD, by looking at the picture rather than the
 * audio.
 *
 * MCSR holds every player still through the 10-second pre-match countdown: the world is loaded,
 * the camera is locked, and the only thing moving on screen is the countdown digit. So a match
 * start is the *end of a long frozen stretch* — a near-zero frame difference for the better part
 * of ten seconds, ending in sustained motion that never stops. That transition is a jump from
 * ~0.3 to 50+ on a 0-255 mean-absolute-difference scale: not a threshold that needs tuning so
 * much as a cliff.
 *
 * Audio cross-correlation cannot work here: opponents play separate worlds with their own
 * microphones and music, so the two streams share almost no audio (see CLAUDE.md). src/pipeline/sync.ts
 * uses this and keeps audio only as corroboration.
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
/**
 * Nominal countdown length, and so the gap from the freeze's start to gameplay — and the
 * timeline's anchor: match start lands at exactly this many seconds into the export
 * (src/pipeline/kdenliveProject.ts `ANCHOR_SEC`).
 */
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

/* --- The countdown digit itself ------------------------------------------------------------- */

/**
 * The second way to see the countdown: the digit in the middle of the screen. A private room
 * (every playoff game) lets the player look around during the ten seconds, so there is no freeze
 * to find — but the white "10" … "1" sits at the centre of the game window, each digit a
 * different number of white pixels, one per second, gone at 0:00. Measured on the S11 Pinne–7rowl
 * game 1: a 96x72 crop of the centre carries 600–1,500 pixels over 235 for the ten seconds and
 * a few dozen otherwise, on a full-width window and on a narrow "tall" one alike, since the
 * digit is drawn at GUI scale and not at window scale.
 *
 * Match start is the frame the "1" vanishes when that is seen, else the "10"'s onset plus ten
 * seconds: a player who opens a menu on "2" dims the last digits (7rowl did), and a player whose
 * world loads late has the loading screen over the first ones (BeefSalad, 13549300) — between
 * the two ends, one is clean.
 */
const DIGIT_CROP = "crop=iw*0.10:ih*0.16:iw*0.45:ih*0.40";
const DIGIT_WIDTH = 96;
const DIGIT_HEIGHT = 72;
const DIGIT_WHITE = 235;
/** White pixels in the crop that mean a digit is showing; the floor is a tenth of the "10". */
const DIGIT_MIN_PIXELS = 200;
/** Of the ten seconds, this many must show a digit, from the onset on. */
const DIGIT_MIN_SECONDS = 6;
/** Consecutive digits differ in pixel count by at least this much: a static bright patch does not. */
const DIGIT_STEP_FRACTION = 0.05;
const DIGIT_MIN_STEPS = 4;
/**
 * The "10" is two glyphs: 1,532 pixels against 809 for the fattest single digit (S11 Pinne–7rowl
 * game 1), 1.9x. An onset whose "10" is not half again the digits after it is a later digit
 * read as the first (Feinberg, 13395245: 800 against 768, the "6" after a waiting screen).
 */
const TEN_OVER_DIGIT = 1.4;
/** More white than this in the crop is the world (snow, clouds), not a digit: the "10" peaks ~1,500. */
const DIGIT_MAX_PIXELS = 3000;
/**
 * A countdown read from its end (see `findCountdownOnset`): how many of its last seconds must
 * show a digit, and step. Eight are there when the world comes in on "8".
 */
const END_MIN_SECONDS = 4;
const END_MIN_STEPS = 3;
/**
 * A hidden "1": a menu opened on the "1" drops the digit early (silverrruns, 13301662 game 1 —
 * the "1" showed for one frame, 9.1 s after the "10", and the operator moved the offset back by
 * exactly a second). An end is read as that only when BOTH hold: it comes this much short of ten
 * seconds after the "10", and the last digit was on screen under `SHORT_LAST_DIGIT_SEC`. The gap
 * alone is not enough — a world that loads late cuts the "10" short instead (lowk3y_, 12296170:
 * the "10" showed 0.4 s, the gap was 9.4 s, and the end was the truth to 0.05 s).
 */
const HIDDEN_ONE_SEC = 0.4;
const SHORT_LAST_DIGIT_SEC = 0.6;
/**
 * The second look when the near window is empty. The estimate is the API's clock against the
 * VOD's, and a VOD that lost a segment earlier in the stream runs ahead of it by a minute
 * (Aquacorde, 13559245: 53 s; 13257079's left clip: 80 s) — outside a ±25 s window, and the
 * countdown was there to read all along. The decode is the cost, so only when needed.
 */
const WIDE_RADIUS_SEC = 150;

/** White pixels per frame in the centre crop. */
export function whiteCounts(frames: Uint8Array[], white = DIGIT_WHITE): number[] {
  return frames.map((f) => {
    let n = 0;
    for (let k = 0; k < f.length; k++) if (f[k]! >= white) n++;
    return n;
  });
}

/**
 * The pure core: the onset of the countdown's "10" in a white-count series, or null.
 *
 * A candidate is a rise into the "10" (see the loop) followed by ten one-second plateaus of
 * which at least `DIGIT_MIN_SECONDS` from the first show a digit, with at least
 * `DIGIT_MIN_STEPS` changes of `DIGIT_STEP_FRACTION` between consecutive plateaus — a static
 * bright patch has none — or, when the first digits were never on screen, a drop out of the
 * last digit with `END_MIN_SECONDS` stepping seconds before it (the second loop). The nearest
 * to the expected index wins; the score is how many seconds and steps it has, and how far it
 * sits from the estimate.
 */
export function findCountdownOnset(
  counts: number[],
  expectedIndex: number,
  fps: number = SAMPLE_FPS,
): { index: number | null; endIndex: number | null; confidence: number; seconds: number; detail: string } {
  const need = Math.round(COUNTDOWN_SEC * fps);
  if (counts.length < need + fps)
    return {
      index: null,
      endIndex: null,
      confidence: 0,
      seconds: 0,
      detail: "clip window too short to judge",
    };
  // A second's level is its 30th percentile, not its median: a second that is a one-frame
  // flash after 0:00 plus the tail of the "1" (v_strid, 13141080) has a median in the digits
  // and no digit for most of its frames. A real digit second is constant.
  const plateau = (from: number): number => {
    const slice = counts.slice(from, from + fps).sort((a, b) => a - b);
    return slice.length ? slice[Math.floor(slice.length * 0.3)]! : 0;
  };
  const candidates: Array<{ index: number; endIndex: number | null; seconds: number; steps: number }> = [];
  for (let i = 1; i + need <= counts.length; i++) {
    // The "10" is the fattest digit — half again the pixels of any other — so the onset is a
    // rise into a second no later plateau exceeds. Its own level is the second's maximum, not
    // its median: a digit that blinks for half a second (a client hiccup, a chat opened) is
    // still the "10". The frame before is under two thirds of it: a "ready" glyph of a few
    // hundred pixels precedes the "10" on some clients.
    const ten = Math.max(...counts.slice(i, i + fps));
    if (ten < DIGIT_MIN_PIXELS || ten > DIGIT_MAX_PIXELS) continue;
    if (counts[i]! < ten * 0.9 || counts[i - 1]! >= ten * (2 / 3)) continue;
    const plateaus = Array.from({ length: COUNTDOWN_SEC }, (_, k) => (k === 0 ? ten : plateau(i + k * fps)));
    if (ten < TEN_OVER_DIGIT * Math.max(...plateaus.slice(1))) continue;
    let seconds = 0;
    while (seconds < COUNTDOWN_SEC && plateaus[seconds]! >= DIGIT_MIN_PIXELS) seconds++;
    if (seconds < DIGIT_MIN_SECONDS) continue;
    let steps = 0;
    for (let k = 1; k < seconds; k++) {
      const a = plateaus[k - 1]!;
      const b = plateaus[k]!;
      if (Math.abs(a - b) >= DIGIT_STEP_FRACTION * Math.max(a, b)) steps++;
    }
    if (steps < DIGIT_MIN_STEPS) continue;
    // The end: the first frame after the last digit, between eight and eleven seconds in, with
    // nothing showing for the half second after it. The "1" vanishing *is* 0:00, so this beats
    // onset-plus-ten when it is there; a menu opened on "2" (7rowl, S11) hides it, and then
    // the onset carries the answer alone.
    // "Nothing" is relative to the digit: a pause menu opened on 0:00 keeps 120–190 white
    // pixels of button text in the crop (doogile, 13223455), and an absolute floor read that
    // as the digit still showing and put the end 0.35 s late.
    let endIndex: number | null = null;
    for (let j = i + Math.round(8 * fps); j <= Math.min(counts.length - 1, i + Math.round(11 * fps)); j++) {
      const level = counts[j]!;
      if (level < DIGIT_MIN_PIXELS / 2) continue;
      const after = counts.slice(j + 1, j + 1 + Math.round(fps / 2));
      if (after.length && after.every((n) => n < level / 2)) {
        endIndex = j + 1;
        break; // the first quiet half second: a flash after 0:00 (a client's "go") is not the end
      }
    }
    // Too early to be 0:00 and the last digit barely shown: the "1" was hidden, and the onset
    // carries the answer alone.
    if (endIndex !== null && endIndex < i + Math.round((COUNTDOWN_SEC - HIDDEN_ONE_SEC) * fps)) {
      const last = counts[endIndex - 1]!;
      let from = endIndex - 1;
      while (from > i && Math.abs(counts[from - 1]! - last) <= 0.1 * last) from--;
      if (endIndex - from < SHORT_LAST_DIGIT_SEC * fps) endIndex = null;
    }
    candidates.push({ index: i, endIndex, seconds, steps });
  }
  // The same countdown read from its end, for the player whose world came in late: the loading
  // screen ("100%", the RANKED card) covers the "10" and the "9", the world appears on "8"
  // (BeefSalad, 13549300), and no rise into a fattest digit exists — but the "1" still vanishes,
  // and the seconds before that drop step like digits. The onset is put ten seconds before the
  // end. A drop inside a countdown the onset pass found is left to it, so a clean countdown is
  // one candidate.
  const half = Math.round(fps / 2);
  for (let j = END_MIN_SECONDS * fps; j + half <= counts.length; j++) {
    const level = counts[j - 1]!;
    if (level < DIGIT_MIN_PIXELS || level > DIGIT_MAX_PIXELS) continue;
    if (!counts.slice(j, j + half).every((n) => n < level / 2)) continue;
    const plateaus: number[] = [];
    for (let k = 1; k <= COUNTDOWN_SEC && j - k * fps >= 0; k++) {
      const p = plateau(j - k * fps);
      if (p < DIGIT_MIN_PIXELS || p > DIGIT_MAX_PIXELS) break;
      plateaus.push(p);
    }
    if (plateaus.length < END_MIN_SECONDS) continue;
    let steps = 0;
    for (let k = 1; k < plateaus.length; k++) {
      const a = plateaus[k - 1]!;
      const b = plateaus[k]!;
      if (Math.abs(a - b) >= DIGIT_STEP_FRACTION * Math.max(a, b)) steps++;
    }
    if (steps < END_MIN_STEPS) continue;
    // A drop inside an onset candidate's ten seconds is that countdown's, and the onset pass has
    // judged it: within eight seconds of the "10" it is a menu dimming the digits (7rowl), not 0:00.
    if (candidates.some((c) => j > c.index && j <= c.index + need)) continue;
    candidates.push({ index: j - need, endIndex: j, seconds: plateaus.length, steps });
  }
  if (candidates.length === 0) {
    return {
      index: null,
      endIndex: null,
      confidence: 0,
      seconds: 0,
      detail: "no countdown digit found at the centre of the frame",
    };
  }
  // A seen end outranks distance: the "1" vanishing is 0:00 by definition, while an onset with
  // no end may be a later digit read as the "10" (Feinberg, 13395245: a static screen through
  // the "7", the onset pass took the "6" for the "10" and put 0:00 four seconds late).
  candidates.sort(
    (a, b) =>
      Number(b.endIndex !== null) - Number(a.endIndex !== null) ||
      Math.abs(a.index - expectedIndex) - Math.abs(b.index - expectedIndex) ||
      b.seconds - a.seconds,
  );
  const best = candidates[0]!;
  const offBySec = Math.abs(best.index - expectedIndex) / fps;
  // The estimate ranks the candidates; it does not veto one. A full ten-digit countdown a
  // minute from the estimate is the countdown (Aquacorde, 13559245, 53 s off: the old
  // `1 - off / 20` scored it zero and the match went to the sync editor). Far from the
  // estimate the shape has to be near complete — the product with the two shape terms does that.
  const confidence =
    clamp01(best.seconds / COUNTDOWN_SEC) *
    clamp01(best.steps / (COUNTDOWN_SEC - 1)) *
    clamp01(1 - offBySec / 240);
  return {
    index: best.index,
    endIndex: best.endIndex,
    confidence,
    seconds: best.seconds,
    detail:
      `digit for ${best.seconds}s with ${best.steps} steps, ${offBySec.toFixed(1)}s from the estimate` +
      (best.endIndex === null ? ", end not seen" : "") +
      (candidates.length > 1 ? `, ${candidates.length} candidates` : ""),
  };
}

/**
 * The centre-digit detection for one clip, as a `MatchStartDetection` so src/pipeline/sync.ts can weigh
 * it against the freeze. Two decodes: the window at 10 fps to find the second, then one second
 * around the onset at the clip's own rate to land on the frame.
 */
export async function detectCountdownDigits(
  clipPath: string,
  expectedStartSec: number,
  radiusSec = 25,
  signal?: AbortSignal,
): Promise<MatchStartDetection> {
  const windowStart = Math.max(0, expectedStartSec - radiusSec);
  const crop = { vf: DIGIT_CROP, width: DIGIT_WIDTH, height: DIGIT_HEIGHT };
  let coarse: Uint8Array[];
  try {
    coarse = await readFrames(clipPath, windowStart, radiusSec * 2, signal, { ...crop, fps: SAMPLE_FPS });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") throw err;
    return {
      matchStartSec: null,
      confidence: 0,
      stillRunSec: 0,
      detail: `no video to read: ${describe(err)}`,
    };
  }
  const expectedIndex = Math.round((expectedStartSec - COUNTDOWN_SEC - windowStart) * SAMPLE_FPS);
  const counts = whiteCounts(coarse);
  const found = findCountdownOnset(counts, expectedIndex);
  if (found.index === null) {
    if (radiusSec < WIDE_RADIUS_SEC)
      return detectCountdownDigits(clipPath, expectedStartSec, WIDE_RADIUS_SEC, signal);
    return { matchStartSec: null, confidence: 0, stillRunSec: 0, detail: found.detail };
  }

  // A frame at 10 fps brackets the moment within 100 ms; a second decode of that instant at
  // 60 fps lands on the frame. The end is the first frame with no digit; the onset the first at
  // the "10"'s full level.
  const fine = async (aroundSec: number, hit: (n: number) => boolean): Promise<number | null> => {
    try {
      const at = whiteCounts(
        await readFrames(clipPath, aroundSec - 0.2, 0.4, signal, { ...crop, fps: FINE_FPS }),
      );
      const k = at.findIndex(hit);
      return k >= 0 ? aroundSec - 0.2 + k / FINE_FPS : null;
    } catch {
      return null; // the coarse answer stands; a decode hiccup is not a reason to lose the detection
    }
  };
  let matchStartSec: number;
  if (found.endIndex !== null) {
    const endSec = windowStart + found.endIndex / SAMPLE_FPS;
    const level = counts[found.endIndex - 1]!;
    const digitOff = (n: number) => n < level / 2;
    // The fine window starts on the last digit frame, so the first frame without one is the end.
    matchStartSec = (await fine(endSec, digitOff)) ?? endSec;
  } else {
    const onsetSec = windowStart + found.index / SAMPLE_FPS;
    const ten = counts[found.index]!;
    matchStartSec = ((await fine(onsetSec, (n) => n >= ten * 0.9)) ?? onsetSec) + COUNTDOWN_SEC;
  }
  return {
    matchStartSec,
    confidence: found.confidence * (found.endIndex === null ? 0.8 : 1),
    stillRunSec: found.seconds,
    detail: found.detail,
  };
}

const FINE_FPS = 60;
/** The digit detector's own scale: a clean countdown scores 0.7–1, one whose end a menu hid ~0.4. */
const DIGITS_TRUSTED = 0.3;

/**
 * Both readings of one clip, settled: the digit's when it is trusted — the "1" vanishing is
 * 0:00 by definition, and the freeze cannot see a player who looks around during the countdown
 * (every private room, so every playoff game) — the freeze's otherwise. The two agreeing within
 * half a second is worth a little more confidence; the detail carries both so the sync marker
 * says what each saw.
 */
export async function detectMatchStartAny(
  clipPath: string,
  expectedStartSec: number,
  radiusSec = 25,
  signal?: AbortSignal,
): Promise<MatchStartDetection> {
  const [freeze, digits] = await Promise.all([
    detectMatchStart(clipPath, expectedStartSec, radiusSec, signal),
    detectCountdownDigits(clipPath, expectedStartSec, radiusSec, signal),
  ]);
  if (digits.matchStartSec !== null && digits.confidence >= DIGITS_TRUSTED) {
    const agree =
      freeze.matchStartSec !== null && Math.abs(freeze.matchStartSec - digits.matchStartSec) <= 0.5;
    return {
      ...digits,
      confidence: Math.min(1, digits.confidence + (agree ? 0.1 : 0)),
      detail: `digit: ${digits.detail}; freeze: ${freeze.detail}`,
    };
  }
  return { ...freeze, detail: `freeze: ${freeze.detail}; digit: ${digits.detail}` };
}
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Decodes a window of the clip as tiny grayscale frames — the whole picture, or a crop of it. */
function readFrames(
  clipPath: string,
  startSec: number,
  durationSec: number,
  signal?: AbortSignal,
  shape: { vf?: string; width: number; height: number; fps: number } = {
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    fps: SAMPLE_FPS,
  },
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
        `fps=${shape.fps},${shape.vf ? `${shape.vf},` : ""}scale=${shape.width}:${shape.height},format=gray`,
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
      const size = shape.width * shape.height;
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
