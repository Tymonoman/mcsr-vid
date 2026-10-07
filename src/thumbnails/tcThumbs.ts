/**
 * npm run tc-thumbs -- <matchId...>
 *
 * Builds one Test & Compare thumbnail set per match into `<mediaDir>/<id>/tc/` (a new folder —
 * never touches `thumbnail.json`, the strip's own PNGs, or anything else in the match
 * directory):
 *
 *   tc-control.png  — a copy of the live variant (the manifest's `chosen` pose pair).
 *   tc-pose.png     — a copy of whichever already-rendered pose pair differs from it most (by
 *                     SSIM against the control — lower SSIM, more different; ffmpeg already ships
 *                     with the rest of this pipeline, so this needs no new dependency).
 *   tc-caption.png  — the live pose pair re-rendered with a short caption (`src/thumbnails/tcCaption.ts`):
 *                     the best `hooks.ts` candidate for this match, shortened to <=14 characters,
 *                     a fact of the match and never the result (`hookProblem`/`hookLabelProblem`/
 *                     `spoilsTheResult` all gate it — see tcCaption.ts).
 *
 * Every match needs its four pose variants already rendered (`thumbnail.json` on disk) — this
 * never renders those; it is additive on top of them.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { renderStill, selectComposition } from "@remotion/renderer";
import { atomicOutput } from "../pipeline/atomicOutput.js";
import { bundleOnce } from "../pipeline/remotionBundle.js";
import { getMatch, getUser, getVersus, parseMatchId } from "../api/mcsrApi.js";
import { matchDir } from "../config.js";
import { computeMetrics } from "../pipeline/matchScore.js";
import { buildTitle } from "../pipeline/title.js";
import type { HookInput } from "../pipeline/hooks.js";
import { playoffContextFor } from "../playoffs/playoffs.js";
import { readManifest, type VariantRecord } from "./thumbnailVariants.js";
import { computeThumbnailProps } from "./thumbnailProps.js";
import { pickCaption, type CaptionResult } from "./tcCaption.js";

/** YouTube's own thumbnail cap. */
const MAX_BYTES = 2 * 1024 * 1024;

/** ffmpeg's own SSIM filter, "All:" line — lower means more different. No image library needed. */
function ssimAll(a: string, b: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-v", "error", "-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      const m = err.match(/All:([\d.]+)/);
      if (!m) return reject(new Error(`ssim(${path.basename(a)}, ${path.basename(b)}) exit ${code}: ${err.slice(-300)}`));
      resolve(Number(m[1]));
    });
  });
}

/** The already-rendered pose variant least like `chosen` — a real pixel comparison, not a guess. */
async function mostDifferentVariant(
  dir: string,
  chosen: VariantRecord,
  others: VariantRecord[],
): Promise<VariantRecord & { ssim: number }> {
  const chosenPath = path.join(dir, chosen.file);
  let best: (VariantRecord & { ssim: number }) | null = null;
  for (const v of others) {
    const ssim = await ssimAll(chosenPath, path.join(dir, v.file));
    if (!best || ssim < best.ssim) best = { ...v, ssim };
  }
  return best!;
}

async function assertUnderLimit(file: string): Promise<void> {
  const { size } = await stat(file);
  if (size > MAX_BYTES) throw new Error(`${file} is ${size} bytes, over YouTube's ${MAX_BYTES}-byte limit`);
}

interface MatchResult {
  matchId: number;
  files: string[];
  caption: string;
  captionSource: string;
  captionChecks: CaptionResult["checks"];
  poseControl: string;
  poseAlt: string;
  poseAltSsim: number;
}

async function run(matchId: number, serveUrl: () => Promise<string>): Promise<MatchResult> {
  const dir = matchDir(matchId);
  const manifest = await readManifest(dir);
  if (!manifest) throw new Error(`${matchId}: no thumbnail.json in ${dir} — render the thumbnail variants first`);
  const chosen = manifest.variants.find((v) => v.key === manifest.chosen);
  if (!chosen) throw new Error(`${matchId}: manifest's chosen key "${manifest.chosen}" is not among its own variants`);
  const others = manifest.variants.filter((v) => v.key !== manifest.chosen);
  if (others.length === 0) throw new Error(`${matchId}: only one pose variant on disk — nothing to compare it to`);

  const match = await getMatch(matchId);
  const [left, right] = match.players;
  if (!left || !right) throw new Error(`${matchId}: not a two-player match`);
  const [userLeft, userRight, versus] = await Promise.all([
    getUser(left.uuid),
    getUser(right.uuid),
    getVersus(left.uuid, right.uuid).catch(() => undefined),
  ]);

  const budget = buildTitle({ leftNickname: userLeft.nickname, rightNickname: userRight.nickname });
  const hookInput: HookInput = {
    metrics: computeMetrics(match),
    match,
    userLeft,
    userRight,
    playoff: await playoffContextFor(match),
    maxChars: budget.hookMax,
    minChars: 0,
    versus,
  };
  const captionResult = pickCaption(hookInput, [userLeft, userRight]);
  if (!captionResult) {
    throw new Error(`${matchId}: no hooks.ts candidate shortens to <=${14} characters and passes every check`);
  }

  const tcDir = path.join(dir, "tc");
  await mkdir(tcDir, { recursive: true });

  const alt = await mostDifferentVariant(dir, chosen, others);

  const controlOut = path.join(tcDir, "tc-control.png");
  const poseOut = path.join(tcDir, "tc-pose.png");
  const captionOut = path.join(tcDir, "tc-caption.png");

  await copyFile(path.join(dir, chosen.file), controlOut);
  await copyFile(path.join(dir, alt.file), poseOut);

  // The caption variant is the live pose pair re-rendered with `caption` set — everything else
  // about it (avatars, seed, header) must match tc-control.png exactly, so the caption is the
  // only variable the test compares.
  const computed = await computeThumbnailProps(match, userLeft, userRight, {
    left: chosen.leftPose,
    right: chosen.rightPose,
  });
  const renderProps = { ...computed.props, caption: captionResult.caption };
  const url = await serveUrl();
  const composition = await selectComposition({ serveUrl: url, id: "Thumbnail", inputProps: renderProps });
  await atomicOutput(captionOut, (output) =>
    renderStill({ composition, serveUrl: url, output, inputProps: renderProps }),
  );

  for (const f of [controlOut, poseOut, captionOut]) await assertUnderLimit(f);

  return {
    matchId,
    files: [controlOut, poseOut, captionOut],
    caption: captionResult.caption,
    captionSource: captionResult.source,
    captionChecks: captionResult.checks,
    poseControl: chosen.key,
    poseAlt: alt.key,
    poseAltSsim: alt.ssim,
  };
}

const ids = process.argv.slice(2).filter((a) => !a.startsWith("--")).map(parseMatchId);
if (ids.length === 0) {
  console.error("usage: npm run tc-thumbs -- <matchId...>");
  process.exit(2);
}

let bundled: Promise<string> | null = null;
const serveUrl = () => (bundled ??= bundleOnce());

const results: MatchResult[] = [];
for (const matchId of ids) {
  console.error(`--- ${matchId}`);
  const result = await run(matchId, serveUrl);
  console.error(`  caption "${result.caption}" (from "${result.captionSource}")`);
  console.error(`  control ${result.poseControl} · pose ${result.poseAlt} (ssim ${result.poseAltSsim.toFixed(3)})`);
  results.push(result);
}
console.log(JSON.stringify(results, null, 2));
