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
  timer: path.join(outDir, "overlay-timer.mov"),
  intro: path.join(outDir, "overlay-intro.mov"),
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
        codec: "prores",
        proResProfile: "4444",
        // The intro genuinely needs alpha: it fades to transparent to reveal the gameplay
        // underneath. It is 7 seconds, so the cost of carrying an alpha channel is bounded.
        imageFormat: "png",
        pixelFormat: "yuva444p10le",
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
        codec: "prores",
        // 4:4:4 10-bit, so the gold-on-dark pixel text keeps full chroma resolution, but with
        // no alpha plane: the bottom band is a solid panel, every pixel of it opaque (asserted
        // in overlayRender.test.ts). It used to be rendered yuva444p10le — a full alpha channel,
        // uniformly 255, across every frame of the match.
        proResProfile: "4444",
        pixelFormat: "yuv444p10le",
        // PNG, not JPEG: the overlay is pixel-art text and JPEG's 4:2:0 softens its edges.
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
