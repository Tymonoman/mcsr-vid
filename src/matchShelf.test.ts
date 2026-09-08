// Self-check for matchShelf.ts. Deletion is the one irreversible thing the dashboard can do, so
// this pins the parts that decide *what* gets removed and what the caller is told about it.
// Run: npx tsx src/matchShelf.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-shelf-media-"));
const archive = await mkdtemp(path.join(tmpdir(), "mcsr-shelf-archive-"));

// Belt and braces: every path this test removes must be under a tmpdir it just created. A bug
// here would delete real match footage, so the guard is worth the two lines.
assert.ok(media.startsWith(tmpdir()) && archive.startsWith(tmpdir()), "refusing to run outside tmpdir");

config.mediaDir = media;
process.env.MCSR_ARCHIVE_DIR = archive;

const {
  deleteMatch,
  hiddenMatchIds,
  isArchived,
  isExported,
  isUploaded,
  publishChecklist,
  setHidden,
  setPublishFlag,
} = await import("./matchShelf.js");

function seed(matchId: number, bytes: number): string {
  const dir = path.join(media, String(matchId));
  mkdirSync(path.join(dir, "nested"), { recursive: true });
  writeFileSync(path.join(dir, "vod.mp4"), Buffer.alloc(bytes));
  writeFileSync(path.join(dir, "nested", "overlay.png"), Buffer.alloc(bytes));
  return dir;
}

try {
  // --- 1. Hiding round-trips and persists ---------------------------------------------------
  assert.deepEqual([...hiddenMatchIds()], [], "nothing hidden before anything is hidden");
  setHidden(111, true);
  setHidden(222, true);
  setHidden(111, false);
  assert.deepEqual([...hiddenMatchIds()], [222], "unhiding must remove, not duplicate");

  // The state file must not look like a match directory, or listProcessedMatchIds would try to
  // treat the operator's preferences as footage.
  assert.ok(existsSync(path.join(media, ".dashboard.json")), "state file should be dot-prefixed in mediaDir");

  // --- 2. A corrupt state file degrades to "nothing hidden" ---------------------------------
  // A cosmetic preference must never be able to take the dashboard down.
  writeFileSync(path.join(media, ".dashboard.json"), "{ not json");
  assert.deepEqual([...hiddenMatchIds()], [], "a corrupt state file must read as empty, not throw");
  setHidden(222, true);

  // --- 3. Delete reports the bytes it actually freed, counting nested files ------------------
  // The size is what the operator judges the decision by, so counting only the top level would
  // under-report a match whose overlay stills sit in a subdirectory.
  const dir = seed(333, 1024);
  const result = await deleteMatch(333);
  assert.equal(result.matchId, 333);
  assert.equal(result.bytesFreed, 2048, "must walk subdirectories, not just the top level");
  assert.equal(result.archived, false, "no archived copy exists for this one");
  assert.ok(!existsSync(dir), "the working directory should be gone");

  // --- 4. An archived match is reported as recoverable --------------------------------------
  // This is the difference between a delete the operator can undo and one they cannot, and it is
  // the only signal the confirm button has to say so.
  seed(444, 16);
  mkdirSync(path.join(archive, "444"), { recursive: true });
  assert.equal(isArchived(444), true);
  const archived = await deleteMatch(444);
  assert.equal(archived.archived, true, "an archived copy must be reported");

  // --- 5. Deleting clears the hidden flag ---------------------------------------------------
  // Otherwise the file accumulates ids for directories that no longer exist.
  seed(222, 8);
  assert.deepEqual([...hiddenMatchIds()], [222]);
  await deleteMatch(222);
  assert.deepEqual([...hiddenMatchIds()], [], "a deleted match should not stay in the hidden list");

  // --- 6. Deleting something that is not there fails loudly ---------------------------------
  // Returning success would let the UI report freeing space it did not free.
  await assert.rejects(() => deleteMatch(999), /No working directory for match 999/);

  // --- 7. The checklist derives five of its eight facts, and stores only the other three ------
  // The point of the feature is that nothing derivable is written down, so this pins both
  // halves: a fact appearing because its file appeared, and a manual flag surviving a reload.
  const pubDir = seed(555, 4);
  let list = await publishChecklist(555, null);
  assert.deepEqual(
    list,
    {
      rendered: false,
      hookPicked: false,
      thumbnailChosen: false,
      uploaded: false,
      shortRendered: false,
      shortUploaded: false,
      relatedLinkSet: false,
      endScreenSet: false,
      playersNotified: false,
    },
    "a bare match directory should tick nothing",
  );

  // A title still carrying the placeholder is exactly the case the upload route refuses, so it
  // must not count as a picked hook — that is the whole reason this looks at the first line.
  writeFileSync(path.join(pubDir, "match-555.title.edited.txt"), "<HOOK> | a vs b | MCSR Ranked 1v1\n");
  assert.equal((await publishChecklist(555, null)).hookPicked, false, "the placeholder is not a hook");
  writeFileSync(path.join(pubDir, "match-555.title.edited.txt"), "Down to the last heart | a vs b\n");
  writeFileSync(path.join(pubDir, "thumbnail.json"), JSON.stringify({ chosen: "hero", variants: [] }));
  writeFileSync(path.join(pubDir, "youtube.json"), JSON.stringify({ videoId: "abc" }));
  writeFileSync(path.join(pubDir, "short-555.mp4"), Buffer.alloc(4));
  list = await publishChecklist(555, "/media/555/match-555.kdenlive");
  assert.deepEqual(
    [list.rendered, list.hookPicked, list.thumbnailChosen, list.uploaded, list.shortRendered],
    [true, true, true, true, true],
    "every derived fact should follow its file",
  );

  setPublishFlag(555, "playersNotified", true);
  assert.equal((await publishChecklist(555, null)).playersNotified, true, "a toggle must persist");
  setPublishFlag(555, "relatedLinkSet", true);
  setPublishFlag(555, "playersNotified", false);
  const after = await publishChecklist(555, null);
  assert.equal(after.playersNotified, false, "toggling back off must persist too");
  assert.equal(after.relatedLinkSet, true, "one key's write must not clear its neighbours");

  // Same rule as the hidden list: a cosmetic file must never take the panel down.
  writeFileSync(path.join(pubDir, "publish.json"), "{ not json");
  assert.equal((await publishChecklist(555, null)).relatedLinkSet, false, "corrupt reads as unticked");

  // --- 8. "Ready to publish" is exported and not uploaded; a Studio upload is ticked by hand ---
  // A fresh match: 555 has the youtube.json from case 7, which is the other way to be uploaded.
  const readyDir = seed(556, 4);
  assert.equal(isExported(556), false, "no MP4 yet");
  writeFileSync(path.join(readyDir, "final-556.mp4"), "");
  assert.equal(isExported(556), true, "the fast export's name counts as exported");
  assert.equal(await isUploaded(556), false, "nothing says it was uploaded");
  setPublishFlag(556, "uploaded", true);
  assert.equal(await isUploaded(556), true, "a Studio upload is ticked by hand");
  assert.equal((await publishChecklist(556, null)).uploaded, true, "and the checklist agrees");

  console.log("matchShelf: all checks passed");
} finally {
  await rm(media, { recursive: true, force: true });
  await rm(archive, { recursive: true, force: true });
}
