import assert from "node:assert/strict";
import { buildBadgeRingCells, BADGE_GRID_N } from "./pixelBadge.js";

const cells = buildBadgeRingCells();

// Every cell is inside the grid bounds.
for (const c of cells) {
  assert.ok(c.x >= 0 && c.x < BADGE_GRID_N, `x out of bounds: ${c.x}`);
  assert.ok(c.y >= 0 && c.y < BADGE_GRID_N, `y out of bounds: ${c.y}`);
}

// The ring actually has a gap (not a full circle): no cells at all near
// 305 degrees, which sits inside the gap (GAP_START=300..GAP_END=345) but
// outside the arrowhead that caps the GAP_END side (arrow starts at
// GAP_END - ARROW_SPAN = 345 - 34 = 311, so 300..311 is genuinely empty).
const c = (BADGE_GRID_N - 1) / 2;
const nearGapAngle = cells.some((cell) => {
  const angle = ((Math.atan2(cell.y - c, cell.x - c) * 180) / Math.PI + 360) % 360;
  return Math.abs(angle - 305) < 3;
});
assert.ok(!nearGapAngle, "ring should have an open gap near 305 degrees");

// Still recognizably a ring (plus arrowhead), not empty or ballooned way
// past a sane size.
const outerR = BADGE_GRID_N * 0.46;
const innerR = BADGE_GRID_N * 0.3;
const fullAnnulusArea = Math.PI * (outerR ** 2 - innerR ** 2);
assert.ok(cells.length > fullAnnulusArea * 0.6, "ring should still be mostly closed");
assert.ok(cells.length < fullAnnulusArea * 1.3, "ring + arrowhead shouldn't balloon past a sane size");

// Left half is warped (teal), right half is crimson, per the brand split.
const leftColors = new Set(cells.filter((c) => c.x < (BADGE_GRID_N - 1) / 2).map((c) => c.color));
const rightColors = new Set(cells.filter((c) => c.x > (BADGE_GRID_N - 1) / 2).map((c) => c.color));
assert.deepEqual(leftColors, new Set(["#35d6c4"]));
assert.deepEqual(rightColors, new Set(["#e2483f"]));

// Deterministic: calling it again produces the identical cell set.
assert.deepEqual(buildBadgeRingCells(), cells);

console.log("pixelBadge: all checks passed");
