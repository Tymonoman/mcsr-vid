import { spawn } from "node:child_process";
import { renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicOutput } from "../pipeline/atomicOutput.js";
import { bundleOnce } from "../pipeline/remotionBundle.js";
import {
  SHORT_BRAND_BAR_HEIGHT,
  SHORT_BRAND_BAR_Y,
  SHORT_CLOCK_FONT_PX,
  SHORT_CLOCK_MARGIN_PX,
  SHORT_END_CARD_SEC,
  SHORT_HEIGHT,
  SHORT_NAMEPLATE_HEIGHT,
  SHORT_POV_HEIGHT,
  SHORT_POV_WIDTH,
  SHORT_SOLO_POV_HEIGHT,
  SHORT_SOLO_POV_Y,
  SHORT_WIDTH,
  SHORT_HOOK_SEC,
  SHORT_RESULT_SEC,
} from "../../remotion/layout.js";
// Type-only, and it must stay that way: Short.tsx imports overlay.css, which is a hard crash
// outside the webpack bundle (see CLAUDE.md). `import type` is erased before it can happen.
import type { ShortBoardProps, ShortStillProps } from "../../remotion/Short.js";
import type { ShortCaption } from "./shortPlan.js";

/**
 * Renders a finished, uploadable vertical Short.
 *
 * Unlike the long-form path this does not produce a Kdenlive project. A Short is 12–60 seconds
 * of fixed layout with nothing to decide, so there is nothing for an editor to do to it, and
 * going through an NLE would just insert a manual step into the one part of the pipeline that
 * can be fully automatic. ffmpeg composites the POV pane(s), the Remotion stills and the running
 * clock in a single pass.
 */

interface ShortRenderCommon {
  /** The window to cut, in ms from match start (RTA 0:00). */
  startMs: number;
  /** Any length: nothing here assumes 22 s. The picker keeps it inside SHORT_MIN_MS..SHORT_MAX_MS. */
  durationSec: number;
  /** `board.resultMs` set is what puts the closing result card on: see generateShort.ts. */
  board: Omit<ShortBoardProps, "durationInFrames" | "fps">;
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
  /**
   * With both POVs, whose audio leads: that side at full level, the other lowered
   * FOCUS_DUCK_DB before the mix. Absent: both at one level, as before. Ignored with one POV,
   * which carries only its own audio.
   */
  focus?: "left" | "right";
  /**
   * Data captions (shortPlan.ts), each on screen from its `atMs` until the next one. The first
   * replaces the hook at SHORT_HOOK_SEC whatever its own `atMs`, so the Short is never bare after
   * the hook, and the last runs until the closing card. Absent or empty: the hook fades out.
   */
  captions?: ShortCaption[];
  /** A running race clock (m:ss.cs, the match clock) in the bottom bar. Default true; false keeps the static "at m:ss". */
  clock?: boolean;
  /**
   * The closing card's text, e.g. "Who took it? Full match on the channel", on screen for the
   * last SHORT_END_CARD_SEC. Replaces the FINAL TIME card: with it, `board.resultMs` is ignored.
   */
  endCard?: string;
  outPath: string;
  onProgress?: (p: { phase: "board" | "compositing"; percent: number }) => void;
  signal?: AbortSignal;
}

/**
 * The POV clips, by slot: `top` is the left player (`match.players[0]`), `bottom` the right, as
 * generateShort.ts maps them. With `pov: "left"` only the top slot is read and with `"right"`
 * only the bottom one, so a single-POV caller may leave the other slot out.
 */
type ShortClips =
  | {
      /** Both POVs stacked (the default). */
      pov?: "both";
      /** Absolute path to the POV clip shown in the top pane, and where its match start sits in it. */
      topClipPath: string;
      topMatchStartSec: number;
      bottomClipPath: string;
      bottomMatchStartSec: number;
    }
  | {
      /** The left player's POV alone. */
      pov: "left";
      topClipPath: string;
      topMatchStartSec: number;
      bottomClipPath?: string;
      bottomMatchStartSec?: number;
    }
  | {
      /** The right player's POV alone. */
      pov: "right";
      topClipPath?: string;
      topMatchStartSec?: number;
      bottomClipPath: string;
      bottomMatchStartSec: number;
    };

export type ShortRenderArgs = ShortRenderCommon & ShortClips;

/** How far the off-focus POV is lowered before the mix. */
export const FOCUS_DUCK_DB = -12;
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
interface ActiveRegion {
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
async function detectActiveRegion(
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

/** Monocraft Bold, the board's own font, for the one line ffmpeg draws itself. */
const CLOCK_FONT = fileURLToPath(new URL("../../remotion/assets/fonts/Monocraft-Bold.ttf", import.meta.url));
/** `--gold` in overlay.source.css, the colour the static "at m:ss" label had. */
const CLOCK_COLOUR = "0xf0c93d";

/** One caption's turn on screen, in seconds of the Short. */
export interface CaptionWindow {
  caption: ShortCaption;
  fromSec: number;
  toSec: number;
}

/**
 * When each caption is on screen. In `atMs` order, each runs until the next one starts and the
 * last until `untilSec` (where the closing card starts, or the end). Nothing shows under the
 * hook: the first caption takes over from it at SHORT_HOOK_SEC even when its own `atMs` is later,
 * and a caption whose whole turn falls under the hook is superseded by the next and never shown.
 */
export function captionWindows(captions: readonly ShortCaption[], untilSec: number): CaptionWindow[] {
  const sorted = [...captions].sort((a, b) => a.atMs - b.atMs);
  const from = sorted.map((c, i) => (i === 0 ? SHORT_HOOK_SEC : Math.max(c.atMs / 1000, SHORT_HOOK_SEC)));
  return sorted
    .map((caption, i) => ({
      caption,
      fromSec: from[i]!,
      toSec: Math.min(from[i + 1] ?? untilSec, untilSec),
    }))
    .filter((w) => w.toSec > w.fromSec);
}

/**
 * drawtext's text for the running clock, m:ss.cs of the match clock: `startMs` at the Short's
 * first frame, then the frame's own time added. Escaped for a filtergraph: `\:` inside the
 * expansions, `\,` inside the expressions.
 */
export function clockText(startMs: number): string {
  const v = `(${(startMs / 1000).toFixed(3)}+t)`;
  return (
    `%{eif\\:floor(${v}/60)\\:d}\\:` +
    `%{eif\\:mod(floor(${v})\\,60)\\:d\\:2}.` +
    `%{eif\\:mod(floor(${v}*100)\\,100)\\:d\\:2}`
  );
}

/**
 * The audio graph. One POV: its own audio alone. Both: the two mixed centred and at one level
 * (the house rule for the stacked Short; only `export:fast` pans), unless a `focus` side is
 * named, in which case the other is lowered FOCUS_DUCK_DB first.
 */
export function shortAudioFilter(solo: boolean, focus?: "left" | "right"): string {
  if (solo) return "[0:a]anull[a_out]";
  const duck = `volume=${FOCUS_DUCK_DB}dB`;
  const top = focus === "right" ? `[0:a]${duck}[a0];` : "";
  const bottom = focus === "left" ? `[1:a]${duck}[a1];` : "";
  return (
    `${top}${bottom}${top ? "[a0]" : "[0:a]"}${bottom ? "[a1]" : "[1:a]"}` +
    `amix=inputs=2:duration=shortest:normalize=0[a_out]`
  );
}

/** A POV to composite: which clip, where its match starts, and the pane it fills. */
interface Pane {
  clipPath: string;
  matchStartSec: number;
  crop: ActiveRegion | null | undefined;
  y: number;
  height: number;
}

function panesOf(args: ShortRenderArgs): Pane[] {
  if (args.pov === "left") {
    return [
      {
        clipPath: args.topClipPath,
        matchStartSec: args.topMatchStartSec,
        crop: args.topCrop,
        y: SHORT_SOLO_POV_Y,
        height: SHORT_SOLO_POV_HEIGHT,
      },
    ];
  }
  if (args.pov === "right") {
    return [
      {
        clipPath: args.bottomClipPath,
        matchStartSec: args.bottomMatchStartSec,
        crop: args.bottomCrop,
        y: SHORT_SOLO_POV_Y,
        height: SHORT_SOLO_POV_HEIGHT,
      },
    ];
  }
  return [
    {
      clipPath: args.topClipPath,
      matchStartSec: args.topMatchStartSec,
      crop: args.topCrop,
      y: SHORT_NAMEPLATE_HEIGHT,
      height: SHORT_POV_HEIGHT,
    },
    {
      clipPath: args.bottomClipPath,
      matchStartSec: args.bottomMatchStartSec,
      crop: args.bottomCrop,
      y: SHORT_NAMEPLATE_HEIGHT * 2 + SHORT_POV_HEIGHT,
      height: SHORT_POV_HEIGHT,
    },
  ];
}

/** Everything the composite lays over the footage, as rendered stills and when each is on. */
interface ShortStills {
  board: string;
  hook: string;
  captions: { path: string; fromSec: number; toSec: number }[];
  /** The closing card (end card or result card) and the second it fades in; null for none. */
  card: { path: string; fromSec: number } | null;
}

/**
 * The stills, all from the one bundle and the same props: the furniture, the hook line on its
 * own transparent frame, one frame per caption, and the closing card — the end card when the
 * caller wrote one, else the result card only when the window reached the finish.
 */
async function renderStills(
  args: ShortRenderArgs,
  base: ShortStillProps,
  dir: string,
  windows: CaptionWindow[],
  card: { id: "ShortEndCard" | "ShortResult"; fromSec: number } | null,
): Promise<ShortStills> {
  const serveUrl = await bundleOnce();
  const still = async (id: string, file: string, extra: Partial<ShortStillProps> = {}): Promise<string> => {
    const output = path.join(dir, file);
    const inputProps: ShortStillProps = { ...base, ...extra };
    const composition = await selectComposition({ serveUrl, id, inputProps });
    await atomicOutput(output, (temp) =>
      renderStill({
        composition,
        serveUrl,
        output: temp,
        imageFormat: "png",
        inputProps,
      }),
    );
    return output;
  };
  const stills: ShortStills = {
    board: await still("Short", "short-board.png"),
    hook: await still("ShortHook", "short-hook.png"),
    captions: [],
    card: null,
  };
  for (const [i, w] of windows.entries()) {
    const file = await still("ShortCaption", `short-caption-${i}.png`, {
      caption: w.caption,
    });
    stills.captions.push({ path: file, fromSec: w.fromSec, toSec: w.toSec });
  }
  if (card) {
    const file = card.id === "ShortEndCard" ? "short-endcard.png" : "short-result.png";
    stills.card = { path: await still(card.id, file), fromSec: card.fromSec };
  }
  args.onProgress?.({ phase: "board", percent: 100 });
  return stills;
}

/** Seconds as ffmpeg reads them, without float noise ("3.5999999" is a valid but ugly argument). */
const sec = (s: number): string => String(Math.round(s * 1000) / 1000);

/**
 * One ffmpeg pass: seek each POV to the moment, scale it into its pane, lay the board over the
 * top, draw the clock, then switch the hook, the captions and the closing card on and off.
 */
async function compositeShort(args: ShortRenderArgs, panes: Pane[], stills: ShortStills): Promise<void> {
  const dur = args.durationSec;
  const seeks = panes.map((p) => p.matchStartSec + args.startMs / 1000);
  const crops = await Promise.all(
    panes.map((p, i) =>
      p.crop !== undefined ? p.crop : detectActiveRegion(p.clipPath, seeks[i]!, args.signal),
    ),
  );
  // `increase` then centre-crop: fill the pane completely rather than letterboxing a window
  // that is not the pane's shape, and take the middle of it, which is where the game is. For the
  // tall single pane that middle is a ~3:4 slice of a 16:9 stream: crosshair, hotbar and hearts.
  const paneFor = (crop: ActiveRegion | null, height: number) =>
    [
      // Fractions of the input, so this is resolution-independent.
      crop
        ? `crop=iw*${crop.w.toFixed(4)}:ih*${crop.h.toFixed(4)}:iw*${crop.x.toFixed(4)}:ih*${crop.y.toFixed(4)}`
        : null,
      `scale=${SHORT_POV_WIDTH}:${height}:force_original_aspect_ratio=increase:flags=bicubic`,
      `crop=${SHORT_POV_WIDTH}:${height}`,
      "setsar=1",
    ]
      .filter(Boolean)
      .join(",");

  const inputs: string[] = [];
  let count = 0;
  const input = (file: string, ...options: string[]): number => {
    inputs.push(...options, "-i", file);
    return count++;
  };
  // The POVs come first, so their audio is always [0:a] and [1:a].
  panes.forEach((p, i) => input(p.clipPath, "-ss", String(seeks[i]), "-t", String(dur)));
  // A still read once and held by overlay's default `eof_action=repeat` costs one PNG decode; a
  // looped one is decoded every frame, so only the stills that fade are looped.
  const once = (file: string): number => input(file);
  const looped = (file: string): number => input(file, "-loop", "1", "-t", String(dur));

  const graph: string[] = [
    // At the output rate: without `r` the colour source runs at 25 fps and every Short before
    // 23 Sept 2026 was 25 distinct frames a second, one in six duplicated to make 30.
    `color=c=0x1a1820:s=${SHORT_WIDTH}x${SHORT_HEIGHT}:r=${FPS}:d=${dur}[bg]`,
  ];
  let video = "[bg]";
  const then = (step: (v: string) => string) => {
    const out = `[v${graph.length}]`;
    graph.push(step(video) + out);
    video = out;
  };

  panes.forEach((p, i) => {
    graph.push(`[${i}:v]${paneFor(crops[i]!, p.height)}[pov${i}]`);
    then((v) => `${v}[pov${i}]overlay=0:${p.y}`);
  });
  // The board carries its own alpha, so a plain overlay blends it correctly.
  const board = once(stills.board);
  then((v) => `${v}[${board}:v]overlay=0:0`);

  if (args.clock ?? true) {
    const centreY = SHORT_BRAND_BAR_Y + SHORT_BRAND_BAR_HEIGHT / 2;
    then(
      (v) =>
        `${v}drawtext=fontfile='${CLOCK_FONT}':fontsize=${SHORT_CLOCK_FONT_PX}:fontcolor=${CLOCK_COLOUR}` +
        `:x=${SHORT_WIDTH - SHORT_CLOCK_MARGIN_PX}-tw:y=${centreY}-th/2:text='${clockText(args.startMs)}'`,
    );
  }

  if (stills.captions.length > 0) {
    // Replaced, not faded: the first caption takes the hook's place at SHORT_HOOK_SEC.
    const hook = once(stills.hook);
    then((v) => `${v}[${hook}:v]overlay=0:0:enable='lt(t,${SHORT_HOOK_SEC})'`);
  } else {
    // No caption to take over, so the hook is held flat and then faded rather than cut, and it
    // never pops off mid-word.
    const hook = looped(stills.hook);
    graph.push(`[${hook}:v]format=rgba,fade=t=out:st=${sec(SHORT_HOOK_SEC - 0.4)}:d=0.4:alpha=1[hook]`);
    then((v) => `${v}[hook]overlay=0:0:enable='lt(t,${SHORT_HOOK_SEC})'`);
  }
  for (const c of stills.captions) {
    const n = once(c.path);
    then((v) => `${v}[${n}:v]overlay=0:0:enable='gte(t,${sec(c.fromSec)})*lt(t,${sec(c.toSec)})'`);
  }
  if (stills.card) {
    // Faded up over a third of a second and then held flat to the hard cut, which is what all
    // three reference Shorts do with their closing card.
    const card = looped(stills.card.path);
    graph.push(`[${card}:v]format=rgba,fade=t=in:st=${sec(stills.card.fromSec)}:d=0.3:alpha=1[card]`);
    then((v) => `${v}[card]overlay=0:0:enable='gt(t,${sec(stills.card!.fromSec)})'`);
  }
  graph.push(shortAudioFilter(panes.length === 1, args.focus));

  await atomicOutput(args.outPath, (output) =>
    run(
      "ffmpeg",
      [
        "-y",
        ...inputs,
        "-filter_complex",
        graph.join(";"),
        "-map",
        video,
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
  const pov = args.pov ?? "both";
  const captions = args.captions ?? [];
  // The closing card: the caller's end card, else FINAL TIME only when the window reached the
  // finish (`board.resultMs`), else none. Captions stop where it starts.
  const card = args.endCard
    ? {
        id: "ShortEndCard" as const,
        fromSec: Math.max(0, args.durationSec - SHORT_END_CARD_SEC),
      }
    : args.board.resultMs !== undefined
      ? {
          id: "ShortResult" as const,
          fromSec: Math.max(0, args.durationSec - SHORT_RESULT_SEC),
        }
      : null;
  const windows = captionWindows(captions, card?.fromSec ?? args.durationSec);
  const base: ShortStillProps = {
    ...args.board,
    pov,
    clock: args.clock ?? true,
    captionStrip: pov === "both" && windows.length > 0,
    ...(args.endCard ? { endCard: args.endCard } : {}),
    durationInFrames: 1,
    fps: FPS,
  };
  const stills = await renderStills(args, base, path.dirname(args.outPath), windows, card);
  await compositeShort(args, panesOf(args), stills);
  return { path: args.outPath };
}
