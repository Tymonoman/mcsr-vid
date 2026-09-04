import assert from "node:assert/strict";
import {
  aggregateDownloadPercent,
  RENDER_PHASE_ORDER,
  RENDER_PHASE_WEIGHTS,
  STAGE_ORDER,
  weighted,
} from "./stageProgress.js";

// --- download: the two yt-dlp processes run concurrently, so their events interleave ---

// The bug this replaces: `(index + percent/100) / total` put player 0 in the 0-50 band and
// player 1 in the 50-100 band, so alternating events made the bar oscillate. Replaying a
// realistic interleaving must now produce a sequence that never goes backwards.
const latest = new Map<number, number>();
const interleaved: Array<[number, number]> = [
  [0, 5],
  [1, 3],
  [0, 20],
  [1, 18],
  [1, 40],
  [0, 42],
  [0, 80],
  [1, 77],
  [1, 100],
  [0, 100],
];
let previous = -1;
for (const [index, percent] of interleaved) {
  latest.set(index, percent);
  const overall = aggregateDownloadPercent(latest, 2);
  assert.ok(overall >= previous, `download percent went backwards: ${previous} -> ${overall}`);
  previous = overall;
}
assert.equal(previous, 100);

// One player reporting before the other has started is genuinely half done, not 5% done.
const onlyFirst = new Map([[0, 100]]);
assert.equal(aggregateDownloadPercent(onlyFirst, 2), 50);

// Degenerate totals must not produce NaN or Infinity in a CSS width.
assert.equal(aggregateDownloadPercent(new Map(), 2), 0);
assert.equal(aggregateDownloadPercent(new Map([[0, 50]]), 0), 0);

// --- render: five sub-steps weighted into one bar ---

// The bands must tile 0-100 with no gap and no overlap, in the order the render runs them.
const bands = RENDER_PHASE_ORDER.map((phase) => RENDER_PHASE_WEIGHTS[phase]);
assert.equal(bands[0]![0], 0);
assert.equal(bands[bands.length - 1]![1], 100);
for (let i = 1; i < bands.length; i++) {
  assert.equal(bands[i]![0], bands[i - 1]![1], `render phase bands do not tile at index ${i}`);
}

// Walking every phase 0 -> 100 in order must climb monotonically. Previously each phase
// reported a raw 0-100, so the bar hit 100 and reset to 0 three times per overlay render.
const phases = RENDER_PHASE_ORDER;
let last = -1;
for (const phase of phases) {
  for (const percent of [0, 25, 50, 75, 100]) {
    const overall = weighted(RENDER_PHASE_WEIGHTS, phase, percent);
    assert.ok(
      overall >= last,
      `render percent went backwards at ${phase} ${percent}%: ${last} -> ${overall}`,
    );
    last = overall;
  }
}
assert.equal(last, 100);

// Remotion has been seen to report slightly over 1.0 on the final frame; a width over 100%
// would overflow the bar's border box.
assert.equal(weighted(RENDER_PHASE_WEIGHTS, "rendering", 130), 100);
assert.equal(weighted(RENDER_PHASE_WEIGHTS, "bundling", -5), 0);

// The dashboard renders one row per stage and the legend names them in this order; a stage
// added without a label would render an empty column head.
assert.deepEqual(STAGE_ORDER, ["fetch", "download", "sync", "render", "thumbnail", "write"]);

console.log("stageProgress: all checks passed");
