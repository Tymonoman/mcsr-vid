/**
 * Renders one thumbnail per pose pair, so there is something to A/B test. Plain poses only: the
 * operator took the text off the thumbnails on 18 Sept 2026, and the hooked twins earlier
 * matches carry on disk are still read (`hook` on a record) but never rendered again.
 *
 * The webpack bundle (src/pipeline/remotionBundle.ts) and the composition are resolved once; only
 * `renderStill` repeats per variant, so six variants cost well under six separate renders.
 *
 * The chosen variant is copied to `thumbnail.png`. Every existing consumer — the pipeline's
 * skip check, matchStatus, the CLI, the dashboard's image route — matches that exact literal
 * name, so they keep working without knowing variants exist.
 */
import { makeCancelSignal, renderStill, selectComposition } from "@remotion/renderer";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicOutput } from "../pipeline/atomicOutput.js";
import { bundleOnce } from "../pipeline/remotionBundle.js";
import type { AvatarProvider } from "../api/avatarUrl.js";
import { computeThumbnailProps, type PosePair } from "./thumbnailProps.js";
import type { ThumbnailProgress } from "./thumbnailRender.js";
import type { MatchInfo, UserDetails } from "../api/types.js";

/** Sidecar naming the variants on disk and which one `thumbnail.png` currently is. */
const VARIANTS_FILE = "thumbnail.json";

interface VariantRecord {
  /** `<leftPose>-<rightPose>` (`-hook` on a legacy hooked twin); also the filename infix and the A/B grouping key. */
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
  /**
   * Whether this variant was rendered with the headline: only ever true on a sidecar written
   * before 18 Sept 2026, when every pair also rendered a hooked twin. Backfilled by
   * `readManifest` for sidecars written before the flag existed.
   */
  hook: boolean;
  /** Basename, not an absolute path: mediaDir differs between the container and the host. */
  file: string;
}

export interface VariantsManifest {
  chosen: string;
  /**
   * Who `chosen` came from: the operator picking one in the dashboard, or the renderer defaulting
   * to the first variant. The publish checklist ticks the thumbnail on "operator" alone —
   * a render producing a PNG is not somebody having looked at three of them.
   *
   * Optional because sidecars predating it cannot be told apart either way, and guessing would
   * either retro-untick every published match or retro-tick every unreviewed one; they keep the
   * meaning they have always had, which is "ticked" (see publishChecklist).
   */
  chosenBy?: "operator" | "auto";
  variants: VariantRecord[];
  /**
   * The headline the hooked twins were rendered with, or null for none. Recorded because it is
   * the one thing about a variant you cannot see from its pose key, and the dashboard needs to
   * show what the rendered set is actually selling. Manifests written before hooks existed have
   * no field at all, which reads as null.
   */
  hookText: string | null;
  /**
   * Each player's ladder rank at the moment the headline was chosen, by uuid.
   *
   * `eloAtMatchStart` freezes the rating because "the same match shows different numbers in
   * different places" otherwise (CLAUDE.md); the rank has the same problem and no match-time
   * value in the API to read back. A hook can name it — "#9 vs #3" is a real suggestion — and the
   * hook is frozen here while the Short's nameplate read the live rank, so a Short re-rendered
   * weeks later showed "#9 VS #3" over plates saying "#3" and "#6". Recorded once, beside the
   * line that may quote it. Absent on manifests written before this, which then fall back to live.
   */
  ranks?: Record<string, number | null>;
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

export function manifestPath(outDir: string): string {
  return path.join(outDir, VARIANTS_FILE);
}

export async function readManifest(outDir: string): Promise<VariantsManifest | null> {
  const file = manifestPath(outDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as VariantsManifest;
    // Sidecars predating the hook have no field; null is "rendered without one", which is what
    // those files show. Per-variant `hook` arrived later still, and before it opting one variant
    // out was impossible — so a sidecar without the field carried the headline on all its
    // variants or none. This is the only place thumbnail.json is read, so backfilling here is
    // the one helper every consumer already goes through.
    const hookText = parsed.hookText ?? null;
    return {
      ...parsed,
      hookText,
      variants: parsed.variants.map((v) => ({ ...v, hook: v.hook ?? Boolean(hookText) })),
    };
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
  // The one path a human takes to a thumbnail: the dashboard's "Use this". Recorded here rather
  // than at the route, so nothing that promotes a variant can forget to say who did.
  const updated: VariantsManifest = { ...manifest, chosen: key, chosenBy: "operator" };
  await writeFile(manifestPath(outDir), JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

/**
 * Whether a variant's PNG already on disk can stand for this render. A plain still is good —
 * unless the previous manifest recorded its key as hooked, which is the layout from before the
 * twins, where the un-suffixed file *was* the headline render. No manifest at all is an aborted
 * batch — resume it.
 */
export function variantStillReusable(previous: VariantsManifest | null, poses: PosePair): boolean {
  return previous === null || previous.variants.find((v) => v.key === variantKey(poses))?.hook !== true;
}

/**
 * The title hook a pipeline run writes. A manifest's headline is the committed choice from when
 * thumbnails carried one, and a re-run keeps it; a manifest with no text is a deliberate
 * text-free render, kept too. Only a match with no manifest takes the chip.
 */
export function carriedHookText(
  previous: VariantsManifest | null,
  chip: string | undefined,
): string | undefined {
  return previous ? (previous.hookText ?? undefined) : chip;
}

/**
 * The key an earlier manifest's choice means today. A choice recorded as hooked under an
 * un-suffixed key is from before the twins, when that key carried the headline: it means the
 * hooked twin now, or a re-render would quietly hand an operator's hooked pick to the plain
 * render that inherited its name.
 */
export function carriedChoice(previous: VariantsManifest | null): string | undefined {
  const chosen = previous?.variants.find((v) => v.key === previous.chosen);
  return chosen?.hook && !chosen.key.endsWith("-hook") ? `${chosen.key}-hook` : previous?.chosen;
}

/**
 * Whether a variant's pose was honoured. `nmsr` is the static render every failed pose falls
 * back to, so two variants with different pose names can be the same image; the A/B tab and
 * the pipeline's message both need to know. One rule, here, so they cannot drift again.
 */
export function variantFellBack(v: { leftProvider: AvatarProvider; rightProvider: AvatarProvider }): boolean {
  return v.leftProvider === "nmsr" || v.rightProvider === "nmsr";
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
    // Deferred until a still actually needs it: a call where every PNG is already on disk only
    // rewrites the manifest, and paying ~10-30s of webpack for that is pure waste.
    let bundled: Promise<string> | null = null;
    const serveUrl = () =>
      (bundled ??= bundleOnce((percent) => args.onProgress?.({ phase: "bundling", percent })));

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
        hook: false,
        file,
      });

      // Skip per variant, not per match: adding a fourth pose to the config should render only
      // the fourth, and a re-run after an aborted batch should not redo the ones that landed.
      // The manifest must still list it, which is why the record is pushed above this check.
      if (existsSync(outPath) && variantStillReusable(previous, poses)) continue;

      const bundleUrl = await serveUrl();
      const composition = await selectComposition({
        serveUrl: bundleUrl,
        id: "Thumbnail",
        inputProps: renderProps,
      });
      await atomicOutput(outPath, (output) =>
        renderStill({ composition, serveUrl: bundleUrl, output, inputProps: renderProps, cancelSignal }),
      );
    }
    args.onProgress?.({ phase: "rendering", percent: 100 });
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }

  // Keep an earlier choice if that variant still exists, so re-running the pipeline does not
  // silently swap the thumbnail out from under a video you already picked one for.
  const keys = new Set(records.map((r) => r.key));
  const wanted = carriedChoice(previous);
  const kept = previous !== null && wanted !== undefined && keys.has(wanted);
  const chosen = kept ? wanted : records[0]!.key;
  // A choice carried over keeps whatever it said about itself — including nothing, for a sidecar
  // written before the field, whose pill must not change meaning because a pose was added to the
  // config. A fresh default says so: nobody has picked this one yet.
  const chosenBy = kept ? previous.chosenBy : "auto";

  const manifest: VariantsManifest = {
    chosen,
    ...(chosenBy ? { chosenBy } : {}),
    variants: records,
    hookText: null,
    // Frozen for the hooks that may quote it. Carried over with a kept choice so a re-render does
    // not re-read a rank that has since moved.
    ranks:
      kept && previous?.ranks
        ? previous.ranks
        : {
            [args.userLeft.uuid]: args.userLeft.eloRank ?? null,
            [args.userRight.uuid]: args.userRight.eloRank ?? null,
          },
  };
  await writeFile(manifestPath(args.outDir), JSON.stringify(manifest, null, 2), "utf8");
  await copyFile(
    path.join(args.outDir, records.find((r) => r.key === chosen)!.file),
    path.join(args.outDir, "thumbnail.png"),
  );
  return manifest;
}
