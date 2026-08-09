import assert from "node:assert/strict";
import { resolveSplitSide, compareSplitSides } from "./resolveSplitSide.js";

const timerStartFrame = 0;
const fps = 60;
const runEndFrame = 30000; // e.g. a ~500s run

// Real time: pending before the checkpoint frame, revealed at/after it.
assert.deepEqual(resolveSplitSide(5000, timerStartFrame, fps, runEndFrame, 299), { kind: "pending" });
assert.deepEqual(resolveSplitSide(5000, timerStartFrame, fps, runEndFrame, 300), {
  kind: "time",
  ms: 5000,
});

// DNF: stays pending (indistinguishable from "not yet") until the run actually ends.
assert.deepEqual(resolveSplitSide(null, timerStartFrame, fps, runEndFrame, runEndFrame - 1), {
  kind: "pending",
});
assert.deepEqual(resolveSplitSide(null, timerStartFrame, fps, runEndFrame, runEndFrame), {
  kind: "dnf",
});

// compareSplitSides: whoever reveals a real time first is immediately known to be leading,
// no need to wait for the other side to resolve.
assert.deepEqual(compareSplitSides({ kind: "time", ms: 5000 }, { kind: "pending" }), {
  leftLeads: true,
  deltaMs: null,
});
assert.deepEqual(compareSplitSides({ kind: "pending" }, { kind: "time", ms: 5000 }), {
  leftLeads: false,
  deltaMs: null,
});
assert.deepEqual(compareSplitSides({ kind: "time", ms: 5000 }, { kind: "time", ms: 5300 }), {
  leftLeads: true,
  deltaMs: 300,
});
assert.deepEqual(compareSplitSides({ kind: "time", ms: 5300 }, { kind: "time", ms: 5000 }), {
  leftLeads: false,
  deltaMs: 300,
});
// A DNF opponent means the side that got there leads, even before the run ends.
assert.deepEqual(compareSplitSides({ kind: "time", ms: 5000 }, { kind: "dnf" }), {
  leftLeads: true,
  deltaMs: null,
});
assert.deepEqual(compareSplitSides({ kind: "dnf" }, { kind: "time", ms: 5000 }), {
  leftLeads: false,
  deltaMs: null,
});

console.log("resolveSplitSide: all checks passed");
