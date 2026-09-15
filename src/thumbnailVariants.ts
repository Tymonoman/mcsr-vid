/**
 * Renders two thumbnails per pose pair — plain, and with the headline — so there is something
 * to A/B test later.
 *
 * The webpack bundle (src/remotionBundle.ts) and the composition are resolved once; only
 * `renderStill` repeats per variant, so six variants cost well under six separate renders.
 *
 * The chosen variant is copied to `thumbnail.png`. Every existing consumer — the pipeline's
 * skip check, matchStatus, the CLI, the dashboard's image route — matches that exact literal
 * name, so they keep working without knowing variants exist.
 */
import { makeCancelSignal, renderStill, selectComposition } from "@remotion/renderer";
import { existsSync } from "node:fs";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicOutput } from "./atomicOutput.js";
import { bundleOnce } from "./remotionBundle.js";
import type { AvatarProvider } from "./avatarUrl.js";
import { computeThumbnailProps, type PosePair } from "./thumbnailProps.js";
import type { ThumbnailProgress } from "./thumbnailRender.js";
import type { MatchInfo, UserDetails } from "./types.js";

/** Sidecar naming the variants on disk and which one `thumbnail.png` currently is. */
const VARIANTS_FILE = "thumbnail.json";

interface VariantRecord {
  /** `<leftPose>-<rightPose>`, plus `-hook` on the hooked twin; also the filename infix and the A/B grouping key. */
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
   * Whether this variant was rendered with the headline. Every pair renders plain and, when
   * there is a headline, as a hooked twin — the plain ones are the text-free control, the only
   * way to answer "does text on the thumbnail lift CTR?", which pose alone never could.
   * Backfilled by `readManifest` for sidecars written before the flag existed.
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
  /** Headline for every variant in this render; omitted or empty renders the plain header strip. */
  hookText?: string;
  onProgress?: (p: ThumbnailProgress) => void;
  signal?: AbortSignal;
}

/** One render in the set: a pose pair, plain or carrying the headline. */
export interface VariantSlot {
  poses: PosePair;
  hook: boolean;
}

/**
 * The renders one headline asks for: each pair plain, then its hooked twin. Pair by pair, plain
 * first, so the auto-chosen default is the first pair's plain render. No headline, no twins — a
 * hooked variant with nothing to say would be the plain one under a second name.
 */
export function variantSlots(poses: PosePair[], hookText: string | undefined): VariantSlot[] {
  const hooked = Boolean(hookText?.trim());
  return poses.flatMap((p) =>
    hooked
      ? [
          { poses: p, hook: false },
          { poses: p, hook: true },
        ]
      : [{ poses: p, hook: false }],
  );
}

export const variantKey = (poses: PosePair, hook = false): string =>
  `${poses.left}-${poses.right}${hook ? "-hook" : ""}`;
export const variantFile = (poses: PosePair, hook = false): string =>
  `thumbnail.${variantKey(poses, hook)}.png`;

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
 * Whether a variant's PNG already on disk can stand for this render. The previous manifest says
 * what its stills carry: a hooked still under a different headline there, kept now, would be
 * recorded with text it never had. A plain still carries no text, so it is good whatever the
 * headline — unless the manifest recorded its key as hooked, which is the layout from before
 * the twins, where the un-suffixed file *was* the headline render. No manifest at all is an
 * aborted batch — resume it.
 */
export function variantStillReusable(
  previous: VariantsManifest | null,
  poses: PosePair,
  hook: boolean,
  hookText: string | undefined,
): boolean {
  if (previous === null) return true;
  if (!hook) return previous.variants.find((v) => v.key === variantKey(poses))?.hook !== true;
  return (previous.hookText ?? "").trim() === (hookText ?? "").trim();
}

/**
 * The headline a pipeline run renders with. A manifest is the committed choice — the operator's
 * "Re-render with hook", or the last run's — and a re-run (a pose added to the config, one PNG
 * lost) must keep it, or `variantStillReusable` would redo every hooked still under the auto
 * chip and the chosen headline would silently vanish. A manifest with no text is a deliberate
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

    const slots = variantSlots(args.poses, args.hookText);
    for (const [index, { poses, hook }] of slots.entries()) {
      args.onProgress?.({ phase: "rendering", percent: Math.round((index / slots.length) * 100) });

      // The plain render is the text-free control and its twin carries the headline, so the A/B
      // set varies text as well as pose. `rerenderThumbnailVariants` routes back through here,
      // which is why a re-render with a new hook leaves the plain ones as they are.
      const hookText = hook ? args.hookText : undefined;
      const computed = await computeThumbnailProps(
        args.match,
        args.userLeft,
        args.userRight,
        poses,
        hookText,
      );
      const renderProps = { ...computed.props };
      const file = variantFile(poses, hook);
      const outPath = path.join(args.outDir, file);

      records.push({
        key: variantKey(poses, hook),
        leftPose: poses.left,
        rightPose: poses.right,
        leftProvider: computed.leftAvatar.provider,
        rightProvider: computed.rightAvatar.provider,
        hook,
        file,
      });

      // Skip per variant, not per match: adding a fourth pose to the config should render only
      // the fourth, and a re-run after an aborted batch should not redo the ones that landed.
      // The manifest must still list it, which is why the record is pushed above this check.
      // Only a PNG rendered with *this* text is reusable — see variantStillReusable.
      if (existsSync(outPath) && variantStillReusable(previous, poses, hook, hookText)) continue;

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
    hookText: args.hookText?.trim() ? args.hookText : null,
    // Frozen alongside the headline, because a headline may quote it. Carried over with a kept
    // choice so a re-render behind the same line does not re-read a rank that has since moved.
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

/**
 * Re-renders the hooked twins, typically because a human finally picked the headline. The plain
 * renders carry no text and are reused as they are.
 *
 * Deleting the old hooked files first is what makes it a re-render: `renderThumbnailVariants`
 * skips a still already on disk, and with an empty headline it lists no twins at all, which
 * would otherwise leave the old ones lying beside the manifest. Which variant is in use survives
 * by itself — the renderer keeps the previous manifest's `chosen` key whenever it is still in
 * the set, and re-copies it over `thumbnail.png`.
 */
export async function rerenderThumbnailVariants(args: RenderVariantsArgs): Promise<VariantsManifest> {
  await Promise.all(
    args.poses.map((poses) => rm(path.join(args.outDir, variantFile(poses, true)), { force: true })),
  );
  return renderThumbnailVariants(args);
}
