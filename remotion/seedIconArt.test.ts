import assert from "node:assert/strict";
import { SEED_ICON_GRIDS, SEED_ICON_PALETTE } from "./seedIconArt.js";

// every type's grid is rectangular
for (const [type, grid] of Object.entries(SEED_ICON_GRIDS)) {
  const firstRowLength = grid[0].length;
  for (const row of grid) {
    assert.equal(row.length, firstRowLength, `${type} grid is not rectangular (expected ${firstRowLength}, got ${row.length})`);
  }
}

// uses only letters the palette defines
const validLetters = new Set(Object.keys(SEED_ICON_PALETTE));
for (const [type, grid] of Object.entries(SEED_ICON_GRIDS)) {
  for (const row of grid) {
    for (let i = 0; i < row.length; i++) {
      const char = row[i];
      assert.ok(validLetters.has(char), `${type} uses undefined palette letter: '${char}'`);
    }
  }
}

// all five types are present
const expectedTypes = ["VILLAGE", "SHIPWRECK", "DESERT_TEMPLE", "RUINED_PORTAL", "BURIED_TREASURE"];
for (const type of expectedTypes) {
  assert.ok(SEED_ICON_GRIDS[type], `Missing seed type: ${type}`);
}

console.log("seedIconArt: all checks passed");
