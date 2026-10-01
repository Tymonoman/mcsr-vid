// Self-check for archive.ts's NAS quiet window (03:00-08:00 Warsaw, DST-correct) and its caches,
// plus nightly.ts's sweepArchive, which depends on the same window and is tested here too: both
// need MCSR_ARCHIVE_DIR set before archive.ts — or anything importing it — is first loaded in
// this process, so both are imported dynamically after it, the pattern matchShelf.test.ts and
// shortFlow.test.ts use.
// Run: npx tsx src/dashboard/archive.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-archive-media-"));
const archiveDir = mkdtempSync(path.join(tmpdir(), "mcsr-archive-nas-"));
assert.ok(media.startsWith(tmpdir()) && archiveDir.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
process.env.MCSR_ARCHIVE_DIR = archiveDir;

const { archiveMatch, capacity, inNasWindow, isArchived, refreshArchived } = await import("./archive.js");
// archive.ts owns the window and the queue; sweepArchive is nightly.ts's caller of both, so it
// needs the same MCSR_ARCHIVE_DIR set before nightly.ts's own import chain first loads archive.ts.
const { sweepArchive } = await import("./nightly.js");

// --- inNasWindow: both sides of DST, the four boundary instants ------------------------------
// 1 Oct 2026 is CEST (UTC+2).
assert.equal(inNasWindow(Date.UTC(2026, 9, 1, 0, 59)), false, "02:59 CEST — not yet");
assert.equal(inNasWindow(Date.UTC(2026, 9, 1, 1, 0)), true, "03:00 CEST — window opens");
assert.equal(inNasWindow(Date.UTC(2026, 9, 1, 5, 59)), true, "07:59 CEST — still open");
assert.equal(inNasWindow(Date.UTC(2026, 9, 1, 6, 0)), false, "08:00 CEST — window closed");
// 2 Nov 2026 is CET (UTC+1), after the 25 Oct fallback.
assert.equal(inNasWindow(Date.UTC(2026, 10, 2, 1, 59)), false, "02:59 CET — not yet");
assert.equal(inNasWindow(Date.UTC(2026, 10, 2, 2, 0)), true, "03:00 CET — window opens");
assert.equal(inNasWindow(Date.UTC(2026, 10, 2, 6, 59)), true, "07:59 CET — still open");
assert.equal(inNasWindow(Date.UTC(2026, 10, 2, 7, 0)), false, "08:00 CET — window closed");
console.log("OK: inNasWindow holds on both sides of DST");

// --- archiveMatch: outside the window does nothing but log, no spawn, no stat at all ----------
{
  const matchId = 9001;
  mkdirSync(path.join(media, String(matchId)), { recursive: true });
  writeFileSync(path.join(media, String(matchId), "final.mp4"), "x");
  const outsideNow = () => Date.UTC(2026, 9, 1, 12, 0); // 14:00 CEST — well outside
  const state = archiveMatch(matchId, outsideNow);
  assert.equal(state.running, false, "deferred, not queued");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(existsSync(path.join(archiveDir, String(matchId))), false, "rsync never ran");
  // Proof the window check ran before isArchived's stat, not after: if archiveMatch had already
  // cached this id as false, creating the directory now and asking again would still read the
  // stale cache. It reads true instead, so the deferred call never touched the mount at all.
  mkdirSync(path.join(archiveDir, String(matchId)), { recursive: true });
  assert.equal(isArchived(matchId), true, "archiveMatch never stat'd — isArchived reads fresh");
}
console.log("OK: an automatic archive call outside the window does nothing but defer — not even a stat");

// --- archiveMatch: queued while the window is open, but it closes before this item's turn ----
{
  const matchId = 9002;
  mkdirSync(path.join(media, String(matchId)), { recursive: true });
  writeFileSync(path.join(media, String(matchId), "final.mp4"), "x");
  let calls = 0;
  // The first call — archiveMatch's own entry check — sees the window open; every call after
  // — copyToArchive's re-check, on the queue's next turn — sees it already closed, simulating
  // the clock crossing 08:00 while this match waited behind another in the queue.
  const closingNow = () => (calls++ === 0 ? Date.UTC(2026, 9, 1, 5, 59) : Date.UTC(2026, 9, 1, 6, 0));
  const state = archiveMatch(matchId, closingNow);
  assert.equal(state.running, true, "queued while the window was still open");
  for (let i = 0; i < 50 && state.running; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(state.running, false, "the queue's own re-check stopped it before it spawned");
  assert.equal(existsSync(path.join(archiveDir, String(matchId))), false, "no rsync spawned");
  assert.equal(isArchived(matchId), false, "left for tomorrow's sweep");
}
console.log("OK: a queued copy whose window closes before its turn is deferred, not copied");

// --- isArchived: true is permanent; a false is re-read only via refreshArchived --------------
{
  const matchId = 9003;
  const dest = path.join(archiveDir, String(matchId));
  assert.equal(isArchived(matchId), false, "not archived yet, and now cached false");
  mkdirSync(dest, { recursive: true }); // a copy made outside this process (or by a prior run)
  assert.equal(isArchived(matchId), false, "a plain poll must not re-stat the mount");
  assert.equal(refreshArchived(matchId), true, "the sweep's ground-truth read notices it");
  assert.equal(isArchived(matchId), true, "and the cache is now correct");
  rmSync(dest, { recursive: true, force: true });
  assert.equal(isArchived(matchId), true, "true is permanent — archives are never deleted");
}
console.log("OK: isArchived caches true forever, and a stale false only via refreshArchived");

// --- capacity: the archive tier is cached 30 minutes; the working tier always re-stats -------
{
  const workingTmp = mkdtempSync(path.join(tmpdir(), "mcsr-archive-working-"));
  const savedMediaDir = config.mediaDir;
  config.mediaDir = workingTmp;
  const t0 = Date.UTC(2026, 9, 1, 4, 0); // inside the window; irrelevant to capacity itself
  const first = await capacity(t0);
  assert.ok(first.working, "working tier stats fine while the dir exists");
  assert.ok(first.archive, "archive tier stats fine while the dir exists");
  rmSync(workingTmp, { recursive: true, force: true });
  rmSync(archiveDir, { recursive: true, force: true });
  const stillCached = await capacity(t0 + 10 * 60_000); // +10 min, inside the 30-min TTL
  assert.equal(stillCached.working, null, "the working tier is never cached — it sees the dir gone");
  assert.equal(stillCached.archive, first.archive, "the archive tier is cached — same reading, no re-stat");
  const afterTtl = await capacity(t0 + 31 * 60_000); // past the TTL
  assert.equal(afterTtl.archive, null, "past the TTL the archive tier re-reads too, and is now gone");
  config.mediaDir = savedMediaDir;
  mkdirSync(archiveDir, { recursive: true }); // restore for the sweepArchive tests below
}
console.log("OK: capacity's archive tier is cached 30 minutes; the working tier is always live");

// --- sweepArchive: a no-op outside the window, without even listing matches ------------------
{
  const queued: number[] = [];
  await sweepArchive(
    () => Date.UTC(2026, 9, 1, 12, 0), // 14:00 CEST, e.g. a daytime "Run now"
    (id) => queued.push(id),
  );
  assert.deepEqual(queued, [], "nothing is queued outside the window");
}
console.log("OK: sweepArchive is a no-op outside the window");

// --- sweepArchive: only an uploaded, not-yet-archived match is queued ------------------------
{
  const uploadRecord = (matchId: number) =>
    writeFileSync(
      path.join(media, String(matchId), "youtube.json"),
      JSON.stringify({
        videoId: `v${matchId}`,
        uploadedAt: "2026-10-01T00:00:00.000Z",
        publishAt: null,
        privacyStatus: "public",
        thumbnailVariant: null,
        title: "t",
      }),
    );
  const notUploaded = 9101; // no youtube.json — never a candidate
  const uploadedAndArchived = 9102; // youtube.json, already on the NAS
  const uploadedPending = 9103; // youtube.json, not archived yet
  for (const id of [notUploaded, uploadedAndArchived, uploadedPending]) {
    mkdirSync(path.join(media, String(id)), { recursive: true });
  }
  uploadRecord(uploadedAndArchived);
  uploadRecord(uploadedPending);
  mkdirSync(path.join(archiveDir, String(uploadedAndArchived)), { recursive: true });

  const queued: number[] = [];
  const seenNow: Array<() => number> = [];
  const insideNow = () => Date.UTC(2026, 9, 1, 4, 0);
  await sweepArchive(insideNow, (id, now) => {
    queued.push(id);
    seenNow.push(now);
  });
  assert.deepEqual(queued, [uploadedPending], "uploaded-not-archived only");
  assert.equal(seenNow[0], insideNow, "the sweep's own clock is threaded into the archiver");
}
console.log("OK: sweepArchive queues only uploaded matches the NAS does not have yet");

console.log("archive: all checks passed");
