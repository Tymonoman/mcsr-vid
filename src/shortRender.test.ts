import assert from "node:assert/strict";
import { activeRegionFromFrames, densestSpan } from "./shortRender.js";

// --- densestSpan: the narrowest window holding most of the mass.
{
  // All the mass in the middle third, nothing either side — the classic pillarboxed stream.
  const profile = [0, 0, 0, 10, 10, 10, 0, 0, 0];
  const span = densestSpan(profile, 0.96);
  assert.deepEqual(span, { from: 3, to: 6 });
}
{
  // A long sparse tail (a scrolling chat panel) must not drag the span out to the frame edge.
  const profile = [0, 0, 100, 100, 100, 0, 1, 0, 1, 0, 1];
  const span = densestSpan(profile, 0.9);
  assert.deepEqual(span, { from: 2, to: 5 }, "a sparse tail must not widen the crop");
}
{
  // Uniform motion: the whole frame is the region, and nothing should be cropped.
  const span = densestSpan([5, 5, 5, 5], 0.96);
  assert.deepEqual(span, { from: 0, to: 4 });
}
{
  // A completely static probe has no mass to concentrate; span the lot rather than divide by zero.
  assert.deepEqual(densestSpan([0, 0, 0], 0.96), { from: 0, to: 3 });
}

// --- activeRegionFromFrames on a synthetic pillarboxed stream.
{
  const W = 20;
  const H = 10;
  // Only columns 8-11 change between frames: a narrow game window with static furniture either
  // side, which is exactly the layout ffmpeg's cropdetect cannot see (the furniture is not black).
  const frame = (tick: number) => {
    const f = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        f[y * W + x] = x >= 8 && x < 12 ? (tick % 2 === 0 ? 0 : 255) : 90;
      }
    }
    return f;
  };
  const region = activeRegionFromFrames([frame(0), frame(1), frame(2), frame(3)], W, H)!;
  assert.ok(region, "a moving strip must be found");
  assert.ok(Math.abs(region.x - 8 / W) < 0.06, `expected x near 0.4, got ${region.x}`);
  assert.ok(Math.abs(region.w - 4 / W) < 0.06, `expected w near 0.2, got ${region.w}`);
}
{
  // Fewer than two frames cannot show motion.
  assert.equal(activeRegionFromFrames([new Uint8Array(4)], 2, 2), null);
  assert.equal(activeRegionFromFrames([], 2, 2), null);
}

console.log("shortRender: all checks passed");
