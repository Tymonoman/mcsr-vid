import { bundle } from "@remotion/bundler";

/**
 * One webpack bundle per process, shared by every renderer.
 *
 * `remotion.config.ts` is only auto-loaded by the `remotion` CLI, so a programmatic `bundle()`
 * call has to repeat its two settings — which is why this lived, copy-pasted, in both
 * overlayRender.ts and thumbnailVariants.ts. Worse than the duplication: a pipeline run bundled
 * twice (once for the overlay, once for the thumbnails) and paid the same ~10-30s twice for a
 * byte-identical result, because the bundle depends only on the source tree, never on the match.
 */
export function webpackOverride(config: Record<string, unknown>): Record<string, unknown> {
  const resolve = (config.resolve as Record<string, unknown>) ?? {};
  return {
    ...config,
    resolve: { ...resolve, extensionAlias: { ".js": [".js", ".ts", ".tsx"] } },
  };
}

export const remotionEntryPoint = (): string => new URL("../remotion/index.ts", import.meta.url).pathname;

/**
 * Mirrors Config.setPublicDir(). Without it `staticFile()` (the achievement badges) resolves
 * against a project-root public/ that does not exist, and the icons 404 at render time.
 */
export const remotionPublicDir = (): string => new URL("../remotion/assets", import.meta.url).pathname;

let cached: Promise<string> | null = null;

/**
 * The bundle is cached on the promise, not the resolved value, so two renderers starting
 * concurrently share one webpack run instead of racing into two.
 *
 * `onProgress` only observes the first caller's build; later callers resolve instantly and are
 * reported as complete. That is honest — for them it *is* complete.
 */
export async function bundleOnce(onProgress?: (percent: number) => void): Promise<string> {
  if (cached) {
    onProgress?.(100);
    return cached;
  }
  cached = bundle(remotionEntryPoint(), onProgress, {
    webpackOverride: webpackOverride as never,
    publicDir: remotionPublicDir(),
  }).catch((err: unknown) => {
    // A failed bundle must not be cached, or every later render in the same process replays the
    // same failure without retrying — which in the dashboard means a transient webpack OOM
    // poisons the container until it is restarted.
    cached = null;
    throw err;
  });
  return cached;
}
