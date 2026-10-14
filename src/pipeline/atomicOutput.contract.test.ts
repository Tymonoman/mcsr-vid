// Contract test for atomicOutput (src/pipeline/atomicOutput.ts), from the docs: CLAUDE.md "What the
// render produces" (the manifest written last means "render finished") and the module's own
// contract — every stage-completion check is an `existsSync` on the artifact, so a full-named
// file must only ever be a finished one.
//
// The promises:
//  A1  While the render runs, the final name does not exist; the work goes to `<name>.part.<ext>`.
//  A2  The final name appears only on success, holding exactly what the render wrote.
//  A3  A failed or aborted render never produces the final name — and never clobbers a previous
//      good artifact under it (a re-render that dies leaves the last finished one standing).
//  A4  The temporary name keeps the extension (ffmpeg picks its muxer from it), for the names the
//      pipeline actually uses: dotted, numbered and extensionless.
//  A5  A crash's `.part` file is nothing any reader treats as an artifact — the overlay manifest
//      reader (`readSplitStills`) included — and the next run overwrites it.
// Already pinned by atomicOutput.test.ts and not repeated: the return value passes through, a
// stale .part is cleared before a retry starts.
// Run: npx tsx src/pipeline/atomicOutput.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicOutput } from "./atomicOutput.js";
import { overlayPaths, readSplitStills } from "./overlayRender.js";

const dir = mkdtempSync(path.join(tmpdir(), "mcsr-atomic-contract-"));

try {
  // A1 + A2 + A4: the names the render actually writes.
  for (const [name, part] of [
    ["overlay-splits.json", "overlay-splits.part.json"],
    ["overlay-splits-3.png", "overlay-splits-3.part.png"],
    ["final-13446429.mp4", "final-13446429.part.mp4"],
    ["overlay-intro.webm", "overlay-intro.part.webm"],
    ["thumbnail.walking-crossed.png", "thumbnail.walking-crossed.part.png"],
  ] as const) {
    const final = path.join(dir, name);
    await atomicOutput(final, async (temp) => {
      assert.equal(path.basename(temp), part, `${name}: only the last extension moves behind .part`);
      assert.equal(path.dirname(temp), dir, "same directory, so the rename is atomic");
      assert.ok(!existsSync(final), `${name}: no final name while the render runs`);
      await writeFile(temp, `done ${name}`);
    });
    assert.equal(readFileSync(final, "utf8"), `done ${name}`, `${name}: exactly what the render wrote`);
    assert.ok(!existsSync(path.join(dir, part)), `${name}: no .part left after success`);
  }
  // A4: a name without an extension still gets a distinct temporary.
  await atomicOutput(path.join(dir, "noext"), async (temp) => {
    assert.equal(path.basename(temp), "noext.part");
    await writeFile(temp, "x");
  });
  assert.ok(existsSync(path.join(dir, "noext")));

  // A3: a re-render that dies leaves the previous finished artifact byte-identical.
  const timer = path.join(dir, "overlay-timer.mp4");
  writeFileSync(timer, "the good render from last night");
  await assert.rejects(
    atomicOutput(timer, async (temp) => {
      await writeFile(temp, "a third of a frame");
      throw new Error("killed");
    }),
    /killed/,
  );
  assert.equal(
    readFileSync(timer, "utf8"),
    "the good render from last night",
    "a dead re-render clobbers nothing",
  );

  // A3: an abort (the dashboard's Stop) is a failure like any other.
  const stopped = path.join(dir, "overlay-top.png");
  const ac = new AbortController();
  await assert.rejects(
    atomicOutput(stopped, async (temp) => {
      await writeFile(temp, "partial");
      ac.abort();
      ac.signal.throwIfAborted();
    }),
    { name: "AbortError" },
  );
  assert.ok(!existsSync(stopped), "a stopped render has no final name");
  assert.ok(existsSync(path.join(dir, "overlay-top.part.png")), "the partial is kept under .part");

  // A5: a manifest killed mid-write is not a finished render, and the retry replaces it.
  const render = mkdtempSync(path.join(dir, "render-"));
  const still = path.join(render, "overlay-splits-0.png");
  writeFileSync(still, "png");
  await assert.rejects(
    atomicOutput(overlayPaths(render).manifest, async (temp) => {
      await writeFile(temp, JSON.stringify([{ path: still, startSec: 0, durationSec: 5 }]));
      throw new Error("OOM");
    }),
  );
  assert.equal(await readSplitStills(render), null, "a .part manifest never reads as a finished render");
  await atomicOutput(overlayPaths(render).manifest, (temp) =>
    writeFile(temp, JSON.stringify([{ path: still, startSec: 0, durationSec: 5 }])),
  );
  assert.deepEqual(await readSplitStills(render), [{ path: still, startSec: 0, durationSec: 5 }]);
  assert.deepEqual(
    readdirSync(render).sort(),
    ["overlay-splits-0.png", "overlay-splits.json"],
    "the retry left no .part",
  );

  console.log("atomicOutput.contract: all checks passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
