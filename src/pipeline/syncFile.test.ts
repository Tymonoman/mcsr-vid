// Self-check for syncFile.ts. A bad read here places the POV clips at NaN, which ffmpeg accepts
// and renders as black, so "unreadable" must degrade to null and never to a half-usable object.
// Run: npx tsx src/syncFile.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSyncOffsets, syncFilePath, writeSyncOffsets } from "./syncFile.js";

const dir = mkdtempSync(path.join(tmpdir(), "syncfile-"));

// Nothing written yet: the callers fall back to the coarse estimate.
assert.equal(readSyncOffsets(dir), null);

const offsets = {
  left: 153.9,
  right: 155.2,
  confidence: 0.99,
  detail: "video: both countdowns found",
  source: "countdown",
} as const;
writeSyncOffsets(dir, offsets);
assert.deepEqual(readSyncOffsets(dir), offsets);

// A truncated or hand-edited file is not a partial answer.
writeFileSync(syncFilePath(dir), '{"left": 153.9, "right":');
assert.equal(readSyncOffsets(dir), null);
writeFileSync(
  syncFilePath(dir),
  JSON.stringify({ left: 153.9, confidence: 1, detail: "", source: "coarse" }),
);
assert.equal(readSyncOffsets(dir), null, "one offset alone would desync the two POVs");

console.log("syncFile.test.ts OK");
