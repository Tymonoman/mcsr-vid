import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderMedia, selectComposition } from "@remotion/renderer";
import { computeOverlayProps } from "./overlayProps.js";
import { PRE_ROLL_SEC, POST_ROLL_SEC, estimatedRunSec } from "./vodAcquisition.js";
import type { MatchInfo, UserDetails, VersusStats } from "./types.js";

const FPS = 60;

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
  const durationInFrames = Math.round((PRE_ROLL_SEC + runSec + POST_ROLL_SEC) * FPS);
  const timerStartFrame = Math.round(PRE_ROLL_SEC * FPS);
  const renderProps = { ...props, timerStartFrame, durationInFrames };

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
      outputLocation: args.outPath,
      inputProps: renderProps,
      cancelSignal,
      onProgress: ({ progress }) =>
        args.onProgress?.({ phase: "rendering", percent: Math.round(progress * 100) }),
    });
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }

  return { path: args.outPath, matchOffsetIntoClipSec: PRE_ROLL_SEC, durationInFrames, fps: FPS };
}
