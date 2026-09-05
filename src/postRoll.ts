import { spawn } from "node:child_process";

/**
 * How long to keep rolling after the run ends.
 *
 * The one hard rule for automated editing here is that the match itself is never cut. That
 * leaves exactly two editable regions: the pre-roll, which the thump anchor already handles, and
 * the tail. Today the tail is a flat `postRollSec` of whatever followed — sometimes a celebration
 * worth watching, sometimes 60 seconds of a menu.
 *
 * A reaction is loud and the frame keeps moving; dead air is neither. So the tail is cut where
 * *both* stop, taking the later of the two so a quiet fist-pump or a wordless replay-watch is not
 * clipped. This never shortens below `minSec`, because a hard cut on the dragon's death frame
 * reads as a mistake rather than an ending.
 *
 * Deliberately not attempted: anything that would need to know what is *being said*. Cutting to
 * the good part of a reaction needs speech, and speech means a transcription pass per match on a
 * box with four cores.
 */

export interface TailWindow {
  /** Loudness per second, dBFS-ish (higher is louder). */
  loudness: number[];
  /** Mean absolute frame difference per second. */
  motion: number[];
}

export interface TailOptions {
  minSec: number;
  maxSec: number;
  /** Seconds of continuous quiet-and-still before the tail is considered over. */
  quietRunSec?: number;
}

const QUIET_RUN_SEC = 6;
/**
 * Absolute, not relative to the clip's own range — and that distinction is the whole thing.
 * Normalising each series to its own min/max made a tail that is loud from start to finish scale
 * to all-zeros and read as *silence*, cutting a continuous celebration at the floor. Both units
 * are already absolute: RMS_level is dBFS, where -45 is the conventional silence gate, and motion
 * is a mean absolute difference on 0-255, where a still frame sits near zero.
 */
const AUDIBLE_DBFS = -45;
const MOVING_MAD = 2;

/**
 * The pure core: where activity stops, in seconds after the run ended.
 *
 * Thresholds come from the clip's own levels rather than absolutes — one streamer's excited is
 * another's baseline, and a capture card's gain is arbitrary.
 */
export function suggestTailSec(window: TailWindow, opts: TailOptions): number {
  const { minSec, maxSec } = opts;
  const quietRun = opts.quietRunSec ?? QUIET_RUN_SEC;
  const n = Math.min(window.loudness.length, window.motion.length, maxSec);
  if (n === 0) return maxSec;

  // Active if either channel is above its threshold. Either, not both: a streamer sitting still
  // and talking is still reacting, and so is one silently rewatching the finish.
  const active = Array.from(
    { length: n },
    (_, i) => window.loudness[i]! > AUDIBLE_DBFS || window.motion[i]! > MOVING_MAD,
  );

  let quiet = 0;
  for (let i = 0; i < n; i++) {
    quiet = active[i] ? 0 : quiet + 1;
    if (quiet >= quietRun && i + 1 >= minSec) {
      // Cut at the start of the quiet run, not its end — the dead air is the thing being removed.
      return Math.max(minSec, Math.min(maxSec, i + 1 - quietRun));
    }
  }
  return Math.min(maxSec, Math.max(minSec, n));
}

function run(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", () => resolve(stderr));
  });
}

/** Per-second loudness and motion for the window after the run ends. */
export async function measureTail(
  clipPath: string,
  runEndSec: number,
  maxSec: number,
  signal?: AbortSignal,
): Promise<TailWindow> {
  // astats over one-second frames gives a loudness series in a single cheap audio pass; the
  // motion series reuses the same downscaled-grayscale trick the countdown detector uses.
  const out = await run(
    [
      "-v",
      "info",
      "-ss",
      String(runEndSec),
      "-t",
      String(maxSec),
      "-i",
      clipPath,
      "-vn",
      "-af",
      "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
      "-f",
      "null",
      "-",
    ],
    signal,
  );
  const loudness = [...out.matchAll(/RMS_level=(-?[\d.]+|inf)/g)].map((m) =>
    m[1] === "inf" || m[1] === "-inf" ? -90 : Number(m[1]),
  );

  const W = 64;
  const H = 36;
  const frames = await new Promise<Uint8Array[]>((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        String(runEndSec),
        "-t",
        String(maxSec),
        "-i",
        clipPath,
        "-vf",
        `fps=2,scale=${W}:${H},format=gray`,
        "-f",
        "rawvideo",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"], signal },
    );
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", reject);
    proc.on("close", () => {
      const buf = Buffer.concat(chunks);
      const size = W * H;
      const list: Uint8Array[] = [];
      for (let i = 0; i + size <= buf.length; i += size) list.push(new Uint8Array(buf.subarray(i, i + size)));
      resolve(list);
    });
  });

  // Two samples per second in, one mean-difference per second out.
  const motion: number[] = [];
  for (let i = 2; i < frames.length; i += 2) {
    const a = frames[i - 2]!;
    const b = frames[i]!;
    let sum = 0;
    for (let k = 0; k < a.length; k++) sum += Math.abs(a[k]! - b[k]!);
    motion.push(sum / a.length);
  }

  return { loudness, motion };
}
