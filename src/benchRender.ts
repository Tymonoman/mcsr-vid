/**
 * Measures overlay render throughput for one composition, so a change to the render path can be
 * proved rather than argued. Bundling is timed separately from rendering because it is a fixed
 * cost paid once per pipeline run, while the per-frame cost is what scales with match length.
 *
 *   npm run bench -- OverlayBottom --frames=600 [--concurrency=3] [--codec=prores] [--json]
 */
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { webpackOverride, remotionPublicDir, remotionEntryPoint } from "./remotionBundle.js";

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const compositionId = process.argv[2] ?? "OverlayBottom";
const frames = Number(flag("frames") ?? 600);
const concurrency = flag("concurrency") ? Number(flag("concurrency")) : config.renderConcurrency;
const codec = (flag("codec") ?? "prores") as "prores" | "vp9" | "h264";
const proResProfile = (flag("prores") ?? "4444") as "4444" | "hq" | "standard" | "light";
const pixelFormat = flag("pixelFormat") ?? (codec === "vp9" ? "yuva420p" : "yuva444p10le");
const imageFormat = (flag("imageFormat") ?? "png") as "png" | "jpeg";
const asJson = process.argv.includes("--json");

// Same shape overlayRender.ts feeds the real render, so the benchmark exercises the real
// component tree rather than a stripped-down stand-in.
const props = {
  timerStartFrame: 300,
  durationInFrames: Math.max(frames, 1200),
  fps: config.overlayFps,
};

async function main() {
  const t0 = performance.now();
  const serveUrl = await bundle(remotionEntryPoint(), undefined, {
    webpackOverride: webpackOverride as never,
    publicDir: remotionPublicDir(),
  });
  const bundleMs = performance.now() - t0;

  const composition = await selectComposition({ serveUrl, id: compositionId, inputProps: props });
  // --out keeps the render instead of discarding it, for when the artifact itself is the thing
  // under test (checking a codec's alpha survives MLT, say) rather than the throughput.
  const keep = flag("out");
  const dir = keep ? null : await mkdtemp(path.join(tmpdir(), "mcsr-bench-"));
  const out = keep ?? path.join(dir!, codec === "vp9" ? "out.webm" : "out.mov");

  const t1 = performance.now();
  await renderMedia({
    composition,
    serveUrl,
    codec,
    ...(codec === "prores" ? { proResProfile } : {}),
    imageFormat,
    pixelFormat: pixelFormat as never,
    muted: true,
    ...(concurrency !== null && concurrency !== undefined ? { concurrency } : {}),
    frameRange: [0, frames - 1],
    outputLocation: out,
    inputProps: props,
  });
  const renderMs = performance.now() - t1;
  const bytes = (await stat(out)).size;
  if (dir) await rm(dir, { recursive: true, force: true });

  const result = {
    composition: compositionId,
    width: composition.width,
    height: composition.height,
    pixelsPerFrame: composition.width * composition.height,
    frames,
    codec: codec === "prores" ? `prores-${proResProfile}` : codec,
    pixelFormat,
    imageFormat,
    concurrency: concurrency ?? "default",
    bundleSec: +(bundleMs / 1000).toFixed(1),
    renderSec: +(renderMs / 1000).toFixed(1),
    fps: +(frames / (renderMs / 1000)).toFixed(2),
    bytesPerFrame: Math.round(bytes / frames),
    // What the render would cost for a real 10-minute match at this throughput.
    projectedMinutesFor10MinMatch: +((600 * config.overlayFps) / (frames / (renderMs / 1000)) / 60).toFixed(
      1,
    ),
  };

  if (asJson) console.log(JSON.stringify(result));
  else {
    console.log(
      `\n${compositionId}  ${composition.width}x${composition.height}  ${result.codec}/${pixelFormat}/${imageFormat}  concurrency=${result.concurrency}`,
    );
    console.log(`  bundle      ${result.bundleSec}s`);
    console.log(`  render      ${result.renderSec}s for ${frames} frames  =  ${result.fps} fps`);
    console.log(`  size        ${(result.bytesPerFrame / 1024).toFixed(0)} KiB/frame`);
    console.log(`  projected   ${result.projectedMinutesFor10MinMatch} min for a 10-minute match\n`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
