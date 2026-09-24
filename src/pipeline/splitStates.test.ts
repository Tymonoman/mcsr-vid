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
  // A forfeit arrives as runResultMs null (overlayProps maps result.time 0 to it), and that
  // withholds the whole post-roll — the subscribe card and the final time above it — rather
  // than stamping a finish time the match never produced.
  assert.equal(ctaFrameOf({ ...props, runResultMs: null }), null, "forfeit: no card, no time");
  assert.equal(
    ctaFrameOf({ ...props, postRollCta: undefined }),
    cta,
    "unset means on, as the config default",
  );
  console.log("OK: the subscribe card is one more still, three seconds after the finish");
}

// --- The mid-race subscribe line is two more stills, on at `atSec` and off `forSec` later; none
// when it is not configured, and none when it would run into the finish.
{
  const { midRollFramesOf } = await import("./splitStates.js");
  const props = {
    ...base,
    postRollCta: false,
    splits: [{ label: "Nether Enter", leftMs: 123693, rightMs: 151021 }],
    midRollCta: { atSec: 90, forSec: 4 },
  };
  const on = Math.ceil(base.timerStartFrame + 90 * base.fps);
  const off = Math.ceil(on + 4 * base.fps);
  assert.deepEqual(midRollFramesOf(props), [on, off]);
  const starts = splitSegments(props).map((s) => s.startFrame);
  assert.ok(starts.includes(on) && starts.includes(off), `stills start on both edges: ${starts}`);
  assert.equal(midRollFramesOf({ ...props, midRollCta: undefined }), null, "unset: none");
  assert.ok(
    !splitSegments({ ...props, midRollCta: undefined })
      .map((s) => s.startFrame)
      .includes(on),
  );
  assert.equal(
    midRollFramesOf({ ...props, midRollCta: { atSec: base.runResultMs / 1000 - 1, forSec: 4 } }),
    null,
    "a line that would outlast the run is not shown",
  );
  console.log("OK: the mid-race line is two more stills, and none by default");
}

// --- The first-minute "COMING UP" line is two more stills too, on the same arithmetic as the
// mid-race line; none when absent, when it would still be up as the moment it promises arrives,
// when it would run past the finish, or when it would share a frame with the mid-race line.
{
  const { teaserFramesOf } = await import("./splitStates.js");
  const props = {
    ...base,
    splits: [{ label: "Nether Enter", leftMs: 123693, rightMs: 151021 }],
    midRollCta: { atSec: 90, forSec: 4 },
    teaser: { atSec: 10, forSec: 5, momentMs: 314000, text: "THE LEAD CHANGES ON BLIND TRAVEL" },
  };
  const on = base.timerStartFrame + 10 * base.fps;
  const off = on + 5 * base.fps;
  assert.deepEqual(teaserFramesOf(props), [on, off]);
  const segs = splitSegments(props);
  const starts = segs.map((s) => s.startFrame);
  assert.ok(starts.includes(on) && starts.includes(off), `stills start on both edges: ${starts}`);
  assert.equal(segs.length, splitSegments({ ...props, teaser: undefined }).length + 2);
  assert.equal(teaserFramesOf({ ...props, teaser: undefined }), null, "absent: none");
  const at = (atSec: number, forSec: number, momentMs = 314000) =>
    teaserFramesOf({ ...props, teaser: { ...props.teaser, atSec, forSec, momentMs } });
  assert.equal(at(10, 5, 14000), null, "still up when the moment comes");
  assert.deepEqual(at(10, 5, 15000), [on, off], "gone on the moment's frame is fine");
  assert.equal(at(88, 5, 400000), null, "overlaps the mid-race line, which wins");
  assert.deepEqual(at(94, 5, 400000), [
    base.timerStartFrame + 94 * base.fps,
    base.timerStartFrame + 99 * base.fps,
  ]);
  assert.equal(at(base.runResultMs / 1000 - 1, 5, 999999), null, "outlasts the run");
  assert.equal(at(10, 0), null, "zero seconds: none");
  // Swept over every start second of the run: never on a frame of the mid-race line, and gone
  // before the finish, so a whole run and three seconds lie between it and the post-roll card.
  const { ctaFrameOf, midRollFramesOf } = await import("./splitStates.js");
  const withCta = { ...props, postRollCta: true };
  const mid = midRollFramesOf(withCta)!;
  const cta = ctaFrameOf(withCta)!;
  let shown = 0;
  for (let s = 0; s * base.fps < base.durationInFrames; s++) {
    const w = teaserFramesOf({ ...withCta, teaser: { ...props.teaser, atSec: s, momentMs: 1e9 } });
    if (!w) continue;
    shown++;
    assert.ok(
      w[1] <= mid[0] || w[0] >= mid[1],
      `starting at ${s} s it shares a frame with the mid-race line`,
    );
    assert.ok(w[1] <= runEndFrameOf(withCta) && w[1] < cta, `starting at ${s} s it reaches the post-roll`);
  }
  assert.ok(shown > 400, `most start seconds are allowed (${shown})`);
  console.log("OK: the teaser is two more stills, and steps aside for the mid-race line");
}

// --- "Explain the moves": a card per split at its first arrival, `forSec` long. One that would
// share a frame with the mid-race line, the teaser or the card before it waits until that one is
// gone; one that would then reach the finish is dropped, so none is ever on the post-roll.
{
  const { explainFramesOf, midRollFramesOf, teaserFramesOf, ctaFrameOf } = await import("./splitStates.js");
  const move = (atMs: number, head: string) => ({ atMs, head, line: "WHY" });
  const props = {
    ...base,
    postRollCta: true,
    splits: [{ label: "Nether Enter", leftMs: 123693, rightMs: 151021 }],
    midRollCta: { atSec: 90, forSec: 4 }, // frames [3000, 3120)
    teaser: { atSec: 10, forSec: 5, momentMs: 314000, text: "THE LEAD CHANGES ON BLIND TRAVEL" }, // [600, 750)
    explainMoves: {
      forSec: 6,
      moves: [
        move(123693, "NETHER"),
        move(126000, "BASTION"),
        move(88000, "UNDER THE SUBSCRIBE LINE"),
        move(11000, "UNDER THE TEASER"),
        move(base.runResultMs - 3000, "INTO THE FINISH"),
      ],
    },
  };
  const cards = explainFramesOf(props).map((c) => [c.move.head, ...c.frames]);
  assert.deepEqual(cards, [
    ["UNDER THE TEASER", 750, 930],
    ["UNDER THE SUBSCRIBE LINE", 3120, 3300],
    ["NETHER", 4011, 4191],
    ["BASTION", 4191, 4371],
  ]);
  const starts = splitSegments(props).map((s) => s.startFrame);
  for (const f of [750, 930, 3120, 3300, 4011, 4191, 4371])
    assert.ok(starts.includes(f), `a still starts on ${f}`);
  assert.deepEqual(explainFramesOf({ ...props, explainMoves: undefined }), [], "off: none");
  assert.deepEqual(explainFramesOf({ ...props, explainMoves: { ...props.explainMoves, forSec: 0 } }), []);
  // Swept over every second of the run: never on a frame of the subscribe line or the teaser,
  // never on another card, and gone before the finish.
  const mid = midRollFramesOf(props)!;
  const teaser = teaserFramesOf(props)!;
  const everySecond = Array.from({ length: base.runResultMs / 1000 }, (_, s) => move(s * 1000, `${s}`));
  const swept = explainFramesOf({ ...props, explainMoves: { forSec: 6, moves: everySecond } });
  assert.ok(swept.length > 60, `${swept.length} cards`);
  swept.forEach(({ frames: [a, b] }, i) => {
    for (const [c, d] of [mid, teaser]) assert.ok(b <= c || a >= d, `${a}-${b} overlaps ${c}-${d}`);
    if (i > 0) assert.ok(a >= swept[i - 1]!.frames[1], `${a} starts inside the card before`);
    assert.ok(b <= runEndFrameOf(props) && b < ctaFrameOf(props)!, `${a}-${b} reaches the post-roll`);
  });
  console.log(
    "OK: explain-the-moves cards wait for the subscribe line and the teaser, never reach the finish",
  );
}
