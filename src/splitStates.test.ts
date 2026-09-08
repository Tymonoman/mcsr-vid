import assert from "node:assert/strict";
import { splitSegments, runEndFrameOf } from "./splitStates.js";

const base = {
  timerStartFrame: 300, // 10s lead-in at 30fps
  runResultMs: 505356,
  durationInFrames: 21450,
  fps: 30,
  // The reveal cases count stills; the subscribe card is its own case below.
  postRollCta: false,
};

// Reveal frame = timerStartFrame + ms/1000*fps, rounded up.
const revealOf = (ms: number) => Math.ceil(base.timerStartFrame + (ms / 1000) * base.fps);

{
  const props = {
    ...base,
    splits: [
      { label: "Nether Enter", leftMs: 123693, rightMs: 151021 },
      { label: "Bastion", leftMs: 146938, rightMs: 185311 },
    ],
  };
  const segs = splitSegments(props);
  // One segment before anything reveals, then one per reveal: 5 stills, not 21450 frames.
  assert.equal(segs.length, 5);
  assert.equal(segs[0]!.startFrame, 0);
  assert.deepEqual(
    segs.slice(1).map((s) => s.startFrame),
    [123693, 146938, 151021, 185311].map(revealOf),
  );
  // Contiguous, gapless, and covering the whole composition.
  assert.equal(segs.at(-1)!.endFrame, props.durationInFrames);
  for (let i = 1; i < segs.length; i++) {
    assert.equal(segs[i - 1]!.endFrame, segs[i]!.startFrame);
    assert.ok(segs[i]!.endFrame > segs[i]!.startFrame, "every segment has positive length");
  }
}

{
  // A DNF side flips only when the run ends, which is its own state change.
  const props = { ...base, splits: [{ label: "End Enter", leftMs: 458164, rightMs: null }] };
  const segs = splitSegments(props);
  assert.deepEqual(
    segs.map((s) => s.startFrame),
    [0, revealOf(458164), Math.ceil(runEndFrameOf(props))],
  );
}

{
  // Two sides revealing on the same frame must collapse to one still, not two zero-length ones.
  const props = {
    ...base,
    splits: [
      { label: "A", leftMs: 100000, rightMs: 100000 },
      { label: "B", leftMs: 100000, rightMs: null },
    ],
  };
  const segs = splitSegments(props);
  assert.deepEqual(
    segs.map((s) => s.startFrame),
    [0, revealOf(100000), Math.ceil(runEndFrameOf(props))],
  );
  for (const s of segs) assert.ok(s.endFrame > s.startFrame);
}

{
  // No result time: the timer never freezes, so nothing can be proven DNF and a null side
  // stays pending for the whole render.
  const props = {
    ...base,
    runResultMs: null,
    splits: [{ label: "A", leftMs: 60000, rightMs: null }],
  };
  const segs = splitSegments(props);
  assert.deepEqual(
    segs.map((s) => s.startFrame),
    [0, revealOf(60000)],
  );
}

{
  // A split landing past the end of the render must not produce a still outside the composition.
  const props = { ...base, durationInFrames: 400, splits: [{ label: "A", leftMs: 600000, rightMs: null }] };
  const segs = splitSegments(props);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { startFrame: 0, endFrame: 400 });
}

console.log("splitStates: all checks passed");

// --- The subscribe card is a state of its own: one still begins exactly three seconds after
// the finish, and none does when the card is off or the run has no recorded finish.
{
  const { ctaFrameOf, CTA_DELAY_SEC } = await import("./splitStates.js");
  const props = {
    ...base,
    postRollCta: true,
    splits: [{ label: "Nether Enter", leftMs: 123693, rightMs: 151021 }],
  };
  const runEnd = base.timerStartFrame + (base.runResultMs / 1000) * base.fps;
  const cta = Math.ceil(runEnd + CTA_DELAY_SEC * base.fps);
  assert.equal(ctaFrameOf(props), cta);
  assert.ok(
    splitSegments(props).some((s) => s.startFrame === cta),
    "a still starts on the card's frame",
  );
  assert.equal(ctaFrameOf({ ...props, postRollCta: false }), null);
  assert.ok(
    !splitSegments({ ...props, postRollCta: false }).some((s) => s.startFrame === cta),
    "off: no extra still",
  );
  assert.equal(ctaFrameOf({ ...props, runResultMs: null }), null, "no finish, no card");
  assert.equal(
    ctaFrameOf({ ...props, postRollCta: undefined }),
    cta,
    "unset means on, as the config default",
  );
  console.log("OK: the subscribe card is one more still, three seconds after the finish");
}
