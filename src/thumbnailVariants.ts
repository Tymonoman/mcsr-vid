/**
 * Renders one thumbnail per pose pair so there is something to A/B test later.
 *
 * Three things make this cheaper than three separate renders: the webpack bundle is built once,
 * the composition is selected once, and only `renderStill` repeats. Today's single-thumbnail
 * path rebuilt the bundle on every call, so three variants cost well under three times as much.
 *
 * The chosen variant is copied to `thumbnail.png`. Every existing consumer — the pipeline's
 * skip check, matchStatus, the CLI, the dashboard's image route — matches that exact literal
 * name, so they keep working without knowing variants exist.
 */
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderStill, selectComposition } from "@remotion/renderer";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicOutput } from "./atomicOutput.js";
import type { AvatarProvider } from "./avatarUrl.js";
import { computeThumbnailProps, type PosePair } from "./thumbnailProps.js";
import type { ThumbnailProgress } from "./thumbnailRender.js";
import type { MatchInfo, UserDetails } from "./types.js";

/** Sidecar naming the variants on disk and which one `thumbnail.png` currently is. */
export const VARIANTS_FILE = "thumbnail.json";

export interface VariantRecord {
  /** `<leftPose>-<rightPose>`; also the filename infix and the A/B grouping key. */
  key: string;
  leftPose: string;
  rightPose: string;
  /**
   * Which host actually served each avatar. `nmsr` means the pose was NOT honoured — that
   * variant is the same static render every other fallback variant produced, and grouping CTR
   * by pose across it would compare a variable that never varied.
   */
  leftProvider: AvatarProvider;
  rightProvider: AvatarProvider;
  /** Basename, not an absolute path: mediaDir differs between the container and the host. */
  file: string;
}

export interface VariantsManifest {
  chosen: string;
  variants: VariantRecord[];
}

export interface RenderVariantsArgs {
  match: MatchInfo;
  userLeft: UserDetails;
  userRight: UserDetails;
  outDir: string;
  poses: PosePair[];
  onProgress?: (p: ThumbnailProgress) => void;
  signal?: AbortSignal;
}

export const variantKey = (poses: PosePair): string => `${poses.left}-${poses.right}`;
export const variantFile = (poses: PosePair): string => `thumbnail.${variantKey(poses)}.png`;

// Same webpack override as remotion.config.ts, duplicated here because that config file is only
// auto-loaded by the `remotion` CLI, not importable from a programmatic bundle() call.
function webpackOverride(config: Record<string, unknown>): Record<string, unknown> {
  const resolve = (config.resolve as Record<string, unknown>) ?? {};
  return {
    ...config,
    resolve: { ...resolve, extensionAlias: { ".js": [".js", ".ts", ".tsx"] } },
  };
}

export function manifestPath(outDir: string): string {
  return path.join(outDir, VARIANTS_FILE);
}

export async function readManifest(outDir: string): Promise<VariantsManifest | null> {
  const file = manifestPath(outDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as VariantsManifest;
  } catch {
    // A truncated sidecar is not worth failing a render over; it is regenerated below.
    return null;
  }
}

/** Promotes an already-rendered variant to `thumbnail.png`, which is what gets uploaded. */
export async function chooseVariant(outDir: string, key: string): Promise<VariantsManifest> {
  const manifest = await readManifest(outDir);
  if (!manifest) throw new Error(`No thumbnail variants recorded in ${outDir}`);
  const variant = manifest.variants.find((v) => v.key === key);
  if (!variant) {
    throw new Error(
      `No thumbnail variant "${key}" (have: ${manifest.variants.map((v) => v.key).join(", ")})`,
    );
  }
  await copyFile(path.join(outDir, variant.file), path.join(outDir, "thumbnail.png"));
  const updated: VariantsManifest = { ...manifest, chosen: key };
  await writeFile(manifestPath(outDir), JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

export async function renderThumbnailVariants(args: RenderVariantsArgs): Promise<VariantsManifest> {
  if (args.poses.length === 0) throw new Error("renderThumbnailVariants needs at least one pose pair");

  const { cancelSignal, cancel } = makeCancelSignal();
  const onAbort = () => cancel();
  args.signal?.addEventListener("abort", onAbort);

  const previous = await readManifest(args.outDir);
  const records: VariantRecord[] = [];

  try {
    // Bundling dominates the cost of a still, so it happens once for all variants rather than
    // once per variant — which is also why the single-variant path now routes through here.
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

    for (const [index, poses] of args.poses.entries()) {
      args.onProgress?.({ phase: "rendering", percent: Math.round((index / args.poses.length) * 100) });

      const computed = await computeThumbnailProps(args.match, args.userLeft, args.userRight, poses);
      const renderProps = { ...computed.props };
      const file = variantFile(poses);
      const outPath = path.join(args.outDir, file);

      records.push({
        key: variantKey(poses),
        leftPose: poses.left,
        rightPose: poses.right,
        leftProvider: computed.leftAvatar.provider,
        rightProvider: computed.rightAvatar.provider,
        file,
      });

      // Skip per variant, not per match: adding a fourth pose to the config should render only
      // the fourth, and a re-run after an aborted batch should not redo the ones that landed.
      // The manifest must still list it, which is why the record is pushed above this check.
      if (existsSync(outPath)) continue;

      const composition = await selectComposition({ serveUrl, id: "Thumbnail", inputProps: renderProps });
      await atomicOutput(outPath, (output) =>
        renderStill({ composition, serveUrl, output, inputProps: renderProps, cancelSignal }),
      );
    }
    args.onProgress?.({ phase: "rendering", percent: 100 });
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }

  // Keep an earlier choice if that variant still exists, so re-running the pipeline does not
  // silently swap the thumbnail out from under a video you already picked one for.
  const keys = new Set(records.map((r) => r.key));
  const chosen = previous && keys.has(previous.chosen) ? previous.chosen : records[0]!.key;

  const manifest: VariantsManifest = { chosen, variants: records };
  await writeFile(manifestPath(args.outDir), JSON.stringify(manifest, null, 2), "utf8");
  await copyFile(
    path.join(args.outDir, records.find((r) => r.key === chosen)!.file),
    path.join(args.outDir, "thumbnail.png"),
  );
  return manifest;
}
