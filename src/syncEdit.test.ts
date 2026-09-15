import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ANCHOR_SEC } from "./kdenliveProject.js";
import { clipTimeFor, povClipExists, povClipPath, validOffset } from "./syncEdit.js";
import {
  exportStale,
  readSyncOffsets,
  staleExportMessage,
  syncFilePath,
  writeSyncOffsets,
} from "./syncFile.js";

// The one arithmetic in the editor: match start sits at ANCHOR_SEC on the finished timeline, so a
// given second of the video comes from `offset + (t - ANCHOR_SEC)` of that POV's clip. Get the
// sign wrong and the two frames drift apart as you move the slider, which reads as a sync error
// that is not there.
assert.equal(clipTimeFor(150, ANCHOR_SEC), 150, "match start maps to the offset itself");
assert.equal(clipTimeFor(150, 5), 145, "five seconds before match start is five seconds earlier");
assert.equal(clipTimeFor(150, 15), 155, "and after it, later");
// The measurement that matters: two POVs whose offsets differ by 1.5s show the same instant only
// when the offsets are right, which is exactly what the operator is looking at.
assert.equal(clipTimeFor(148.5, 5) - clipTimeFor(150, 5), -1.5);

// A hand-typed offset reaches an ffmpeg seek and a file every consumer reads, and readSyncOffsets
// degrades a NaN to "no sync data" — which would silently put the coarse estimate back rather
// than say anything. So the refusal has to happen here, where it can be reported.
assert.deepEqual(validOffset(150, "left"), { value: 150 });
assert.deepEqual(validOffset("148.5", "left"), { value: 148.5 });
assert.deepEqual(validOffset(" 148.5 ", "left"), { value: 148.5 });
assert.deepEqual(validOffset(1 / 3, "left"), { value: 0.333 }, "milliseconds is finer than any frame");
for (const bad of ["", "abc", null, undefined, NaN, Infinity, {}]) {
  assert.ok("error" in validOffset(bad, "left"), `refused ${JSON.stringify(bad)}`);
}
assert.match(String((validOffset(-1, "left") as { error: string }).error), /cannot be negative/);
assert.match(String((validOffset(90000, "left") as { error: string }).error), /longer than any VOD/);
assert.deepEqual(validOffset(0, "left"), { value: 0 }, "zero is a real answer, not an empty one");

console.log("syncEdit: the timeline arithmetic and every refusal");

// --- A manual sync outranks the detector, and survives ------------------------------------------
{
  const dir = await mkdtemp(path.join(tmpdir(), "mcsr-syncedit-"));
  assert.equal(povClipExists(dir, "doogile"), false, "no clip, nothing to compare");
  await writeFile(povClipPath(dir, "doogile"), "");
  assert.equal(povClipExists(dir, "doogile"), true);

  writeSyncOffsets(dir, {
    left: 148.5,
    right: 148.5,
    confidence: 1,
    detail: "set in the dashboard, replacing countdown",
    source: "manual",
  });
  const back = readSyncOffsets(dir);
  assert.equal(back?.source, "manual", "the source survives the round trip");
  assert.equal(back?.confidence, 1, "a human reading two digits is the measurement, not a guess");
  // The warning line keys off confidence against the threshold, so a manual sync must clear it —
  // otherwise the dashboard keeps asking them to verify the alignment they just verified.
  assert.ok((back?.confidence ?? 0) >= 0.15);

  await rm(dir, { recursive: true, force: true });
  console.log("syncEdit: a manual sync round-trips and clears the warning");
}

// --- An export made before the sync was corrected is stale ---------------------------------------
// One upload reached the channel out of sync because sync.json was fixed by hand AFTER the MP4
// was exported and nobody re-exported. Pure mtime arithmetic, so the clocks are set by hand.
{
  const dir = await mkdtemp(path.join(tmpdir(), "mcsr-stale-"));
  const video = path.join(dir, "final-1.mp4");
  await writeFile(video, "");
  const at = (file: string, iso: string) => utimes(file, new Date(iso), new Date(iso));
  await at(video, "2026-09-10T12:00:00Z");

  const none = exportStale(dir, video);
  assert.equal(none.stale, false, "no sync.json: nothing to be newer than the export");
  assert.equal(none.syncAt, null);
  assert.equal(none.exportAt.toISOString(), "2026-09-10T12:00:00.000Z");

  writeSyncOffsets(dir, { left: 1, right: 1, confidence: 1, detail: "", source: "manual" });
  await at(syncFilePath(dir), "2026-09-10T11:00:00Z");
  assert.equal(exportStale(dir, video).stale, false, "the export read this sync.json: fresh");
  await at(syncFilePath(dir), "2026-09-10T12:00:00Z");
  assert.equal(exportStale(dir, video).stale, false, "the same second is not newer");

  await at(syncFilePath(dir), "2026-09-10T12:00:01Z");
  const stale = exportStale(dir, video);
  assert.equal(stale.stale, true, "sync.json written after the export: the export is stale");
  assert.equal(stale.syncAt?.toISOString(), "2026-09-10T12:00:01.000Z");
  // The refusal names the fix, with the id in it, so it can be pasted as is.
  assert.equal(
    staleExportMessage(13171737),
    "sync changed after this export — re-export first (npm run export:fast -- 13171737)",
  );

  await rm(dir, { recursive: true, force: true });
  console.log("syncEdit: an export older than sync.json is stale, and only then");
}
