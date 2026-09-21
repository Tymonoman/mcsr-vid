import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chooseVariant,
  manifestPath,
  readManifest,
  renderThumbnailVariants,
  variantFile,
  variantKey,
  type VariantsManifest,
} from "./thumbnailVariants.js";
import type { MatchInfo, UserDetails } from "../api/types.js";

const dir = await mkdtemp(path.join(tmpdir(), "mcsr-variants-"));

// The key is the A/B grouping key, the filename infix, and what the dashboard sends back to
// pick a variant — so all three have to agree.
assert.equal(variantKey({ left: "walking", right: "crossed" }), "walking-crossed");
assert.equal(variantFile({ left: "walking", right: "crossed" }), "thumbnail.walking-crossed.png");
// The hooked twin is the same pair under a suffix, so the pose is still readable off the key.
assert.equal(variantKey({ left: "walking", right: "crossed" }, true), "walking-crossed-hook");
assert.equal(variantFile({ left: "walking", right: "crossed" }, true), "thumbnail.walking-crossed-hook.png");

// atomicOutput derives its temp name with path.extname, which takes only the LAST extension,
// so a multi-dot variant name still renders to a .png that Remotion recognises.
assert.equal(path.extname(variantFile({ left: "a", right: "b" })), ".png");

// Missing sidecar is "no variants", not an error: matches rendered before this feature existed
// have thumbnail.png and nothing else.
assert.equal(await readManifest(dir), null);

const manifest: VariantsManifest = {
  chosen: "walking-crossed",
  hookText: "WANNABE vs REAL GOAT",
  variants: [
    {
      key: "walking-crossed",
      leftPose: "walking",
      rightPose: "crossed",
      leftProvider: "nmsr",
      rightProvider: "nmsr",
      hook: true,
      file: "thumbnail.walking-crossed.png",
    },
    {
      key: "cheering-relaxing",
      leftPose: "cheering",
      rightPose: "relaxing",
      leftProvider: "starlight",
      rightProvider: "starlight",
      hook: true,
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

// Promoting one is how the publish checklist learns a human looked at the strip: every render
// writes a `chosen` key, so the key alone never meant anybody had chosen.
assert.equal(updated.chosenBy, "operator");
assert.equal((await readManifest(dir))?.chosenBy, "operator", "and it is persisted");

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

// The headline every variant carries is recorded, and survives promoting a different variant:
// it is the one thing about a render you cannot recover from the pose keys or the filenames.
assert.equal((await readManifest(dir))?.hookText, "WANNABE vs REAL GOAT");

// A sidecar written before hooks existed has no field at all. That is "rendered without one",
// not undefined -- the dashboard renders the value and would print "undefined" over the strip.
const beforeHookFlag = manifest.variants.map(({ hook: _hook, ...rest }) => rest);
await writeFile(
  manifestPath(dir),
  JSON.stringify({ chosen: manifest.chosen, variants: beforeHookFlag }),
  "utf8",
);
{
  const old = await readManifest(dir);
  assert.equal(old?.hookText, null);
  // Per-variant `hook` arrived after the headline did, so a sidecar without it is read from the
  // one fact it does record: no headline on the render means no headline on any variant.
  assert.deepEqual(
    old?.variants.map((v) => v.hook),
    [false, false],
  );
}

// The same vintage sidecar, but rendered with a headline: opting a single variant out was not
// possible when it was written, so every variant it lists carried the text.
await writeFile(manifestPath(dir), JSON.stringify({ ...manifest, variants: beforeHookFlag }), "utf8");
assert.deepEqual(
  (await readManifest(dir))?.variants.map((v) => v.hook),
  [true, true],
);

await writeFile(manifestPath(dir), JSON.stringify(manifest), "utf8");

// A truncated sidecar (killed mid-write) reads as "no manifest" so the next render regenerates
// it, rather than throwing and taking the whole thumbnail stage down.
await writeFile(manifestPath(dir), '{"chosen": "walking-cros', "utf8");
assert.equal(await readManifest(dir), null);

// Provenance is what keeps the A/B honest: these two variants carry different pose names but
// the first fell back to NMSR, which has no pose support, so it is not a distinct pose at all.
// The rule is the production predicate, not a copy of it, so the two cannot drift apart.
const { variantFellBack } = await import("./thumbnailVariants.js");
const fellBack = manifest.variants.filter(variantFellBack);
assert.equal(fellBack.length, 1);
assert.equal(fellBack[0]!.key, "walking-crossed");
assert.equal(
  variantFellBack({ leftProvider: "nmsr-posed", rightProvider: "nmsr-posed" }),
  false,
  "both posed",
);
assert.equal(variantFellBack({ leftProvider: "nmsr-posed", rightProvider: "nmsr" }), true, "one side static");
assert.equal(
  variantFellBack({ leftProvider: "starlight", rightProvider: "starlight" }),
  false,
  "a legacy posed manifest",
);

// Every pair renders plain and with the headline: the plain ones are the text-free control --
// the only variable in the A/B set that pose cannot supply, since pose barely moves clicks. All
// six PNGs already exist, so the renderer skips the stills and what is under test is the set it
// decides on and what it records.
const pairs = [
  { left: "walking", right: "crossed" },
  { left: "cheering", right: "relaxing" },
  { left: "marching", right: "crouching" },
];
for (const p of pairs) {
  await writeFile(path.join(dir, variantFile(p)), `${p.left} plain`, "utf8");
  await writeFile(path.join(dir, variantFile(p, true)), `${p.left} hooked`, "utf8");
}
const renderArgs = {
  match: { tag: null, changes: [] } as unknown as MatchInfo,
  userLeft: { uuid: "u-left", nickname: "edcr", eloRate: 2546 } as unknown as UserDetails,
  userRight: { uuid: "u-right", nickname: "doogile", eloRate: 2382 } as unknown as UserDetails,
  outDir: dir,
  poses: pairs,
};
const rendered = await renderThumbnailVariants({ ...renderArgs, hookText: "WANNABE vs REAL GOAT" });
// Pair by pair, plain before hooked, so the first record -- the auto default -- is the first
// pair's plain render, which is the look every match published so far has.
assert.deepEqual(
  rendered.variants.map((v) => [v.key, v.file, v.hook]),
  [
    ["walking-crossed", "thumbnail.walking-crossed.png", false],
    ["walking-crossed-hook", "thumbnail.walking-crossed-hook.png", true],
    ["cheering-relaxing", "thumbnail.cheering-relaxing.png", false],
    ["cheering-relaxing-hook", "thumbnail.cheering-relaxing-hook.png", true],
    ["marching-crouching", "thumbnail.marching-crouching.png", false],
    ["marching-crouching-hook", "thumbnail.marching-crouching-hook.png", true],
  ],
);
assert.equal(rendered.chosen, "walking-crossed");
assert.equal(rendered.chosenBy, "auto");
assert.equal(await readFile(path.join(dir, "thumbnail.png"), "utf8"), "walking plain");
// The headline is recorded at manifest level: the plain ones opt out of it, it is not absent
// from the render, and the dashboard's "Re-render with hook" box is prefilled from this.
assert.equal(rendered.hookText, "WANNABE vs REAL GOAT");
// The rank travels with the headline. A hook can name it ("#9 vs #3"), the headline is frozen
// here, and the API has no match-time rank to read back — so a Short re-rendered weeks later put
// the frozen line over live plates that disagreed with it.
assert.deepEqual(
  rendered.ranks,
  { "u-left": null, "u-right": null },
  "one entry per player by uuid, null where the user record has no rank",
);
// It survives a reload the same way, rather than being backfilled to the manifest's headline.
assert.deepEqual(
  (await readManifest(dir))?.variants.map((v) => v.hook),
  [false, true, false, true, false, true],
);

// No headline, no twins: a hooked variant with nothing to say would be the plain one under a
// second name, and the strip would show six tiles of three images.
const plainOnly = await renderThumbnailVariants(renderArgs);
assert.deepEqual(
  plainOnly.variants.map((v) => [v.key, v.hook]),
  [
    ["walking-crossed", false],
    ["cheering-relaxing", false],
    ["marching-crouching", false],
  ],
);
assert.equal(plainOnly.hookText, null);

// A choice made before the twins existed, when the un-suffixed key carried the headline, means
// the hooked twin now. Checked on the pure function: the render that follows such a manifest
// redoes the plain still it recorded as hooked, which needs Chromium.
{
  const { carriedChoice } = await import("./thumbnailVariants.js");
  const old = (hook: boolean, chosen = "walking-crossed") =>
    ({ chosen, variants: [{ key: "walking-crossed", hook }] }) as unknown as VariantsManifest;
  assert.equal(carriedChoice(old(true)), "walking-crossed-hook", "a hooked pick under the old key");
  assert.equal(carriedChoice(old(false)), "walking-crossed", "the old control was plain, and still is");
  assert.equal(carriedChoice(rendered), "walking-crossed", "a new-layout manifest is taken as written");
  assert.equal(carriedChoice(null), undefined);
}

await rm(dir, { recursive: true, force: true });
console.log("thumbnailVariants: all checks passed");

// --- A still is reused only when it was rendered with this headline -----------------------------
{
  const { variantStillReusable } = await import("./thumbnailVariants.js");
  const wc = { left: "walking", right: "crossed" };
  const prev = { chosen: null, hookText: "OLD", variants: [] } as unknown as VariantsManifest;
  assert.equal(variantStillReusable(prev, wc, true, "OLD"), true, "same text: keep");
  assert.equal(variantStillReusable(prev, wc, true, "NEW"), false, "new text: render again");
  assert.equal(variantStillReusable(prev, wc, true, "  OLD "), true, "whitespace is not a change");
  assert.equal(variantStillReusable(null, wc, true, "NEW"), true, "no manifest: an aborted batch, resume it");
  assert.equal(variantStillReusable(prev, wc, false, "NEW"), true, "a plain still carries no text");
  // Before the twins, the un-suffixed file was the headline render; a manifest that says so is
  // the one case a plain still cannot be kept, or the migration would file text under "plain".
  const preTwins = { ...prev, variants: [{ key: "walking-crossed", hook: true }] } as VariantsManifest;
  assert.equal(
    variantStillReusable(preTwins, wc, false, "OLD"),
    false,
    "a plain-named still the old manifest recorded as hooked is not plain",
  );
  assert.equal(
    variantStillReusable(preTwins, { left: "marching", right: "crouching" }, false, "OLD"),
    true,
    "a pair the old manifest never recorded as hooked keeps its still",
  );
  console.log("OK: variant stills are reused only under the same headline");

  // A re-run keeps the committed headline: the pipeline renders with the manifest's text when
  // there is one, and the chip only when there is none — else adding a pose to the config would
  // re-render the operator's "Rematch: doogile leads 2-1" away as "#3 vs #21".
  const { carriedHookText } = await import("./thumbnailVariants.js");
  assert.equal(carriedHookText(prev, "#3 vs #21"), "OLD", "manifest text wins over the chip");
  assert.equal(carriedHookText(null, "#3 vs #21"), "#3 vs #21", "no manifest: the chip");
  assert.equal(
    carriedHookText({ ...prev, hookText: null }, "#3 vs #21"),
    undefined,
    "a deliberate text-free render stays text-free",
  );
  assert.equal(
    variantStillReusable(prev, wc, true, carriedHookText(prev, "#3 vs #21")),
    true,
    "so the existing stills survive a re-run with an extra pose",
  );
  console.log("OK: a re-run carries the manifest's headline forward");
}
