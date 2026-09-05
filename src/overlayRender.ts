import { makeCancelSignal, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { INTRO_SECONDS } from "../remotion/layout.js";
import { atomicOutput } from "./atomicOutput.js";
import { config } from "./config.js";
import { computeOverlayProps } from "./overlayProps.js";
import { bundleOnce } from "./remotionBundle.js";
import { splitSegments } from "./splitStates.js";
import { POST_ROLL_SEC, estimatedRunSec } from "./vodAcquisition.js";
import type { MatchInfo, UserDetails, VersusStats } from "./types.js";

const FPS = config.overlayFps;
// The VOD clips carry `PRE_ROLL_SEC` (sync-search headroom); the overlay only needs a short
// pause before the timer starts, so it renders that instead of ~2.5min of a frozen 0:00.000.
const LEAD_IN_SEC = config.overlayLeadInSec;

/**
 * Four sub-steps, reported separately because they are wildly uneven in cost and only two of
 * them can report granular progress. Callers weight them into a single bar (see pipeline.ts);
 * reporting a bare 0-100 per phase used to make the overlay bar climb to 100, reset to 0, and
 * then stall silently through `top` and `intro`, which have no per-frame callback of their own.
 */
export interface RenderProgress {
  phase: "bundling" | "top" | "splits" | "intro" | "rendering";
  percent: number;
}

/** One still of the splits region, and the span of the timeline it is held for. */
export interface SplitStill {
  path: string;
  startSec: number;
  durationSec: number;
}

/** Sidecar recording the split stills, so a re-run can reuse a render whose still count varies. */
export const SPLITS_MANIFEST = "overlay-splits.json";

export interface RenderOverlayArgs {
  match: MatchInfo;
  userLeft: UserDetails;
  userRight: UserDetails;
  versus: VersusStats;
  /** Directory every overlay artifact is written into. */
  outDir: string;
  onProgress?: (p: RenderProgress) => void;
  signal?: AbortSignal;
}

export interface RenderOverlayResult {
  /** RTA column — the only part rendered per frame. */
  timerPath: string;
  topPath: string;
  introPath: string;
  /** Meta + splits region, as stills held across the frames where nothing changes. */
  splits: SplitStill[];
  matchOffsetIntoClipSec: number;
  durationInFrames: number;
  introDurationSec: number;
  fps: number;
}

export const overlayPaths = (outDir: string) => ({
  top: path.join(outDir, "overlay-top.png"),
  timer: path.join(outDir, "overlay-timer.mp4"),
  intro: path.join(outDir, "overlay-intro.webm"),
  manifest: path.join(outDir, SPLITS_MANIFEST),
});

/** The split stills recorded by a previous run, or null if this match has not been rendered. */
export async function readSplitStills(outDir: string): Promise<SplitStill[] | null> {
  const file = overlayPaths(outDir).manifest;
  if (!existsSync(file)) return null;
  try {
    const stills = JSON.parse(await readFile(file, "utf8")) as SplitStill[];
    // A manifest naming a still that is not on disk is worse than no manifest: the pipeline
    // would place a clip pointing at nothing and the band would silently vanish mid-match.
    return stills.every((s) => existsSync(s.path)) ? stills : null;
  } catch {
    return null;
  }
}

export async function renderOverlay(args: RenderOverlayArgs): Promise<RenderOverlayResult> {
  const props = await computeOverlayProps(args.match, args.userLeft, args.userRight, args.versus);
  const runSec = estimatedRunSec(args.match);
  const durationInFrames = Math.round((LEAD_IN_SEC + runSec + POST_ROLL_SEC) * FPS);
  const timerStartFrame = Math.round(LEAD_IN_SEC * FPS);
  const renderProps = { ...props, timerStartFrame, durationInFrames, fps: FPS };
  const out = overlayPaths(args.outDir);

  const { cancelSignal, cancel } = makeCancelSignal();
  const onAbort = () => cancel();
  args.signal?.addEventListener("abort", onAbort);

  let stills: SplitStill[] = [];
  try {
    const serveUrl = await bundleOnce((percent) => args.onProgress?.({ phase: "bundling", percent }));

    // The static top band is one still image held for the whole clip in the NLE, not ~17k
    // identical video frames.
    // renderStill has no progress API, so this phase can only bracket itself. Reporting the
    // bracket still beats silence: without it the bar sat frozen here with no way to tell a
    // slow still from a hung one.
    args.onProgress?.({ phase: "top", percent: 0 });
    const topComposition = await selectComposition({ serveUrl, id: "OverlayTop", inputProps: renderProps });
    await atomicOutput(out.top, (output) =>
      renderStill({
        composition: topComposition,
        serveUrl,
        output,
        imageFormat: "png",
        inputProps: renderProps,
        cancelSignal,
      }),
    );
    args.onProgress?.({ phase: "top", percent: 100 });

    // The meta + splits region changes only when a split is revealed — a handful of times in a
    // match — so it is rendered as one still per distinct state and held across the frames
    // between. This is what takes the per-frame render down to the RTA column alone.
    const segments = splitSegments(renderProps);
    const splitsComposition = await selectComposition({
      serveUrl,
      id: "OverlaySplits",
      inputProps: renderProps,
    });
    stills = [];
    for (const [i, segment] of segments.entries()) {
      args.onProgress?.({ phase: "splits", percent: Math.round((i / segments.length) * 100) });
      const file = path.join(args.outDir, `overlay-splits-${i}.png`);
      await atomicOutput(file, (output) =>
        renderStill({
          composition: splitsComposition,
          serveUrl,
          output,
          imageFormat: "png",
          frame: segment.startFrame,
          inputProps: renderProps,
          cancelSignal,
        }),
      );
      stills.push({
        path: file,
        startSec: segment.startFrame / FPS,
        durationSec: (segment.endFrame - segment.startFrame) / FPS,
      });
    }
    args.onProgress?.({ phase: "splits", percent: 100 });

    const introComposition = await selectComposition({
      serveUrl,
      id: "OverlayIntro",
      inputProps: renderProps,
    });
    await atomicOutput(out.intro, (outputLocation) =>
      renderMedia({
        composition: introComposition,
        serveUrl,
        // VP9, because it is the only alpha format Remotion can emit that MLT actually
        // composites. This was ProRes 4444, and MLT silently discards its alpha: measured
        // through the real project emitter at the intro's fade-out, where the card is 11%
        // opaque, melt returned the card's own colour (57,30,36) instead of the gameplay
        // underneath (121,118,121). So the 0.25s fade-in and 0.6s wipe-out have been rendering
        // as hard cuts in every export. qtrle and png-in-mov also composite correctly but are
        // 209-235 MB for these seven seconds against VP9's 2.9 MB.
        //
        // Spot-checking this file with plain ffmpeg will look like the alpha is missing:
        // FFmpeg's native vp9 decoder drops the alpha side-data and only libvpx-vp9 reads it.
        // MLT picks the right one.
        codec: "vp9",
        // The intro genuinely needs alpha: it fades to transparent to reveal the gameplay.
        imageFormat: "png",
        pixelFormat: "yuva420p",
        muted: true,
        ...(config.renderConcurrency !== null ? { concurrency: config.renderConcurrency } : {}),
        outputLocation,
        inputProps: renderProps,
        cancelSignal,
        onProgress: ({ progress }) =>
          args.onProgress?.({ phase: "intro", percent: Math.round(progress * 100) }),
      }),
    );

    const timerComposition = await selectComposition({
      serveUrl,
      id: "OverlayTimer",
      inputProps: renderProps,
    });
    await atomicOutput(out.timer, (outputLocation) =>
      renderMedia({
        composition: timerComposition,
        serveUrl,
        // H.264, not ProRes, and the reason is throughput rather than size. Remotion can only
        // stream frames straight into ffmpeg for h264/h265 (canUseParallelEncoding); with ProRes
        // every single frame is written to a temp PNG and read back with -f image2. Measured
        // back to back on the lab, 450 frames of this composition: 16.98 fps ProRes vs 32.51 fps
        // H.264 — 1.9x, for a file three orders of magnitude smaller.
        codec: "h264",
        // 4:4:4, so the gold-on-dark pixel text keeps full chroma resolution. Measured against a
        // lossless still of the same frame, 4:4:4 at this CRF is 51 dB PSNR / 0.999 SSIM —
        // transparent — while 4:2:0 costs 13 dB and visibly softens the digits.
        pixelFormat: "yuv444p",
        crf: 14,
        // No alpha plane: the bottom band is a solid panel, every pixel of it opaque (pinned by
        // overlayRender.test.ts). It used to be ProRes 4444 with yuva444p10le — a full alpha
        // channel, uniformly 255, across all ~17k frames of the match.
        // PNG capture, not JPEG: the overlay is pixel-art text and JPEG's 4:2:0 softens its
        // edges for no measurable throughput gain.
        imageFormat: "png",
        // The overlay is silent; without this Remotion muxes an empty PCM track (~140MB/render).
        muted: true,
        ...(config.renderConcurrency !== null ? { concurrency: config.renderConcurrency } : {}),
        outputLocation,
        inputProps: renderProps,
        cancelSignal,
        onProgress: ({ progress }) =>
          args.onProgress?.({ phase: "rendering", percent: Math.round(progress * 100) }),
      }),
    );

    // Written last, and only once every still exists, so its presence means the whole render
    // finished — the same contract atomicOutput gives each individual artifact.
    await atomicOutput(out.manifest, (temp) => writeFile(temp, JSON.stringify(stills, null, 2), "utf8"));
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }

  return {
    timerPath: out.timer,
    topPath: out.top,
    introPath: out.intro,
    splits: stills,
    matchOffsetIntoClipSec: LEAD_IN_SEC,
    durationInFrames,
    introDurationSec: INTRO_SECONDS,
    fps: FPS,
  };
}
