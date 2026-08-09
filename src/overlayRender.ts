import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderMedia, selectComposition } from "@remotion/renderer";
import { config } from "./config.js";
import { computeOverlayProps } from "./overlayProps.js";
import { POST_ROLL_SEC, estimatedRunSec } from "./vodAcquisition.js";
import type { MatchInfo, UserDetails, VersusStats } from "./types.js";

const FPS = config.overlayFps;
// The VOD clips carry `PRE_ROLL_SEC` (sync-search headroom); the overlay only needs a short
// pause before the timer starts, so it renders that instead of ~2.5min of a frozen 0:00.000.
const LEAD_IN_SEC = config.overlayLeadInSec;

export interface RenderProgress {
  phase: "bundling" | "rendering";
  percent: number;
}

export interface RenderOverlayArgs {
  match: MatchInfo;
  userLeft: UserDetails;
  userRight: UserDetails;
  versus: VersusStats;
  outPath: string;
  onProgress?: (p: RenderProgress) => void;
  signal?: AbortSignal;
}

export interface RenderOverlayResult {
  path: string;
  matchOffsetIntoClipSec: number;
  durationInFrames: number;
  fps: number;
}

// Same webpack override as remotion.config.ts, duplicated here because that config file is only
// auto-loaded by the `remotion` CLI, not importable from a programmatic bundle() call.
function webpackOverride(config: Record<string, unknown>): Record<string, unknown> {
  const resolve = (config.resolve as Record<string, unknown>) ?? {};
  return {
    ...config,
    resolve: { ...resolve, extensionAlias: { ".js": [".js", ".ts", ".tsx"] } },
  };
}

export async function renderOverlay(args: RenderOverlayArgs): Promise<RenderOverlayResult> {
  const props = await computeOverlayProps(args.match, args.userLeft, args.userRight, args.versus);
  const runSec = estimatedRunSec(args.match);
  const durationInFrames = Math.round((LEAD_IN_SEC + runSec + POST_ROLL_SEC) * FPS);
  const timerStartFrame = Math.round(LEAD_IN_SEC * FPS);
  const renderProps = { ...props, timerStartFrame, durationInFrames, fps: FPS };

  const { cancelSignal, cancel } = makeCancelSignal();
  const onAbort = () => cancel();
  args.signal?.addEventListener("abort", onAbort);

  try {
    const serveUrl = await bundle(
      new URL("../remotion/index.ts", import.meta.url).pathname,
      (percent) => args.onProgress?.({ phase: "bundling", percent }),
      {
        webpackOverride: webpackOverride as never,
        // Mirrors Config.setPublicDir() in remotion.config.ts. That config is only auto-loaded
        // by the `remotion` CLI, so without this staticFile() (achievement badges) resolves
        // against a project-root public/ that doesn't exist and the icons 404 at render time.
        publicDir: new URL("../remotion/assets", import.meta.url).pathname,
      },
    );

    const composition = await selectComposition({ serveUrl, id: "MatchOverlay", inputProps: renderProps });

    await renderMedia({
      composition,
      serveUrl,
      codec: "prores",
      proResProfile: "4444",
      // Both of these are load-bearing for transparency. Remotion captures frames as JPEG by
      // default, which has no alpha channel, so the overlay's transparent regions get baked to
      // black and ffmpeg then silently downgrades the output to ProRes 422 HQ (apch) since the
      // pixel format carries no alpha. Renders looked fine in isolation but covered the gameplay
      // with a black rectangle once composited in Kdenlive.
      imageFormat: "png",
      pixelFormat: "yuva444p10le",
      // The overlay is silent; without this Remotion muxes an empty PCM track (~140MB/render).
      muted: true,
      ...(config.renderConcurrency !== null ? { concurrency: config.renderConcurrency } : {}),
      outputLocation: args.outPath,
      inputProps: renderProps,
      cancelSignal,
      onProgress: ({ progress }) =>
        args.onProgress?.({ phase: "rendering", percent: Math.round(progress * 100) }),
    });
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }

  return { path: args.outPath, matchOffsetIntoClipSec: LEAD_IN_SEC, durationInFrames, fps: FPS };
}
