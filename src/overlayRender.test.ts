// Renders the real compositions and checks the two geometric facts the render path is built on.
// Slower than the pure unit tests because it drives Chromium, but these are exactly the
// invariants that cannot be checked by reading the code: whether the bands tile, and whether
// the band is opaque.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderStill, selectComposition } from "@remotion/renderer";
import { bundleOnce } from "./remotionBundle.js";
import { BOTTOM_BAND_HEIGHT, RTA_COL_WIDTH, STAGE_WIDTH, STATIC_COL_WIDTH } from "../remotion/layout.js";

const props = {
  timerStartFrame: 300,
  durationInFrames: 21450,
  fps: 30,
};

/** Raw RGBA bytes of a PNG, via ffmpeg so nothing depends on an image library. */
function rgba(file: string, width: number, height: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (d: Buffer) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.slice(-300)));
      const buf = Buffer.concat(chunks);
      assert.equal(buf.length, width * height * 4, `unexpected frame size for ${file}`);
      resolve(new Uint8Array(buf));
    });
  });
}

const dir = await mkdtemp(path.join(tmpdir(), "mcsr-overlay-test-"));
try {
  const serveUrl = await bundleOnce();
  const still = async (id: string, frame: number) => {
    const composition = await selectComposition({ serveUrl, id, inputProps: props });
    const out = path.join(dir, `${id}-${frame}.png`);
    await renderStill({ composition, serveUrl, output: out, imageFormat: "png", frame, inputProps: props });
    return { pixels: await rgba(out, composition.width, composition.height), composition };
  };

  // Frame 700 is mid-match: the timer is running and some splits have revealed, so both crops
  // have live content rather than their initial state.
  const FRAME = 700;
  const [bottom, splits, timer] = await Promise.all([
    still("OverlayBottom", FRAME),
    still("OverlaySplits", FRAME),
    still("OverlayTimer", FRAME),
  ]);

  assert.equal(bottom.composition.width, STAGE_WIDTH);
  assert.equal(splits.composition.width, STATIC_COL_WIDTH);
  assert.equal(timer.composition.width, RTA_COL_WIDTH);

  // THE invariant the whole render split rests on: the two crops, butted together, ARE the band.
  // If this drifts the exported video gains a seam or a doubled strip down the middle, and
  // nothing else in the suite would notice.
  for (let y = 0; y < BOTTOM_BAND_HEIGHT; y++) {
    const full = bottom.pixels.subarray(y * STAGE_WIDTH * 4, (y + 1) * STAGE_WIDTH * 4);
    const left = splits.pixels.subarray(y * STATIC_COL_WIDTH * 4, (y + 1) * STATIC_COL_WIDTH * 4);
    const right = timer.pixels.subarray(y * RTA_COL_WIDTH * 4, (y + 1) * RTA_COL_WIDTH * 4);
    for (let x = 0; x < STAGE_WIDTH; x++) {
      const tiled = x < STATIC_COL_WIDTH ? left[x * 4] : right[(x - STATIC_COL_WIDTH) * 4];
      const tiledA = x < STATIC_COL_WIDTH ? left[x * 4 + 3] : right[(x - STATIC_COL_WIDTH) * 4 + 3];
      assert.equal(full[x * 4], tiled, `red channel differs at (${x},${y})`);
      assert.equal(full[x * 4 + 3], tiledA, `alpha differs at (${x},${y})`);
    }
  }

  // The band is a solid panel, so the timer strip is encoded with no alpha plane at all. It was
  // ProRes 4444 carrying a uniformly-255 alpha channel across every frame of the match.
  for (let i = 3; i < timer.pixels.length; i += 4) {
    assert.equal(timer.pixels[i], 255, `timer strip is not opaque at byte ${i}`);
  }
  for (let i = 3; i < splits.pixels.length; i += 4) {
    assert.equal(splits.pixels[i], 255, `splits strip is not opaque at byte ${i}`);
  }

  console.log("overlayRender: crops tile the band exactly, and both are fully opaque");
} finally {
  await rm(dir, { recursive: true, force: true });
}
