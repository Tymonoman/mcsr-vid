/**
 * The manual half of sync: one frame out of a POV clip at a given point on the finished timeline,
 * so the operator can put the two countdowns side by side and match them by eye.
 *
 * The detector (`src/pipeline/countdownDetect.ts`) is right most of the time and reports a confidence when
 * it is not. This is what happens after that: when the confidence is low there is nothing more
 * the machine can work out from the picture, and a human reading two digits settles it in seconds.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { ANCHOR_SEC } from "./kdenliveProject.js";

/** Seconds into a POV clip that a given second of the finished video comes from. */
export const clipTimeFor = (offsetSec: number, timelineSec: number): number =>
  offsetSec + (timelineSec - ANCHOR_SEC);

/** A POV clip is `<nickname>.mp4` beside the match's other outputs. */
export const povClipPath = (matchDir: string, nickname: string): string =>
  path.join(matchDir, `${nickname}.mp4`);

/** No clip on disk means the VODs were cleaned up; the editor has nothing to show. */
export const povClipExists = (matchDir: string, nickname: string): boolean =>
  existsSync(povClipPath(matchDir, nickname));

/**
 * An offset a human typed, or a message saying why not.
 *
 * `readSyncOffsets` degrades a NaN to "no sync data", which ffmpeg would otherwise render as a
 * black frame — so the refusal happens here, where it can be said out loud, rather than there.
 */
export function validOffset(raw: unknown, label: string): { value: number } | { error: string } {
  // `Number("")` is 0, so an empty box would seek to the head of the clip and read as a deliberate
  // answer. A missing value is missing; only a typed 0 is zero.
  if (typeof raw !== "number") {
    const text = String(raw ?? "").trim();
    if (text === "") return { error: `${label}: expected a number of seconds` };
    raw = Number(text);
  }
  const n = raw as number;
  if (!Number.isFinite(n)) return { error: `${label}: expected a number of seconds` };
  // Match start cannot fall before the clip starts: the pipeline downloads `preRollSec` ahead of
  // it. A day is past any VOD worth cutting and keeps a typo out of an ffmpeg seek.
  if (n < 0) return { error: `${label}: cannot be negative — match start is inside the clip` };
  if (n > 86_400) return { error: `${label}: ${n}s is longer than any VOD` };
  return { value: Math.round(n * 1000) / 1000 };
}

/** Widest frame the editor asks for; the countdown digits are legible well below the source. */
const FRAME_WIDTH = 640;
/** One frame is a fraction of a second of ffmpeg, but a wedged decode must not hold a socket. */
const FRAME_TIMEOUT_MS = 20_000;

/**
 * One JPEG from `clipPath` at `atSec`. `-ss` ahead of `-i` so ffmpeg seeks rather than decodes
 * from the top: at ten minutes in, the difference is a page that loads and one that does not.
 */
export function povFrame(clipPath: string, atSec: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        String(Math.max(0, atSec)),
        "-i",
        clipPath,
        "-frames:v",
        "1",
        "-vf",
        `scale=${FRAME_WIDTH}:-2`,
        "-f",
        "image2",
        "-vcodec",
        "mjpeg",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), FRAME_TIMEOUT_MS);
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (d: Buffer) => (stderr += d));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      // A seek past the end exits 0 with nothing on stdout, which is not an image.
      if (code !== 0) return reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-300)}`));
      if (buf.length === 0)
        return reject(new Error(`no frame at ${atSec.toFixed(2)}s — past the end of the clip?`));
      resolve(buf);
    });
  });
}
