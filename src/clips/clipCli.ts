/**
 * npm run clip -- <twitch url or local file> [--from=HH:MM:SS --to=HH:MM:SS] --title="…"
 *   --speaker="…" --when="…" --credit="…" [--slug=…] [--seconds=N]
 *
 * Turns a standalone clip — a stream statement, a reaction, anything that is not a match — into
 * a video in the channel's own look: the ClipFrame overlay (remotion/ClipFrame.tsx) framing the
 * footage, composited with ffmpeg. Nothing here uploads anywhere; the operator reviews the file
 * and publishes it by hand, the same as every other export in this repo.
 *
 * source is a Twitch URL (a VOD, trimmed to --from/--to via yt-dlp's --download-sections; a
 * clip URL is already trimmed and normally wants neither) or a local file. Either way the exact
 * window ends up at <mediaDir>/clips/<slug>/source.mp4, which the composite step reads — so a
 * failed or re-run composite never re-downloads.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderStill, selectComposition } from "@remotion/renderer";
import { atomicOutput } from "../pipeline/atomicOutput.js";
import { bundleOnce } from "../pipeline/remotionBundle.js";
import { config } from "../config.js";
import { parseClipArgs } from "./clipArgs.js";
import {
  STAGE_WIDTH,
  STAGE_HEIGHT,
  CLIP_WINDOW_X,
  CLIP_WINDOW_Y,
  CLIP_WINDOW_WIDTH,
  CLIP_WINDOW_HEIGHT,
} from "../../remotion/layout.js";
import type { ClipFrameProps } from "../../remotion/types.js";

/** `--panel` in overlay.source.css: the ground colour behind the window, and the pad colour for
 *  any letterbox bars inside it, so both read as the same fill. */
const GROUND_COLOR = "0x221f27";

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}: ${stderr}`)),
    );
  });
}

function probeDurationSec(file: string): number {
  const { stdout } = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
    { encoding: "utf8" },
  );
  const sec = Number(stdout?.trim());
  if (!Number.isFinite(sec) || sec <= 0) throw new Error(`ffprobe could not read a duration from ${file}`);
  return sec;
}

/** Downloads (or trims, or copies) the exact window into <outDir>/source.mp4. */
async function acquireSource(
  source: string,
  fromSec: number | undefined,
  toSec: number | undefined,
  outDir: string,
): Promise<string> {
  const sourcePath = path.join(outDir, "source.mp4");
  if (/^https?:\/\//.test(source)) {
    const template = path.join(outDir, "source.%(ext)s");
    const args = [
      "-f",
      "bv*[height<=1080]+ba/b[height<=1080]",
      "--merge-output-format",
      "mp4",
      "--no-part",
      "--force-overwrites",
      "-o",
      template,
    ];
    if (fromSec !== undefined && toSec !== undefined) {
      args.push("--download-sections", `*${fromSec}-${toSec}`);
    }
    args.push(source);
    await run("yt-dlp", args);
    return sourcePath;
  }

  if (!existsSync(source)) throw new Error(`no such file: ${source}`);
  if (fromSec !== undefined && toSec !== undefined) {
    // -c copy: a fast, keyframe-rounded trim. Good enough for a manual clip tool — the composite
    // pass re-encodes the whole thing anyway.
    await run("ffmpeg", [
      "-y",
      "-ss",
      String(fromSec),
      "-to",
      String(toSec),
      "-i",
      source,
      "-c",
      "copy",
      sourcePath,
    ]);
  } else {
    await copyFile(source, sourcePath);
  }
  return sourcePath;
}

async function renderFrame(outDir: string, props: ClipFrameProps): Promise<string> {
  const framePath = path.join(outDir, "frame.png");
  const serveUrl = await bundleOnce();
  const composition = await selectComposition({ serveUrl, id: "ClipFrame", inputProps: props });
  await atomicOutput(framePath, (output) =>
    renderStill({ composition, serveUrl, output, imageFormat: "png", inputProps: props }),
  );
  return framePath;
}

/**
 * A flat ground background, the source scaled into the window rect, the frame PNG on top, the
 * source's own audio — encoded like export:fast's CPU path (libx264 veryfast/crf21, aac 160k).
 */
function buildCompositeArgs(
  sourcePath: string,
  framePath: string,
  outPath: string,
  durationSec: number,
): string[] {
  const chains = [
    `[1:v]scale=${CLIP_WINDOW_WIDTH}:${CLIP_WINDOW_HEIGHT}:force_original_aspect_ratio=decrease:flags=bilinear,` +
      `pad=${CLIP_WINDOW_WIDTH}:${CLIP_WINDOW_HEIGHT}:-1:-1:color=${GROUND_COLOR},setsar=1,format=yuv420p,fps=30[SRC]`,
    `[0:v][SRC]overlay=${CLIP_WINDOW_X}:${CLIP_WINDOW_Y}:format=yuv420[BGSRC]`,
    `[2:v]format=yuva420p[FRAME]`,
    `[BGSRC][FRAME]overlay=0:0:format=yuv420[V]`,
  ];
  return [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${GROUND_COLOR}:s=${STAGE_WIDTH}x${STAGE_HEIGHT}:r=30`,
    "-i",
    sourcePath,
    "-loop",
    "1",
    "-i",
    framePath,
    "-filter_complex",
    chains.join(";"),
    "-map",
    "[V]",
    "-map",
    "1:a",
    "-t",
    durationSec.toFixed(3),
    "-r",
    "30",
    "-fps_mode",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    outPath,
  ];
}

async function main(): Promise<void> {
  const args = parseClipArgs(process.argv.slice(2));
  const outDir = path.join(config.mediaDir, "clips", args.slug);
  await mkdir(outDir, { recursive: true });

  const startedAt = Date.now();
  console.log(`source -> ${outDir}/source.mp4`);
  const sourcePath = await acquireSource(args.source, args.fromSec, args.toSec, outDir);

  console.log("rendering the frame...");
  const framePath = await renderFrame(outDir, {
    title: args.title,
    speaker: args.speaker,
    when: args.when,
    credit: args.credit,
  });

  const sourceDurationSec = probeDurationSec(sourcePath);
  const durationSec = args.seconds ? Math.min(args.seconds, sourceDurationSec) : sourceDurationSec;
  const outName = args.seconds ? `smoke-${args.slug}.mp4` : `clip-${args.slug}.mp4`;
  const outPath = path.join(outDir, outName);

  console.log(`compositing ${durationSec.toFixed(1)}s...`);
  await atomicOutput(outPath, (temp) =>
    run("ffmpeg", buildCompositeArgs(sourcePath, framePath, temp, durationSec)),
  );

  const descriptionPath = path.join(outDir, "description.txt");
  await writeFile(descriptionPath, `Original stream: ${args.credit}\n${args.source}\n`, "utf8");

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.log(`done in ${elapsedSec.toFixed(1)}s`);
  console.log(`  source:      ${sourcePath}`);
  console.log(`  frame:       ${framePath}`);
  console.log(`  video:       ${outPath}`);
  console.log(`  description: ${descriptionPath}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
