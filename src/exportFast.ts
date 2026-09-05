import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { placeOnTimeline, type KdenliveClipInput } from "./kdenliveProject.js";
import {
  BOTTOM_BAND_HEIGHT,
  POV_HEIGHT,
  POV_WIDTH,
  RTA_COL_WIDTH,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  STATIC_COL_WIDTH,
  TOP_BAND_HEIGHT,
} from "../remotion/layout.js";

/**
 * Renders the finished video with one ffmpeg pass instead of melt.
 *
 * melt spends its time compositing five layers through `qtblend`, which alpha-blends every one
 * of them over the whole frame. It does not need to: the layers *tile* the frame exactly
 * (194 + 540 + 346 = 1080, and 1440 + 480 = 1920, both pinned by remotion/layout.test.ts), so
 * four of the five are `hstack`/`vstack` — a memcpy — and only the intro, which genuinely fades,
 * needs a real alpha composite.
 *
 * Measured on the lab, 1800 frames: 45.1s here against melt's 171-214s. A full match goes from
 * roughly 49 minutes to 13.
 *
 * This does not replace the Kdenlive project — that is still what you open when a match needs a
 * human. Both are built from `placeOnTimeline`, so they place every clip identically; deriving
 * the timeline twice is exactly how the two would drift apart.
 */

export interface FastExportInput {
  leftClip: KdenliveClipInput;
  rightClip: KdenliveClipInput;
  /** The static top band. */
  topPath: string;
  /** Splits stills in timeline order, each held for its own span. */
  splits: Array<{ path: string; startSec: number; durationSec: number }>;
  /** The RTA column video. */
  timerPath: string;
  /** The intro card — the one layer that really is alpha-composited. */
  introPath: string;
  introOffsetSec: number;
  fps: number;
  totalDurationSec: number;
  outPath: string;
  /** Hardware H.264 encode. Falls back to libx264 when the render node is absent. */
  useVaapi?: boolean;
}

export interface BuiltCommand {
  args: string[];
  /** For the log, and for a human to sanity-check what was assembled. */
  description: string;
}

/**
 * A still that has to fill `frames` frames of a 60fps timeline.
 *
 * `loop` after `scale` so the PNG is decoded and converted exactly once and the cached frame is
 * repeated — decoding the stills per frame measured 74s of CPU per 1800 frames, more than both
 * 1080p60 POV decodes put together, and it is invisible until measured.
 *
 * `settb` must come before `setpts`: `TB` in `setpts` would otherwise resolve against the image
 * demuxer's 1/25 default, producing non-monotonic timestamps that framesync silently drops
 * downstream (measured: 1594 of 3400 frames gone, with no error).
 */
function stillChain(index: number, width: number, height: number, frames: number, fps: number): string {
  return (
    `[${index}:v]scale=${width}:${height}:flags=bilinear,format=yuv420p,setsar=1,` +
    `loop=loop=${Math.max(0, frames - 1)}:size=1:start=0,settb=1/${fps},setpts=N/${fps}/TB`
  );
}

export function buildFastExportCommand(input: FastExportInput): BuiltCommand {
  const { fps } = input;
  const left = placeOnTimeline(input.leftClip);
  const right = placeOnTimeline(input.rightClip);

  const args: string[] = ["-hide_banner", "-y"];
  if (input.useVaapi) {
    args.push("-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va");
  }
  // -ss before -i so the decoder seeks rather than decoding and discarding the head.
  args.push("-ss", left.inSec.toFixed(3), "-i", input.leftClip.path);
  args.push("-ss", right.inSec.toFixed(3), "-i", input.rightClip.path);
  args.push("-i", input.topPath);
  args.push("-i", input.timerPath);
  args.push("-i", input.introPath);
  for (const still of input.splits) args.push("-i", still.path);

  const SPLIT_BASE = 5;
  const chains: string[] = [];

  // force_original_aspect_ratio=decrease + pad, not a bare scale: melt's qtblend with
  // distort=0 letterboxes into the rect, and yt-dlp downloads whatever the streamer broadcast
  // (`-f bv*+ba/b`). A 1600x900 VOD would be stretched by a bare scale and letterboxed by melt —
  // silently different, and only on some matches.
  const povChain = (index: number, label: string) =>
    `[${index}:v]scale=${POV_WIDTH}:${POV_HEIGHT}:force_original_aspect_ratio=decrease:flags=bilinear,` +
    `pad=${POV_WIDTH}:${POV_HEIGHT}:-1:-1:color=black,setsar=1,format=yuv420p,fps=${fps},settb=1/${fps}[${label}]`;
  chains.push(povChain(0, "L"), povChain(1, "R"), `[L][R]hstack=inputs=2[POV]`);

  const totalFrames = Math.round(input.totalDurationSec * fps);
  chains.push(`${stillChain(2, STAGE_WIDTH, TOP_BAND_HEIGHT, totalFrames, fps)}[TOP]`);

  // The splits band is a sequence of stills concatenated to the full timeline length.
  const splitLabels: string[] = [];
  input.splits.forEach((still, i) => {
    const frames = Math.max(1, Math.round(still.durationSec * fps));
    chains.push(`${stillChain(SPLIT_BASE + i, STATIC_COL_WIDTH, BOTTOM_BAND_HEIGHT, frames, fps)}[S${i}]`);
    splitLabels.push(`[S${i}]`);
  });
  chains.push(`${splitLabels.join("")}concat=n=${input.splits.length}:v=1:a=0,settb=1/${fps}[SPL]`);

  chains.push(
    `[3:v]scale=${RTA_COL_WIDTH}:${BOTTOM_BAND_HEIGHT}:flags=bilinear,format=yuv420p,setsar=1,` +
      `fps=${fps},settb=1/${fps},setpts=N/${fps}/TB[RTA]`,
  );
  chains.push(`[SPL][RTA]hstack=inputs=2[BAND]`);
  chains.push(`[TOP][POV][BAND]vstack=inputs=3[STAGE]`);

  // The only genuine alpha composite in the whole graph. eof_action=pass so the stage continues
  // once the 7-second card is over; repeatlast=0 so its last frame is not held over the match.
  chains.push(
    `[4:v]format=yuva420p,setsar=1,fps=${fps},settb=1/${fps},setpts=N/${fps}/TB+${input.introOffsetSec}/TB[INTRO]`,
  );
  const videoOut = input.useVaapi ? "[STAGEI]" : "[V]";
  chains.push(`[STAGE][INTRO]overlay=0:0:format=yuv420:eof_action=pass:repeatlast=0${videoOut}`);
  if (input.useVaapi) chains.push(`[STAGEI]format=nv12,hwupload[V]`);

  // normalize=0 because MLT's `mix` transition sums its inputs (sum=1); ffmpeg's amix halves
  // each by default, which would quietly drop both POVs 6dB relative to the Kdenlive export.
  chains.push(`[0:a][1:a]amix=inputs=2:duration=longest:normalize=0,aresample=48000:async=1:first_pts=0[A]`);

  args.push("-filter_complex", chains.join(";"));
  args.push("-map", "[V]", "-map", "[A]");
  args.push("-t", input.totalDurationSec.toFixed(3), "-r", String(fps), "-fps_mode", "cfr");
  args.push("-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv");
  if (input.useVaapi) {
    // Measured 9.5ms CPU/frame against libx264 veryfast's 43.8ms. Encode only: this GPU exposes
    // no VAAPI VPP entrypoints (`vainfo | grep -c VideoProc` is 0), so frames cannot be scaled
    // on it, and hardware *decode* then loses more to the 8.1ms/frame download than it saves.
    args.push("-c:v", "h264_vaapi", "-rc_mode", "CQP", "-qp", "23", "-profile:v", "high", "-bf", "0");
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p");
  }
  args.push("-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart");
  args.push(input.outPath);

  return {
    args,
    description:
      `${input.splits.length} split stills, ${input.totalDurationSec.toFixed(1)}s at ${fps}fps, ` +
      `${input.useVaapi ? "h264_vaapi" : "libx264"}`,
  };
}

/** True when the VAAPI render node is present and ffmpeg was built with the encoder. */
export function vaapiAvailable(): boolean {
  return existsSync("/dev/dri/renderD128");
}

export async function runFastExport(
  input: FastExportInput,
  onLine?: (line: string) => void,
): Promise<{ path: string }> {
  // Same promote-only-on-success gate as atomicOutput and scripts/export.sh: every stage check
  // in this project is existsSync, so a truncated file under the final name is trusted forever.
  const partPath = `${input.outPath.replace(/\.mp4$/, "")}.part.mp4`;
  const { args, description } = buildFastExportCommand({ ...input, outPath: partPath });
  onLine?.(`ffmpeg: ${description}`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [...args, "-stats"], { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    proc.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split(/[\r\n]/)) if (line.startsWith("frame=")) onLine?.(line.trim());
    });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}:\n${tail}`)),
    );
  });

  const { rename } = await import("node:fs/promises");
  await rename(partPath, input.outPath);
  return { path: input.outPath };
}

export const exportOutputPath = (outDir: string, matchId: number): string =>
  path.join(outDir, `final-${matchId}.mp4`);
