import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BLOCKS, SCENES, SEED_ICON_TYPES } from "./SeedIconMC.js";

// The five overworld seed types the API reports all have a scene.
assert.deepEqual([...SEED_ICON_TYPES].sort(), [
  "BURIED_TREASURE",
  "DESERT_TEMPLE",
  "RUINED_PORTAL",
  "SHIPWRECK",
  "VILLAGE",
]);

// A hand-edited plan stays a plan: every character is a block or air, and every row of a scene is
// as long as its first (a short row would silently shift the blocks after it).
for (const [type, { layers }] of Object.entries(SCENES)) {
  const width = layers[0][0].length;
  layers.forEach((rows, y) => {
    assert.equal(rows.length, layers[0].length, `${type} layer ${y}: ${rows.length} rows`);
    rows.forEach((row, z) => {
      assert.equal([...row].length, width, `${type} layer ${y} row ${z} is ${[...row].length} wide`);
      for (const ch of row)
        assert.ok(ch === "." || BLOCKS[ch], `${type} layer ${y} row ${z}: no block "${ch}"`);
    });
  });
}

// Every texture a block draws is on disk.
const dir = fileURLToPath(new URL("./assets/minecraft/", import.meta.url));
for (const [ch, block] of Object.entries(BLOCKS))
  for (const box of block.boxes)
    for (const { src } of [box.top, box.left, box.right])
      assert.ok(!src || existsSync(dir + src), `block "${ch}": ${src} missing`);

console.log("SeedIconMC: ok");
