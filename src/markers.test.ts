import assert from "node:assert/strict";
import { buildSplitMarkers } from "./markers.js";
import type { SplitRow } from "./overlayProps.js";

const splits: SplitRow[] = [
  { label: "Nether Enter", leftMs: 123693, rightMs: 151021 },
  { label: "Bastion", leftMs: 146938, rightMs: null },
];

const markers = buildSplitMarkers({
  splits,
  anchorSec: 10,
  leftNickname: "Alice",
  rightNickname: "Bob",
});

// A DNF side has no moment to mark, so it contributes no guide.
assert.equal(markers.length, 3);
assert.deepEqual(
  markers.map((m) => m.comment),
  ["Nether Enter — Alice", "Nether Enter — Bob", "Bastion — Alice"],
);

// THE regression: split times are match-start-relative, and match start is at the anchor, so
// every guide sits at anchor + split. The old inline formula subtracted the clip's own
// pre-roll offset and put these ~150s early, off near the head of the timeline.
assert.equal(markers[0]!.positionSec, 10 + 123.693);
assert.equal(markers[1]!.positionSec, 10 + 151.021);
assert.equal(markers[2]!.positionSec, 10 + 146.938);

// Every guide lands after the anchor, never before it: a split cannot precede match start.
for (const m of markers) assert.ok(m.positionSec > 10, `guide ${m.comment} is before match start`);

console.log("markers: all checks passed");
