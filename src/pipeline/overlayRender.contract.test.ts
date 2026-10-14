// Contract tests for the render's outputs on disk (src/pipeline/overlayRender.ts), from CLAUDE.md
// "What the render produces" and handbook/claude-md-reference.md. Promise P16 of the list at the
// top of splitStates.contract.test.ts, plus the file names the docs promise:
//
//  P16 `overlay-splits.json`, written last, means "the render finished": nothing is trusted
//      without it, nor a manifest naming a still that is not on disk.
//
// Only the reader and the paths: renderOverlay itself drives Chromium, which this file never starts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SPLITS_MANIFEST, overlayPaths, readSplitStills } from "./overlayRender.js";

const dir = mkdtempSync(path.join(tmpdir(), "overlay-contract-"));
try {
  // The file names CLAUDE.md lists, one per artifact, all in the match's own directory.
  const p = overlayPaths(dir);
  assert.equal(SPLITS_MANIFEST, "overlay-splits.json");
  assert.deepEqual(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, path.relative(dir, v)])), {
    top: "overlay-top.png",
    topEnd: "overlay-top-end.png",
    countdownTeaser: "overlay-countdown-teaser.png",
    timer: "overlay-timer.mp4",
    intro: "overlay-intro.webm",
    manifest: "overlay-splits.json",
  });

  // Stills on disk with no manifest: a render that died mid-way. Not finished, so not trusted.
  const stills = [0, 1, 2].map((i) => ({
    path: path.join(dir, `overlay-splits-${i}.png`),
    startSec: i * 10,
    durationSec: 10,
  }));
  for (const s of stills) writeFileSync(s.path, "png");
  assert.equal(await readSplitStills(dir), null, "stills without the manifest are not a finished render");

  // The manifest written: the render is finished and its stills come back in timeline order.
  writeFileSync(p.manifest, JSON.stringify(stills));
  assert.deepEqual(await readSplitStills(dir), stills, "the manifest is the finished render");

  // A manifest naming a still that is gone would place a band pointing at nothing.
  rmSync(stills[1]!.path);
  assert.equal(await readSplitStills(dir), null, "a manifest naming a missing still is not trusted");
  writeFileSync(stills[1]!.path, "png");

  // A torn or foreign manifest is no manifest.
  for (const broken of ["{ half", "null", '{"path":"x"}']) {
    writeFileSync(p.manifest, broken);
    assert.equal(await readSplitStills(dir), null, broken);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("overlayRender.contract: all checks passed");
