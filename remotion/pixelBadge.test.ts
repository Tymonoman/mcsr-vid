import assert from "node:assert/strict";
import { buildBadgeRingCells, BADGE_GRID_N } from "./pixelBadge.js";

const cells = buildBadgeRingCells();
const c = (BADGE_GRID_N - 1) / 2;

function angleOf(cell: { x: number; y: number }): number {
  return ((Math.atan2(cell.y - c, cell.x - c) * 180) / Math.PI + 360) % 360;
}

// Every cell is inside the grid bounds.
for (const cell of cells) {
  assert.ok(cell.x >= 0 && cell.x < BADGE_GRID_N, `x out of bounds: ${cell.x}`);
  assert.ok(cell.y >= 0 && cell.y < BADGE_GRID_N, `y out of bounds: ${cell.y}`);
}

// Two open gaps (GAP1=300..345, GAP2=120..165), each with an arrowhead
// (span 30 degrees) capping its GAP_END side: no cells near 305 degrees
// (inside GAP1, before its arrowhead starts at 345-30=315) or 125 degrees
// (inside GAP2, before its arrowhead starts at 165-30=135).
for (const angle of [305, 125]) {
  const nearGapAngle = cells.some((cell) => Math.abs(angleOf(cell) - angle) < 3);
  assert.ok(!nearGapAngle, `ring should have an open gap near ${angle} degrees`);
}

// Still recognizably a ring (plus two arrowheads), not empty or ballooned
// way past a sane size.
const outerR = BADGE_GRID_N * 0.46;
const innerR = BADGE_GRID_N * 0.3;
const fullAnnulusArea = Math.PI * (outerR ** 2 - innerR ** 2);
assert.ok(cells.length > fullAnnulusArea * 0.5, "ring should still be mostly closed");
assert.ok(cells.length < fullAnnulusArea * 1.3, "ring + arrowheads shouldn't balloon past a sane size");

// Two-fold rotational symmetry: each arc is a single solid color. Sample a
// cell safely inside arc1's zone (angle > GAP1_END=345 or < GAP2_START=120,
// away from either boundary) and arc2's zone (165 < angle < 300).
const arc1Sample = cells.find((cell) => Math.abs(angleOf(cell) - 50) < 2);
const arc2Sample = cells.find((cell) => Math.abs(angleOf(cell) - 230) < 2);
assert.ok(arc1Sample, "expected a ring cell near 50 degrees (arc1)");
assert.ok(arc2Sample, "expected a ring cell near 230 degrees (arc2)");
assert.equal(arc1Sample!.color, "#e2483f", "arc1 should be crimson");
assert.equal(arc2Sample!.color, "#35d6c4", "arc2 should be warped");

// Deterministic: calling it again produces the identical cell set.
assert.deepEqual(buildBadgeRingCells(), cells);

console.log("pixelBadge: all checks passed");
