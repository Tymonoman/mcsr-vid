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
import {
  BOTTOM_BAND_HEIGHT,
  RTA_COL_WIDTH,
  SHORT_CLOCK_FONT_PX,
  SHORT_CLOCK_Y,
  SHORT_WIDTH,
  STAGE_WIDTH,
  STATIC_COL_WIDTH,
} from "../../remotion/layout.js";

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
  const still = async (id: string, frame: number, inputProps: Record<string, unknown> = props, tag = "") => {
    const composition = await selectComposition({ serveUrl, id, inputProps });
    const out = path.join(dir, `${id}-${frame}${tag}.png`);
    await renderStill({ composition, serveUrl, output: out, imageFormat: "png", frame, inputProps });
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

  // The Short's top plate with the running clock: a 16-character nickname (Minecraft's longest)
  // shows whole in both layouts. ffmpeg draws the clock on the elo row (SHORT_CLOCK_Y), below the
  // name, so the name row needs no room kept for it; a reserve on the whole plate cut every
  // 11+-character name ("silverrru…") on a both-POV Short only.
  const BLANK_HEAD =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const LONG_NAME = "xXSpeedRunnerXx_";
  const shortProps = (pov: string) => ({
    top: { nickname: LONG_NAME, eloRate: 2100, eloRank: 12, headUrl: BLANK_HEAD },
    // pov "right" shows `bottom` alone, on the same top plate.
    bottom: { nickname: LONG_NAME, eloRate: 2600, eloRank: 1, headUrl: BLANK_HEAD },
    hook: "hook",
    timerStartMs: 402_000,
    durationInFrames: 1,
    fps: 30,
    clock: true,
    pov,
  });
  /** Rightmost x in the name row (above the clock's line) that differs from the plate's own
   *  empty right edge on the same row. */
  const nameInkEnd = (px: Uint8Array): number => {
    let end = -1;
    for (let y = 12; y < SHORT_CLOCK_Y - SHORT_CLOCK_FONT_PX / 2; y++) {
      const ref = (y * SHORT_WIDTH + SHORT_WIDTH - 6) * 4;
      for (let x = end + 1; x < SHORT_WIDTH - 6; x++) {
        const i = (y * SHORT_WIDTH + x) * 4;
        if (Math.abs(px[i]! - px[ref]!) + Math.abs(px[i + 1]! - px[ref + 1]!) + Math.abs(px[i + 2]! - px[ref + 2]!) > 60)
          end = x;
      }
    }
    return end;
  };
  for (const pov of ["both", "left", "right"]) {
    const { pixels } = await still("Short", 0, shortProps(pov), `-${pov}`);
    const end = nameInkEnd(pixels);
    // 28 padding + 104 badge + 24 + 104 head + 24 = 284, then 16 x 41.3px: ends near x=945. An
    // ellipsis cut it near x=738.
    assert.ok(end > 900, `the ${pov} Short's top plate cuts "${LONG_NAME}" (name ink ends at x=${end})`);
  }
  console.log(`OK: a ${LONG_NAME.length}-character name shows whole on the Short's top plate, both POVs or one`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
