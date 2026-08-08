import assert from "node:assert/strict";
import { buildBadgeRingCells, BADGE_GRID_N } from "./pixelBadge.js";

const cells = buildBadgeRingCells();

// Every cell is inside the grid bounds.
for (const c of cells) {
  assert.ok(c.x >= 0 && c.x < BADGE_GRID_N, `x out of bounds: ${c.x}`);
  assert.ok(c.y >= 0 && c.y < BADGE_GRID_N, `y out of bounds: ${c.y}`);
}

// The ring actually has a gap (not a full circle) — cell count is well short
// of the full annulus area.
const outerR = BADGE_GRID_N * 0.46;
const innerR = BADGE_GRID_N * 0.3;
const fullAnnulusArea = Math.PI * (outerR ** 2 - innerR ** 2);
assert.ok(cells.length < fullAnnulusArea, "ring should have an open gap, not be a full circle");
assert.ok(cells.length > fullAnnulusArea * 0.6, "ring should still be mostly closed");

// Left half is warped (teal), right half is crimson, per the brand split.
const leftColors = new Set(cells.filter((c) => c.x < (BADGE_GRID_N - 1) / 2).map((c) => c.color));
const rightColors = new Set(cells.filter((c) => c.x > (BADGE_GRID_N - 1) / 2).map((c) => c.color));
assert.deepEqual(leftColors, new Set(["#35d6c4"]));
assert.deepEqual(rightColors, new Set(["#e2483f"]));

// Deterministic: calling it again produces the identical cell set.
assert.deepEqual(buildBadgeRingCells(), cells);

console.log("pixelBadge: all checks passed");
