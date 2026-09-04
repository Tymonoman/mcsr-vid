import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderStill, selectComposition } from "@remotion/renderer";
import { atomicOutput } from "./atomicOutput.js";
import { computeThumbnailProps } from "./thumbnailProps.js";
import type { MatchInfo, UserDetails } from "./types.js";

/**
 * `renderStill` has no progress API, so the webpack bundle is the only sub-step that can report
 * anything — and it is also the slow one, which is why the thumbnail stage used to sit at no
 * percent at all for most of its run.
 */
export interface ThumbnailProgress {
  phase: "bundling" | "rendering";
  percent: number;
}

export interface RenderThumbnailArgs {
  match: MatchInfo;
  userLeft: UserDetails;
  userRight: UserDetails;
  outPath: string;
  onProgress?: (p: ThumbnailProgress) => void;
  signal?: AbortSignal;
}

export interface RenderThumbnailResult {
  path: string;
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

export async function renderThumbnail(args: RenderThumbnailArgs): Promise<RenderThumbnailResult> {
  const props = await computeThumbnailProps(args.match, args.userLeft, args.userRight);
  const renderProps = { ...props };

  const { cancelSignal, cancel } = makeCancelSignal();
  const onAbort = () => cancel();
  args.signal?.addEventListener("abort", onAbort);

  try {
    const serveUrl = await bundle(
      new URL("../remotion/index.ts", import.meta.url).pathname,
      (percent) => args.onProgress?.({ phase: "bundling", percent }),
      {
        webpackOverride: webpackOverride as never,
        // See overlayRender.ts: remotion.config.ts's setPublicDir is CLI-only, so staticFile()
        // needs the public dir passed explicitly on programmatic bundles too.
        publicDir: new URL("../remotion/assets", import.meta.url).pathname,
      },
    );

    const composition = await selectComposition({ serveUrl, id: "Thumbnail", inputProps: renderProps });

    args.onProgress?.({ phase: "rendering", percent: 0 });
    await atomicOutput(args.outPath, (output) =>
      renderStill({
        composition,
        serveUrl,
        output,
        inputProps: renderProps,
        cancelSignal,
      }),
    );
    args.onProgress?.({ phase: "rendering", percent: 100 });
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }

  return { path: args.outPath };
}
