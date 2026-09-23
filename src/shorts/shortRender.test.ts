import assert from "node:assert/strict";
import {
  activeRegionFromFrames,
  captionWindows,
  clockText,
  densestSpan,
  shortAudioFilter,
} from "./shortRender.js";
import {
  SHORT_HOOK_SEC,
  SHORT_POV_WIDTH,
  SHORT_SOLO_POV_HEIGHT,
  SHORT_WIDTH,
  shortCaptionFontSize,
} from "../../remotion/layout.js";

// --- captionWindows: each caption from its atMs to the next, never under the hook.
{
  const cap = (atMs: number, text: string) => ({ atMs, text, side: null });
  const w = captionWindows([cap(12_000, "c"), cap(0, "a"), cap(7_000, "b")], 33.5);
  assert.deepEqual(
    w.map((x) => [x.caption.text, x.fromSec, x.toSec]),
    [
      ["a", SHORT_HOOK_SEC, 7],
      ["b", 7, 12],
      ["c", 12, 33.5],
    ],
    "sorted by atMs, the first takes over from the hook, the last runs to the closing card",
  );
  // A first caption timed after the hook still replaces it at the hook's end: no bare seconds.
  assert.equal(captionWindows([cap(6_000, "late")], 20)[0]!.fromSec, SHORT_HOOK_SEC);
  // Two captions under the hook: the later one is what is true when the hook leaves.
  assert.deepEqual(
    captionWindows([cap(0, "stale"), cap(2_000, "current")], 20).map((x) => x.caption.text),
    ["current"],
  );
  // Nothing after the closing card starts, and a Short too short for captions shows none.
  assert.deepEqual(
    captionWindows([cap(0, "a"), cap(19_000, "b")], 18.5).map((x) => [x.caption.text, x.toSec]),
    [["a", 18.5]],
  );
  assert.deepEqual(captionWindows([cap(0, "a")], 3), []);
}

// --- the audio graph: today's centred mix unless a focus side is named.
assert.equal(
  shortAudioFilter(false),
  "[0:a][1:a]amix=inputs=2:duration=shortest:normalize=0[a_out]",
  "no focus must stay the mix every Short before 23 Sept 2026 shipped with",
);
assert.equal(
  shortAudioFilter(false, "right"),
  "[0:a]volume=-12dB[a0];[a0][1:a]amix=inputs=2:duration=shortest:normalize=0[a_out]",
  "focus right lowers the top (left) POV",
);
assert.equal(
  shortAudioFilter(false, "left"),
  "[1:a]volume=-12dB[a1];[0:a][a1]amix=inputs=2:duration=shortest:normalize=0[a_out]",
);
assert.equal(shortAudioFilter(true, "left"), "[0:a]anull[a_out]", "one POV carries only its own audio");

// --- the clock counts the match clock from the window's start, escaped for a filtergraph.
{
  const text = clockText(466_000);
  assert.ok(text.includes("(466.000+t)"), text);
  assert.ok(!/[^\\][:,]/.test(text.replace(/%\{eif/g, "")), `unescaped : or , in ${text}`);
}

// --- the single pane keeps the whole hotbar: 728px at GUI scale 4 on a 1080p stream, centred.
{
  const sourceWidthShown = (1080 * SHORT_POV_WIDTH) / SHORT_SOLO_POV_HEIGHT;
  assert.ok(sourceWidthShown >= 760, `the solo crop shows only ${sourceWidthShown.toFixed(0)}px of 1920`);
}

// --- a caption is one line at any length: the size shrinks, the text never runs off the strip.
assert.equal(shortCaptionFontSize("8 s apart"), 60);
for (const text of ["Feinberg 8 s behind at the eyes", "silverrruns into the End with 12 s in hand"]) {
  const size = shortCaptionFontSize(text);
  assert.ok(text.length * size * (720 / 1080 + 0.02) <= SHORT_WIDTH - 80, `${text} at ${size}px overflows`);
}

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
