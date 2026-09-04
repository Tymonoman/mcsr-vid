import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chooseVariant,
  manifestPath,
  readManifest,
  variantFile,
  variantKey,
  type VariantsManifest,
} from "./thumbnailVariants.js";

const dir = await mkdtemp(path.join(tmpdir(), "mcsr-variants-"));

// The key is the A/B grouping key, the filename infix, and what the dashboard sends back to
// pick a variant — so all three have to agree.
assert.equal(variantKey({ left: "walking", right: "crossed" }), "walking-crossed");
assert.equal(variantFile({ left: "walking", right: "crossed" }), "thumbnail.walking-crossed.png");

// atomicOutput derives its temp name with path.extname, which takes only the LAST extension,
// so a multi-dot variant name still renders to a .png that Remotion recognises.
assert.equal(path.extname(variantFile({ left: "a", right: "b" })), ".png");

// Missing sidecar is "no variants", not an error: matches rendered before this feature existed
// have thumbnail.png and nothing else.
assert.equal(await readManifest(dir), null);

const manifest: VariantsManifest = {
  chosen: "walking-crossed",
  variants: [
    {
      key: "walking-crossed",
      leftPose: "walking",
      rightPose: "crossed",
      leftProvider: "nmsr",
      rightProvider: "nmsr",
      file: "thumbnail.walking-crossed.png",
    },
    {
      key: "cheering-relaxing",
      leftPose: "cheering",
      rightPose: "relaxing",
      leftProvider: "starlight",
      rightProvider: "starlight",
      file: "thumbnail.cheering-relaxing.png",
    },
  ],
};
await writeFile(manifestPath(dir), JSON.stringify(manifest), "utf8");
await writeFile(path.join(dir, "thumbnail.walking-crossed.png"), "first", "utf8");
await writeFile(path.join(dir, "thumbnail.cheering-relaxing.png"), "second", "utf8");

assert.deepEqual(await readManifest(dir), manifest);

// Picking a variant copies it over thumbnail.png -- the literal name every other consumer
// (pipeline skip check, matchStatus, the CLI, the dashboard image route) matches on.
const updated = await chooseVariant(dir, "cheering-relaxing");
assert.equal(updated.chosen, "cheering-relaxing");
assert.equal(await readFile(path.join(dir, "thumbnail.png"), "utf8"), "second");
// ...and it is persisted, so a reload does not forget the choice.
assert.equal((await readManifest(dir))?.chosen, "cheering-relaxing");

// Switching back works, and does not disturb the variant list.
await chooseVariant(dir, "walking-crossed");
assert.equal(await readFile(path.join(dir, "thumbnail.png"), "utf8"), "first");
assert.equal((await readManifest(dir))?.variants.length, 2);

// An unknown key is rejected with the keys that do exist, rather than leaving thumbnail.png
// silently pointing at the wrong render.
await assert.rejects(
  () => chooseVariant(dir, "nope-nope"),
  /No thumbnail variant "nope-nope".*walking-crossed, cheering-relaxing/s,
);

// A truncated sidecar (killed mid-write) reads as "no manifest" so the next render regenerates
// it, rather than throwing and taking the whole thumbnail stage down.
await writeFile(manifestPath(dir), '{"chosen": "walking-cros', "utf8");
assert.equal(await readManifest(dir), null);

// Provenance is what keeps the A/B honest: these two variants carry different pose names but
// the first fell back to NMSR, which has no pose support, so it is not a distinct pose at all.
const fellBack = manifest.variants.filter(
  (v) => v.leftProvider !== "starlight" || v.rightProvider !== "starlight",
);
assert.equal(fellBack.length, 1);
assert.equal(fellBack[0]!.key, "walking-crossed");

await rm(dir, { recursive: true, force: true });
console.log("thumbnailVariants: all checks passed");
