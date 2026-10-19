// Self-check for archive.ts's NAS quiet window (03:00-08:00 Warsaw, DST-correct) and its caches,
// plus nightly.ts's sweepArchive, which depends on the same window and is tested here too: both
// need MCSR_ARCHIVE_DIR set before archive.ts — or anything importing it — is first loaded in
// this process, so both are imported dynamically after it, the pattern matchShelf.test.ts and
// shortFlow.test.ts use.
// Run: npx tsx src/dashboard/archive.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { VideoStats } from "../youtube/youtube.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-archive-media-"));
const archiveDir = mkdtempSync(path.join(tmpdir(), "mcsr-archive-nas-"));
assert.ok(media.startsWith(tmpdir()) && archiveDir.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
process.env.MCSR_ARCHIVE_DIR = archiveDir;

const { archiveMatch, capacity, inNasWindow, isArchived, refreshArchived } = await import("./archive.js");
// archive.ts owns the window and the queue; sweepArchive is nightly.ts's caller of both, so it
// needs the same MCSR_ARCHIVE_DIR set before nightly.ts's own import chain first loads archive.ts.
const { sweepArchive, freeLocalCopies, planFreeLocalCopies } = await import("./nightly.js");

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

// --- freeLocalCopies / planFreeLocalCopies -----------------------------------------------------
{
  const insideNow = () => Date.UTC(2026, 9, 1, 4, 0); // 1 Oct 2026, 04:00 CEST — inside the window
  const outsideNow = () => Date.UTC(2026, 9, 1, 12, 0); // same day, 14:00 CEST — outside it
  const OLD = "2026-09-01T00:00:00.000Z"; // ~5 days before insideNow — well past 48h
  const RECENT = "2026-09-30T20:00:00.000Z"; // 8h before insideNow — under 48h

  const videoStatsOf = (id: string, privacyStatus: string, publishAt: string | null): VideoStats => ({
    videoId: id,
    title: "t",
    publishedAt: publishAt ?? OLD,
    privacyStatus,
    publishAt,
    views: 0,
    likes: 0,
    comments: 0,
    duration: "",
  });

  const upload = (matchId: number, videoId: string) => {
    mkdirSync(path.join(media, String(matchId)), { recursive: true });
    writeFileSync(
      path.join(media, String(matchId), "youtube.json"),
      JSON.stringify({
        videoId,
        uploadedAt: OLD,
        publishAt: null,
        privacyStatus: "public",
        thumbnailVariant: null,
        title: "t",
      }),
    );
  };
  const bigFile = (matchId: number, name: string, bytes: number, archiveBytes: number | null) => {
    const dir = path.join(media, String(matchId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), "x".repeat(bytes));
    if (archiveBytes !== null) {
      const archDir = path.join(archiveDir, String(matchId));
      mkdirSync(archDir, { recursive: true });
      writeFileSync(path.join(archDir, name), "x".repeat(archiveBytes));
    }
  };

  // 9301: eligible, but the archived copy is a different size — kept.
  upload(9301, "v9301");
  bigFile(9301, "final-9301.mp4", 100, 99);

  // 9302: eligible, archived copy matches, but the video went public under 48h ago — kept.
  upload(9302, "v9302");
  bigFile(9302, "final-9302.mp4", 100, 100);

  // 9303: eligible and archived, but a chain step is still "failed" — kept.
  upload(9303, "v9303");
  bigFile(9303, "final-9303.mp4", 100, 100);
  writeFileSync(
    path.join(media, "9303", "short-9303.status.json"),
    JSON.stringify({ steps: { pick: { state: "failed", at: OLD } }, errors: [] }),
  );

  // 9304: eligible and archived, but the file is short-<id>.mp4 itself — never a candidate.
  upload(9304, "v9304");
  bigFile(9304, "short-9304.mp4", 100, 100);

  // 9305/9306: a joined series — 9305 is game 1 (holds youtube.json + series.json), 9306 is
  // game 2 (no youtube.json of its own, judged by game 1's record). Both have a big file with a
  // matching archived copy.
  upload(9305, "v9305");
  writeFileSync(
    path.join(media, "9305", "series.json"),
    JSON.stringify({
      games: [
        { matchId: 9305, gameNo: 1 },
        { matchId: 9306, gameNo: 2 },
      ],
    }),
  );
  bigFile(9305, "series-9305.mp4", 100, 100);
  bigFile(9306, "doogile.mp4", 50, 50); // a POV clip, matched by the plain ".mp4" rule

  const videos = new Map<string, VideoStats>([
    ["v9301", videoStatsOf("v9301", "public", OLD)],
    ["v9302", videoStatsOf("v9302", "public", RECENT)],
    ["v9303", videoStatsOf("v9303", "public", OLD)],
    ["v9304", videoStatsOf("v9304", "public", OLD)],
    ["v9305", videoStatsOf("v9305", "public", OLD)],
  ]);
  const fetchStats = async (ids: string[]): Promise<VideoStats[]> =>
    ids.flatMap((id) => (videos.has(id) ? [videos.get(id)!] : []));

  // Outside the window: nothing is even planned to run — not a no-op after planning, before it.
  const outsideFreed = await freeLocalCopies(outsideNow, fetchStats);
  assert.deepEqual(outsideFreed, [], "outside the NAS window, nothing happens");
  assert.ok(existsSync(path.join(media, "9305", "series-9305.mp4")), "nothing deleted outside the window");
  assert.ok(
    !existsSync(path.join(media, ".space-ledger.jsonl")),
    "no ledger written outside the window either",
  );

  const plan = await planFreeLocalCopies(insideNow, fetchStats);
  const byFile = (matchId: number, file: string) =>
    plan.find((p) => p.matchId === matchId && p.file === file);
  assert.equal(byFile(9301, "final-9301.mp4"), undefined, "a size mismatch against the NAS copy is kept");
  assert.equal(byFile(9302, "final-9302.mp4"), undefined, "public under 48h is kept");
  assert.equal(byFile(9303, "final-9303.mp4"), undefined, "a pending ('failed') chain step is kept");
  assert.equal(byFile(9304, "short-9304.mp4"), undefined, "short-<id>.mp4 is never a candidate");
  assert.ok(byFile(9305, "series-9305.mp4"), "game 1's own big file is eligible");
  assert.ok(byFile(9306, "doogile.mp4"), "game 2's file is judged eligible through game 1's record");
  assert.equal(
    byFile(9306, "doogile.mp4")?.videoId,
    "v9305",
    "a series game's ledger entry carries game 1's video id",
  );
  console.log("OK: planFreeLocalCopies applies every rule — size, 48h, pending steps, series fan-out");

  const freed = await freeLocalCopies(insideNow, fetchStats);
  assert.deepEqual(
    freed.map((f) => `${f.matchId}/${f.file}`).sort(),
    ["9305/series-9305.mp4", "9306/doogile.mp4"],
    "only the eligible files were actually freed",
  );
  assert.ok(!existsSync(path.join(media, "9305", "series-9305.mp4")), "freed file deleted");
  assert.ok(!existsSync(path.join(media, "9306", "doogile.mp4")), "freed file deleted");
  assert.ok(existsSync(path.join(media, "9301", "final-9301.mp4")), "a kept file stays on disk");
  assert.ok(existsSync(path.join(media, "9304", "short-9304.mp4")), "short-<id>.mp4 stays on disk");

  const ledgerLines = readFileSync(path.join(media, ".space-ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(ledgerLines.length, 2, "one ledger line per freed file");
  const ledgerEntries = ledgerLines.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(
    ledgerEntries.some((e) => e.matchId === 9306 && e.file === "doogile.mp4" && e.videoId === "v9305"),
    "the ledger records what was deleted, including the series fan-out's own video id",
  );
  console.log("OK: freeLocalCopies deletes only what's eligible and logs every deletion to the ledger");
}

console.log("archive: all checks passed");
