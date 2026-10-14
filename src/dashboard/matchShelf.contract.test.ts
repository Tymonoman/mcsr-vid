// Contract test for the shelf's nightly half — tonight's queue, "not at night" and "Skip tonight"
// — written from the docs (CLAUDE.md "Tonight's queue"; handbook/claude-md-reference.md "Tonight's
// queue" and "Nightly") before the source was read. The promises:
//
//   S1  The queue is the strip's order, and `PUT /api/nightly/queue` takes the whole list: a
//       reorder or a removal is one write; an id queued twice renders once, in its first place.
//   S2  Queueing a match takes it off `nightlySkip` (an explicit queue always wins) — only that
//       match; the operator's other "not at night" toggles stay.
//   S3  Hidden, the queue, nightlySkip and skipNightOf live in one `.dashboard.json`: changing one
//       never drops another (a Hide pressed at 02:59 must not empty tonight's queue).
//   S4  That file is dot-prefixed in mediaDir, so the match listing never mistakes it for a match.
//   S5  A hand-edited entry that is not a match id never reaches the nightly.
// Run: npx tsx src/dashboard/matchShelf.contract.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import {
  hiddenMatchIds,
  nightlyQueue,
  nightlySkip,
  setHidden,
  setNightlyQueue,
  setNightlySkip,
  setSkipNightOf,
  skipNightOf,
} from "./matchShelf.js";
import { listProcessedMatchIds } from "./matchStatus.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-shelf-contract-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
const savedMedia = config.mediaDir;
config.mediaDir = media;
const stateFile = path.join(media, ".dashboard.json");

try {
  /* --- S1 ------------------------------------------------------------------------------------- */
  assert.deepEqual(nightlyQueue(), [], "a fresh box has nothing queued");
  setNightlyQueue([30, 10, 20]);
  assert.deepEqual(nightlyQueue(), [30, 10, 20], "the strip's order, not sorted");
  setNightlyQueue([20, 30, 10]); // ↑ on the last row
  assert.deepEqual(nightlyQueue(), [20, 30, 10], "a reorder is the new whole list");
  setNightlyQueue([20, 10]); // × on the middle row
  assert.deepEqual(nightlyQueue(), [20, 10], "a removal too");
  setNightlyQueue([10, 20, 10]);
  assert.deepEqual(nightlyQueue(), [10, 20], "queued twice renders once, in its first place");
  console.log("OK: S1 the queue keeps the strip's order and takes the whole list");

  /* --- S2 ------------------------------------------------------------------------------------- */
  setNightlySkip(40, true);
  setNightlySkip(50, true);
  setNightlyQueue([10, 20, 40]);
  assert.deepEqual(nightlySkip(), [50], "the queued card loses its 'not at night'; the other keeps it");
  console.log("OK: S2 queueing takes only that match off nightlySkip");

  /* --- S3 ------------------------------------------------------------------------------------- */
  setSkipNightOf("2026-10-15");
  setHidden(60, true);
  setNightlySkip(70, true);
  assert.deepEqual(nightlyQueue(), [10, 20, 40], "a Hide and a skip toggle leave tonight's queue alone");
  setNightlyQueue([20]);
  assert.deepEqual([...hiddenMatchIds()], [60], "a queue edit leaves the hidden list alone");
  assert.deepEqual(nightlySkip(), [50, 70], "and the other skips");
  assert.equal(skipNightOf(), "2026-10-15", "and Skip tonight");
  setSkipNightOf(null);
  assert.deepEqual(nightlyQueue(), [20], "and clearing Skip tonight leaves the queue");
  console.log("OK: S3 every shelf write keeps the other fields");

  /* --- S4 ------------------------------------------------------------------------------------- */
  assert.equal(path.basename(stateFile).startsWith("."), true);
  assert.deepEqual(listProcessedMatchIds(), [], "the shelf's own file is not a match");
  console.log("OK: S4 the state file is not listed as a match");

  /* --- S5 ------------------------------------------------------------------------------------- */
  // An edit by hand on the box: a string id, a fraction, a null and a real id.
  writeFileSync(
    stateFile,
    JSON.stringify({ hidden: [], queue: ["13617328", 1.5, null, 13617328], nightlySkip: [] }),
  );
  assert.deepEqual(nightlyQueue(), [13617328], "only real match ids reach the nightly");
  setNightlyQueue(nightlyQueue());
  assert.deepEqual(
    (JSON.parse(readFileSync(stateFile, "utf8")) as { queue: unknown[] }).queue,
    [13617328],
    "and the next write keeps only those",
  );
  console.log("OK: S5 a hand-edited non-id never reaches the nightly");

  console.log("matchShelf.contract: all checks passed");
} finally {
  config.mediaDir = savedMedia;
  rmSync(media, { recursive: true, force: true });
}
