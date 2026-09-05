import { spawn } from "node:child_process";
import { renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";
import { atomicOutput } from "./atomicOutput.js";
import { config } from "./config.js";
import { bundleOnce } from "./remotionBundle.js";
import {
  SHORT_HEIGHT,
  SHORT_NAMEPLATE_HEIGHT,
  SHORT_POV_HEIGHT,
  SHORT_POV_WIDTH,
  SHORT_WIDTH,
  SHORT_HOOK_SEC,
} from "../remotion/layout.js";
import type { ShortProps } from "../remotion/types.js";

/**
 * Renders a finished, uploadable vertical Short.
 *
 * Unlike the long-form path this does not produce a Kdenlive project. A Short is 30 seconds of
 * fixed layout with nothing to decide, so there is nothing for an editor to do to it, and going
 * through an NLE would just insert a manual step into the one part of the pipeline that can be
 * fully automatic. ffmpeg composites the two POV panes and the Remotion board in a single pass.
 */

export interface ShortRenderArgs {
  /** Absolute path to the POV clip shown in the top pane, and where its match start sits in it. */
  topClipPath: string;
  topMatchStartSec: number;
  bottomClipPath: string;
  bottomMatchStartSec: number;
  /** The window to cut, in ms from match start (RTA 0:00). */
  startMs: number;
  durationSec: number;
  board: Omit<ShortProps, "durationInFrames" | "fps">;
  /**
   * Crop each POV to this region before scaling it into its pane, as fractions of the frame.
   * Overrides detection; pass null to force no crop.
   *
   * Worth having because detection often cannot help. Measured on match 12296170, both streamers
   * have chat, alerts and stat panels updating right out to the frame edges, so motion spans the
   * full width and there is no game window to isolate — the honest answer there is to leave the
   * broadcast alone, which is also what the reference channels show. A pillarboxed stream is the
   * case detection does handle.
   */
  topCrop?: ActiveRegion | null;
  bottomCrop?: ActiveRegion | null;
  outPath: string;
  onProgress?: (p: { phase: "board" | "compositing"; percent: number }) => void;
  signal?: AbortSignal;
}

const FPS = 30;

/**
 * The region of a POV clip that actually contains the game.
 *
 * Streamers do not all play at 16:9. Measured on match 12296170, lowk3y_ runs the game in a tall
 * narrow window, so scaling their full frame into the pane spends most of a 1080px-wide Short on
 * black bars and stream furniture.
 *
 * ffmpeg's `cropdetect` cannot find it: their chat and stats panels reach the frame edges, so
 * there is no black border to trim even though the game is a strip down the middle. What
 * separates the game from everything around it is not colour but *motion* — gameplay changes
 * every frame while chat, webcam borders, stat panels and black bars are static or nearly so.
 * So the game window is found as the region carrying the variance.
 */
export interface ActiveRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PROBE_WIDTH = 160;
const PROBE_HEIGHT = 90;
const PROBE_FPS = 4;
/** Fraction of the motion mass the crop must contain. The tail is chat and notification popups. */
const MASS_FRACTION = 0.96;

/** The narrowest span of a 1-D profile holding `fraction` of its total mass. */
export function densestSpan(profile: number[], fraction: number): { from: number; to: number } {
  const total = profile.reduce((a, b) => a + b, 0);
  if (total <= 0) return { from: 0, to: profile.length };
  const target = total * fraction;
  let best = { from: 0, to: profile.length };
  let from = 0;
  let sum = 0;
  for (let to = 0; to < profile.length; to++) {
    sum += profile[to]!;
    // Shrink from the left while the window still holds enough mass.
    while (sum - profile[from]! >= target) {
      sum -= profile[from]!;
      from++;
    }
    if (sum >= target && to - from + 1 < best.to - best.from) best = { from, to: to + 1 };
  }
  return best;
}

/** Per-pixel motion summed into column and row profiles, then reduced to one box. */
export function activeRegionFromFrames(
  frames: Uint8Array[],
  width: number,
  height: number,
): ActiveRegion | null {
  if (frames.length < 2) return null;
  const motion = new Float64Array(width * height);
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!;
    const b = frames[i]!;
    for (let k = 0; k < motion.length; k++) motion[k]! += Math.abs(a[k]! - b[k]!);
  }

  const columns = new Array<number>(width).fill(0);
  const rows = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = motion[y * width + x]!;
      columns[x]! += v;
      rows[y]! += v;
    }
  }

  const xs = densestSpan(columns, MASS_FRACTION);
  const ys = densestSpan(rows, MASS_FRACTION);
  if (xs.to - xs.from < 4 || ys.to - ys.from < 4) return null;
  return {
    x: xs.from / width,
    y: ys.from / height,
    w: (xs.to - xs.from) / width,
    h: (ys.to - ys.from) / height,
  };
}

function readProbeFrames(
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
        `fps=${PROBE_FPS},scale=${PROBE_WIDTH}:${PROBE_HEIGHT},format=gray`,
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
      if (code !== 0) return reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-300)}`));
      const buf = Buffer.concat(chunks);
      const size = PROBE_WIDTH * PROBE_HEIGHT;
      const out: Uint8Array[] = [];
      for (let i = 0; i + size <= buf.length; i += size) out.push(new Uint8Array(buf.subarray(i, i + size)));
      resolve(out);
    });
  });
}

/** Returns the game window as fractions of the frame, or null when it fills the frame anyway. */
export async function detectActiveRegion(
  clipPath: string,
  aroundSec: number,
  signal?: AbortSignal,
): Promise<ActiveRegion | null> {
  const frames = await readProbeFrames(clipPath, aroundSec, 12, signal).catch(() => []);
  const region = activeRegionFromFrames(frames, PROBE_WIDTH, PROBE_HEIGHT);
  if (!region) return null;
  // Cropping away a few percent is not worth a rescale, and risks trimming the HUD off a
  // stream that already fills its frame.
  return region.w > 0.92 && region.h > 0.92 ? null : region;
}

function run(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}: ${stderr}`)),
    );
  });
}

/** The two board stills: the furniture, and the hook line on its own transparent frame. */
export async function renderShortBoard(
  args: Pick<ShortRenderArgs, "board" | "durationSec" | "signal" | "onProgress">,
  boardPath: string,
  hookPath: string,
): Promise<void> {
  const serveUrl = await bundleOnce();
  const inputProps: ShortProps = { ...args.board, durationInFrames: 1, fps: FPS };
  for (const [id, output] of [
    ["Short", boardPath],
    ["ShortHook", hookPath],
  ] as const) {
    const composition = await selectComposition({ serveUrl, id, inputProps });
    await atomicOutput(output, (temp) =>
      renderStill({ composition, serveUrl, output: temp, imageFormat: "png", inputProps }),
    );
  }
  args.onProgress?.({ phase: "board", percent: 100 });
}

/**
 * One ffmpeg pass: seek each POV to the moment, scale it into its pane, stack the two, then lay
 * the board over the top. Audio is the two POVs mixed, matching the long-form.
 */
export async function compositeShort(
  args: ShortRenderArgs,
  boardPath: string,
  hookPath: string,
): Promise<void> {
  const topSeek = args.topMatchStartSec + args.startMs / 1000;
  const bottomSeek = args.bottomMatchStartSec + args.startMs / 1000;

  const [topCrop, bottomCrop] = await Promise.all([
    args.topCrop !== undefined ? args.topCrop : detectActiveRegion(args.topClipPath, topSeek, args.signal),
    args.bottomCrop !== undefined
      ? args.bottomCrop
      : detectActiveRegion(args.bottomClipPath, bottomSeek, args.signal),
  ]);
  // `increase` then centre-crop: fill the pane completely rather than letterboxing a window
  // that is not 16:9, and take the middle of it, which is where the game is.
  const paneFor = (crop: ActiveRegion | null) =>
    [
      // Fractions of the input, so this is resolution-independent.
      crop
        ? `crop=iw*${crop.w.toFixed(4)}:ih*${crop.h.toFixed(4)}:iw*${crop.x.toFixed(4)}:ih*${crop.y.toFixed(4)}`
        : null,
      `scale=${SHORT_POV_WIDTH}:${SHORT_POV_HEIGHT}:force_original_aspect_ratio=increase:flags=bicubic`,
      `crop=${SHORT_POV_WIDTH}:${SHORT_POV_HEIGHT}`,
      "setsar=1",
    ]
      .filter(Boolean)
      .join(",");

  // The hook is held flat and then faded rather than cut, so it never pops off mid-word.
  const fadeStart = Math.max(0, SHORT_HOOK_SEC - 0.4);
  const filter = [
    `color=c=0x1a1820:s=${SHORT_WIDTH}x${SHORT_HEIGHT}:d=${args.durationSec}[bg]`,
    `[0:v]${paneFor(topCrop)}[top]`,
    `[1:v]${paneFor(bottomCrop)}[bot]`,
    `[bg][top]overlay=0:${SHORT_NAMEPLATE_HEIGHT}[a]`,
    `[a][bot]overlay=0:${SHORT_NAMEPLATE_HEIGHT * 2 + SHORT_POV_HEIGHT}[b]`,
    // Both stills carry their own alpha, so a plain overlay blends them correctly.
    `[b][2:v]overlay=0:0[c]`,
    `[3:v]format=rgba,fade=t=out:st=${fadeStart}:d=0.4:alpha=1[hook]`,
    `[c][hook]overlay=0:0:enable='lt(t,${SHORT_HOOK_SEC})'[v]`,
    `[0:a][1:a]amix=inputs=2:duration=shortest:normalize=0[a_out]`,
  ].join(";");

  await atomicOutput(args.outPath, (output) =>
    run(
      "ffmpeg",
      [
        "-y",
        "-ss",
        String(topSeek),
        "-t",
        String(args.durationSec),
        "-i",
        args.topClipPath,
        "-ss",
        String(bottomSeek),
        "-t",
        String(args.durationSec),
        "-i",
        args.bottomClipPath,
        "-loop",
        "1",
        "-t",
        String(args.durationSec),
        "-i",
        boardPath,
        "-loop",
        "1",
        "-t",
        String(args.durationSec),
        "-i",
        hookPath,
        "-filter_complex",
        filter,
        "-map",
        "[v]",
        "-map",
        "[a_out]",
        "-r",
        String(FPS),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ac",
        "2",
        // Shorts are watched on phones that start playing before the file is buffered.
        "-movflags",
        "+faststart",
        output,
      ],
      args.signal,
    ),
  );
  args.onProgress?.({ phase: "compositing", percent: 100 });
}

export async function renderShort(args: ShortRenderArgs): Promise<{ path: string }> {
  const dir = path.dirname(args.outPath);
  const boardPath = path.join(dir, "short-board.png");
  const hookPath = path.join(dir, "short-hook.png");
  await renderShortBoard(args, boardPath, hookPath);
  await compositeShort(args, boardPath, hookPath);
  return { path: args.outPath };
}
