import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SEED_ICON_TYPES, seedIconFile } from "./SeedIconMC.js";

const root = fileURLToPath(new URL("..", import.meta.url));

// The five overworld seed types the API reports all have an icon and an -alt render (the other
// projection) beside it.
assert.deepEqual([...SEED_ICON_TYPES].sort(), [
  "BURIED_TREASURE",
  "DESERT_TEMPLE",
  "RUINED_PORTAL",
  "SHIPWRECK",
  "VILLAGE",
]);
for (const type of SEED_ICON_TYPES) {
  assert.ok(existsSync(join(root, "remotion/assets", seedIconFile(type))), `${type}: no icon PNG`);
  assert.ok(existsSync(join(root, "remotion/assets", seedIconFile(type, true))), `${type}: no -alt PNG`);
}

// Every scene spec parses, and a template given as a file exists (a spec that cannot bake cannot
// regenerate its icon). Baking needs the jar, so it is left to scripts/seed-icons/icons.sh.
const scenes = join(root, "scripts/seed-icons/scenes");
for (const file of readdirSync(scenes).filter((f) => f.endsWith(".json"))) {
  const spec = JSON.parse(readFileSync(join(scenes, file), "utf8"));
  assert.ok("template" in spec && Array.isArray(spec.edits ?? []), `${file}: not a scene spec`);
  if (typeof spec.template === "string" && /\.(json|nbt)$/.test(spec.template))
    assert.ok(existsSync(join(scenes, spec.template)), `${file}: ${spec.template} missing`);
}

// icons.sh names only specs that exist.
const icons = readFileSync(join(root, "scripts/seed-icons/icons.sh"), "utf8");
for (const [, spec] of icons.matchAll(/\]=(\S+)/g))
  assert.ok(existsSync(join(scenes, `${spec}.json`)), `icons.sh: scenes/${spec}.json missing`);

console.log("SeedIconMC: ok");
