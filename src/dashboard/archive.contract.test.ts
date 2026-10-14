// Contract test for the NAS archive, written from the docs (CLAUDE.md "The NAS", README's
// `archive -- <id>` row, handbook/claude-md-reference.md "The NAS" + the upload section's NAS line)
// before reading the code. archive.test.ts already pins the four window boundaries on 1 Oct and
// 2 Nov, the deferred-before-stat order, the isArchived/capacity caches and sweepArchive's
// candidate filter with an injected archiver; this file drives the rest end to end — a real rsync
// into a temp "mount", the nightly run that sweeps, the delete that relies on the copy.
//
// The promises the docs make, one or more assertions each below:
//  P1  Transfers run only 03:00–08:00 Warsaw wall clock (`inNasWindow`): 03:00 in, 08:00 out.
//  P2  DST-correct — on the transition nights themselves too, and every Warsaw day of the year
//      gets exactly the same 5-hour window (checked against an independent EU-rule oracle).
//  P3  An automatic copy asked for outside the window defers with ONE log line: no copy, nothing
//      on the mount, nothing left "running".
//  P4  The deferred copy is made by the next night's sweep (`sweepArchive`, run before the render
//      — so even a night whose render is skipped still sweeps), with no click from anyone.
//  P5  The sweep covers every upload the NAS does not have yet, and only those: a match that was
//      never uploaded and a match already on the NAS are left alone.
//  P6  A long queue stops when the window closes; the rest waits for the next night's sweep.
//  P7  A daytime sweep ("Run now" at 14:00) does nothing, not even a deferred line per match.
//  P8  Archiving is a copy, never a move ("Nothing is deleted"): the source stays byte-identical
//      and the NAS copy matches it file for file, nested folders included.
//  P9  A copy lands only in `<archive>/<id>/` — nothing else on the mount is written.
//  P10 A finished copy reads as archived to the dashboard (`isArchived`) without a re-stat.
//  P11 A copy in flight is visible (`allArchiveStates`, what restart-when-idle reads as "an NAS
//      copy") from the moment it is asked for until it finishes; a second ask joins it.
//  P12 `/archive` makes a delete recoverable: after archive + `deleteMatch`, the reply says so
//      and the match comes back from the NAS byte for byte ("free SSD by archiving first").
//  P13 A copy that failed is not a copy: the NAS "does not have it yet", so the next sweep must
//      queue it again, and a delete of it must not be reported recoverable.
//  P14 `/home-media` is the operator's whole share — "never touch them": no module names it.
//  P15 `/home-media/mcsr-replayoffs/` writes each log a `ledger.jsonl` line, ≤300 GB. No code
//      writes there today (sessions do it by hand), so only a tripwire is possible: any module
//      that ever names the folder must also name the ledger.
//  P16 README's `npm run archive -- <id>` copies with rsync and deletes nothing — and, being a
//      transfer, it too is bound by the 03:00–08:00 window.
//
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/dashboard/archive.contract.test.ts
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";

// --- hermetic setup: temp media + temp "NAS mount", no network -------------------------------
const media = mkdtempSync(path.join(tmpdir(), "mcsr-nas-contract-media-"));
const nas = mkdtempSync(path.join(tmpdir(), "mcsr-nas-contract-mount-"));
// Every rm below is under one of these; a bug here must never reach /media or /archive.
assert.ok(media.startsWith(tmpdir()) && nas.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
process.env.MCSR_ARCHIVE_DIR = nas;
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`archive contract test: no network (${String(input)})`);
}) as typeof fetch;

// archive.ts reads MCSR_ARCHIVE_DIR once at load, so everything that imports it comes in after.
const { archiveMatch, allArchiveStates, inNasWindow, isArchived, refreshArchived } =
  await import("./archive.js");
const { sweepArchive, runNightlyOnce } = await import("./nightly.js");
const { deleteMatch } = await import("./matchShelf.js");

const repo = path.resolve(import.meta.dirname, "../..");
const fixtureIds = readdirSync(path.join(repo, "src/fixtures"))
  .map((f) => /^match-(\d+)\.json$/.exec(f)?.[1])
  .filter((id): id is string => !!id)
  .map(Number);

/** Records a doc clause the code does not keep, without failing the suite (triage decides). */
const deviations: string[] = [];
async function deviation(clause: string, check: () => void | Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    const observed = err.message.split("\n")[0];
    deviations.push(clause);
    console.log(`DEVIATION: ${clause} — ${observed}`);
  }
}

/** console.error lines while `fn` runs — the deferred line goes there. */
async function capturingErrors<T>(fn: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = orig;
  }
}

async function waitFor(pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const idle = () => !allArchiveStates().some((s) => s.running);

/** A finished, uploaded match as it sits on the SSD: real match JSON, an export, nested overlay. */
function seedMatch(matchId: number, { uploaded = true } = {}): string {
  const dir = path.join(media, String(matchId));
  mkdirSync(path.join(dir, "overlay"), { recursive: true });
  const fixture = fixtureIds[matchId % fixtureIds.length];
  cpSync(path.join(repo, `src/fixtures/match-${fixture}.json`), path.join(dir, `match-${matchId}.json`));
  writeFileSync(path.join(dir, `final-${matchId}.mp4`), Buffer.alloc(64 * 1024, matchId % 251));
  writeFileSync(path.join(dir, "overlay", "overlay-splits.json"), JSON.stringify({ states: 3 }));
  if (uploaded) {
    writeFileSync(
      path.join(dir, "youtube.json"),
      JSON.stringify({
        videoId: `vid${matchId}`,
        uploadedAt: "2026-10-13T19:00:00.000Z",
        publishAt: null,
        privacyStatus: "public",
        thumbnailVariant: null,
        title: "Does the lead ever settle? | A vs B",
      }),
    );
  }
  return dir;
}

/** Every file under `dir`, relative path → contents, for byte-for-byte comparison. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath, e.name);
    out.set(path.relative(dir, abs), readFileSync(abs).toString("base64"));
  }
  return out;
}

// --- an independent Warsaw clock: the EU rule, not Intl ---------------------------------------
// Summer time from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of
// October (Directive 2000/84/EC). Deliberately not the code's own Intl path, so a bug shared by
// both cannot pass unnoticed.
const lastSundayUtc1 = (y: number, month0: number): number => {
  const last = new Date(Date.UTC(y, month0 + 1, 0));
  return Date.UTC(y, month0, last.getUTCDate() - last.getUTCDay(), 1);
};
const warsawOffsetH = (ms: number): number => {
  const y = new Date(ms).getUTCFullYear();
  return ms >= lastSundayUtc1(y, 2) && ms < lastSundayUtc1(y, 9) ? 2 : 1;
};
const warsawLocal = (ms: number) => new Date(ms + warsawOffsetH(ms) * 3_600_000);

const HOUR = 3_600_000;
const MIN = 60_000;

// ============================================================================================
// P1 + P2 — the window, on the transition nights and across two whole years
// ============================================================================================
{
  // 29 Mar 2026: 02:00 CET jumps to 03:00 CEST at 01:00 UTC. The window must open the instant
  // the clocks jump — 03:00 local arrives an hour "early" in UTC that night.
  assert.equal(
    inNasWindow(Date.UTC(2026, 2, 29, 0, 59)),
    false,
    "01:59 CET on spring-forward night: not yet",
  );
  assert.equal(inNasWindow(Date.UTC(2026, 2, 29, 1, 0)), true, "03:00 CEST, the jump itself: open");
  assert.equal(inNasWindow(Date.UTC(2026, 2, 29, 5, 59)), true, "07:59 CEST: still open");
  assert.equal(inNasWindow(Date.UTC(2026, 2, 29, 6, 0)), false, "08:00 CEST: closed");
  // 25 Oct 2026: 03:00 CEST falls back to 02:00 CET at 01:00 UTC, so 02:00–02:59 happens twice.
  // The repeated hour is still before 03:00 — the disks stay quiet through both of them.
  assert.equal(inNasWindow(Date.UTC(2026, 9, 25, 0, 59)), false, "02:59 CEST, first pass");
  assert.equal(inNasWindow(Date.UTC(2026, 9, 25, 1, 0)), false, "02:00 CET, the repeated hour");
  assert.equal(inNasWindow(Date.UTC(2026, 9, 25, 1, 59)), false, "02:59 CET, end of the repeated hour");
  assert.equal(inNasWindow(Date.UTC(2026, 9, 25, 2, 0)), true, "03:00 CET: open");
  assert.equal(inNasWindow(Date.UTC(2026, 9, 25, 6, 59)), true, "07:59 CET: still open");
  assert.equal(inNasWindow(Date.UTC(2026, 9, 25, 7, 0)), false, "08:00 CET: closed");
  // Midnight and the hour either side of the window on an ordinary night: the window is not
  // "night-time", it is 03:00–08:00 — 02:xx and 08:xx are as loud as noon.
  assert.equal(inNasWindow(Date.UTC(2026, 9, 13, 22, 0)), false, "00:00 CEST");
  assert.equal(inNasWindow(Date.UTC(2026, 9, 14, 0, 30)), false, "02:30 CEST");
  assert.equal(inNasWindow(Date.UTC(2026, 9, 14, 6, 30)), false, "08:30 CEST");

  // Every Warsaw day of 2026 and 2027, both boundaries, against the oracle: 02:59 out, 03:00 in,
  // 07:59 in, 08:00 out. A local time that happens twice (the fall-back night's 02:59) is checked
  // at both instants; one that never happens (spring-forward's 02:59) has none to check.
  // ponytail: boundaries per day, not every quarter hour — Intl costs ~0.2 ms a call on the lab.
  const instantsOf = (y: number, mo0: number, d: number, h: number, mi: number): number[] =>
    [1, 2]
      .map((off) => Date.UTC(y, mo0, d, h, mi) - off * HOUR)
      .filter((t) => warsawLocal(t).getTime() === Date.UTC(y, mo0, d, h, mi));
  // The oracle itself: spring-forward's 02:59 never happens, fall-back's happens twice.
  assert.equal(instantsOf(2026, 2, 29, 2, 59).length, 0, "oracle: 29 Mar 2026 has no 02:59");
  assert.equal(instantsOf(2026, 9, 25, 2, 59).length, 2, "oracle: 25 Oct 2026 has two 02:59s");
  let mismatches = 0;
  let firstMismatch = "";
  let days = 0;
  for (let day = Date.UTC(2026, 0, 1); day < Date.UTC(2028, 0, 1); day += 24 * HOUR) {
    const dt = new Date(day);
    const [y, mo0, d] = [dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()];
    days++;
    for (const [h, mi, open] of [
      [2, 59, false],
      [3, 0, true],
      [7, 59, true],
      [8, 0, false],
    ] as const) {
      for (const t of instantsOf(y, mo0, d, h, mi)) {
        if (inNasWindow(t) !== open && mismatches++ === 0)
          firstMismatch = `${dt.toISOString().slice(0, 10)} ${h}:${mi}`;
      }
    }
  }
  assert.equal(days, 730, "both years walked");
  assert.equal(
    mismatches,
    0,
    `inNasWindow disagrees with Warsaw wall clock, first at ${firstMismatch} local`,
  );
  // The four transition nights, every quarter hour: exactly 5 h (20 quarters) of window each —
  // never 4 (the lost hour) or 6 (the repeated one).
  for (const [y, mo0, d] of [
    [2026, 2, 29],
    [2026, 9, 25],
    [2027, 2, 28],
    [2027, 9, 31],
  ] as const) {
    let quarters = 0;
    for (let t = Date.UTC(y, mo0, d - 1, 20); t < Date.UTC(y, mo0, d, 20); t += 15 * MIN)
      if (inNasWindow(t)) quarters++;
    assert.equal(quarters, 20, `${y}-${mo0 + 1}-${d}: a DST night still gets exactly 5 h of window`);
  }
}
console.log("OK: P1/P2 — 03:00–08:00 Warsaw on every day of 2026–2027, exactly 5 h on each DST night");

// Fixed instants used below. 14 Oct 2026 is CEST (UTC+2).
const NOON = () => Date.UTC(2026, 9, 14, 12, 0); // 14:00 Warsaw — "Run now" after lunch
const INSIDE = () => Date.UTC(2026, 9, 15, 2, 0); // 04:00 Warsaw
const NEXT_NIGHT = () => Date.UTC(2026, 9, 16, 1, 30); // 03:30 Warsaw, the following night

// ============================================================================================
// P3 + P7 — outside the window: one line, no copy; a daytime sweep is silent
// ============================================================================================
const deferredId = 13617328; // published at 19:00 UTC; its automatic copy is asked for right away
{
  seedMatch(deferredId);
  const before = readdirSync(nas);
  const { value: state, lines } = await capturingErrors(() => archiveMatch(deferredId, NOON));
  assert.equal(state.running, false, "deferred, not queued — the operator must not see it in flight");
  assert.equal(state.error, null, "a deferral is not a failure");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(readdirSync(nas), before, "nothing reached the mount at 14:00 — the disks stay quiet");
  assert.equal(lines.length, 1, "exactly one log line for a deferred copy (handbook: 'with one log line')");
  assert.match(lines[0], new RegExp(String(deferredId)), "the line names the match it deferred");
  assert.ok(idle(), "a deferred copy does not count as an NAS copy running (restart-when-idle reads this)");

  // A daytime "Run now" sweeps nothing and prints nothing — not a deferred line per upload.
  const daytime = await capturingErrors(() => sweepArchive(NOON));
  assert.deepEqual(daytime.lines, [], "a daytime sweep must not list every match and log each");
  assert.deepEqual(readdirSync(nas), before, "and copies nothing");
}
console.log("OK: P3/P7 — outside the window a copy defers with one line; a daytime sweep is silent");

// ============================================================================================
// P8 + P9 + P10 + P11 — inside the window: a real rsync into the temp mount
// ============================================================================================
const copiedId = 13446429;
{
  const src = seedMatch(copiedId);
  const srcBefore = snapshot(src);
  writeFileSync(path.join(nas, "operator-notes.txt"), "not ours"); // something else on the share
  const rootBefore = readdirSync(nas).sort();
  assert.equal(isArchived(copiedId), false, "not on the NAS yet (and the dashboard has now polled it)");

  const state = archiveMatch(copiedId, INSIDE);
  assert.equal(state.running, true, "queued inside the window reads as in flight at once");
  assert.ok(!idle(), "an NAS copy in flight blocks restart-when-idle from the moment it is asked for");
  const again = archiveMatch(copiedId, INSIDE);
  assert.equal(again, state, "a second ask while it copies joins the same copy, never a second rsync");

  await waitFor(() => !state.running, "the copy to finish");
  assert.equal(state.error, null, `rsync into a writable mount succeeds (${state.error})`);
  assert.equal(typeof state.tookMs, "number", "a finished copy reports how long it took");
  assert.ok(idle(), "and once done, nothing reads as an NAS copy running");

  // P8 — a copy, not a move: the SSD side is untouched, the NAS side identical.
  assert.deepEqual(
    snapshot(src),
    srcBefore,
    "the source is byte-identical after archiving — nothing is deleted",
  );
  assert.deepEqual(
    snapshot(path.join(nas, String(copiedId))),
    srcBefore,
    "the NAS copy matches file for file",
  );
  // P9 — only <archive>/<id>/ appeared; the operator's own file is untouched.
  assert.deepEqual(
    readdirSync(nas).sort(),
    [...rootBefore, String(copiedId)].sort(),
    "only <id>/ was written",
  );
  assert.equal(readFileSync(path.join(nas, "operator-notes.txt"), "utf8"), "not ours");
  // P10 — the dashboard's polled read sees it without anyone forcing a re-stat.
  assert.equal(isArchived(copiedId), true, "a finished copy reads as archived to the next poll");

  // Asked again after the copy (a re-upload, a channel re-scan): nothing to do, no second walk.
  const after = await capturingErrors(() => archiveMatch(copiedId, INSIDE));
  assert.equal(after.value.running, false, "already on the NAS: no second copy");
}
console.log(
  "OK: P8–P11 — a real copy inside the window: byte-identical, source kept, only <id>/, visible while it runs",
);

// ============================================================================================
// P6 — a queue that outlives the window: the rest waits for tomorrow
// ============================================================================================
const [qA, qB, qC] = [13549300, 13560037, 13673240];
{
  for (const id of [qA, qB, qC]) seedMatch(id);
  // The clock reads 07:55 until A's copy has finished, then 08:05: A's own rsync is what carried
  // the night past the window's end, the realistic way a long sweep overruns.
  const aDone = () => allArchiveStates().find((s) => s.matchId === qA)?.tookMs != null;
  const clock = () => (aDone() ? Date.UTC(2026, 9, 15, 6, 5) : Date.UTC(2026, 9, 15, 5, 55));
  const { lines } = await capturingErrors(async () => {
    for (const id of [qA, qB, qC])
      assert.equal(archiveMatch(id, clock).running, true, `#${id} queued at 07:55`);
    await waitFor(idle, "the queue to drain");
  });
  assert.ok(existsSync(path.join(nas, String(qA))), "the copy that started in the window finishes");
  assert.equal(existsSync(path.join(nas, String(qB))), false, "B never started past 08:00");
  assert.equal(existsSync(path.join(nas, String(qC))), false, "C never started past 08:00");
  assert.equal(isArchived(qB), false, "B is still owed a copy");
  assert.equal(lines.filter((l) => /deferred/.test(l)).length, 2, "one deferred line each for B and C");
}
console.log("OK: P6 — a queue running into 08:00 stops; the remainder is left for the next night");

// ============================================================================================
// P4 + P5 — the next night's run sweeps every upload the NAS lacks, before (and without) a render
// ============================================================================================
const neverUploaded = 12902901;
{
  seedMatch(neverUploaded, { uploaded: false });
  // A night whose render is skipped (one is already in flight) still sweeps: the sweep runs
  // first, "before the render", independent of whether anything renders.
  const stateOf = (id: number) => allArchiveStates().find((s) => s.matchId === id);
  const [aBefore, copiedBefore] = [stateOf(qA), stateOf(copiedId)];
  const result = await runNightlyOnce("", { renderInFlight: () => true, now: NEXT_NIGHT });
  assert.equal(result.busy, true, "the render half of the night yielded, as asked");
  assert.ok(!idle(), "the sweep's copies are in flight as soon as the run returns");
  await waitFor(idle, "the sweep's queue to drain");
  for (const id of [deferredId, qB, qC]) {
    assert.deepEqual(
      snapshot(path.join(nas, String(id))),
      snapshot(path.join(media, String(id))),
      `#${id}, deferred earlier, is on the NAS after the next night's sweep — no click from anyone`,
    );
  }
  assert.equal(
    existsSync(path.join(nas, String(neverUploaded))),
    false,
    "a match never uploaded is not archived",
  );
  // Already on the NAS, so not walked again: a fresh copy would have replaced its state object.
  assert.equal(stateOf(qA), aBefore, "A, copied last night, is not copied again");
  assert.equal(stateOf(copiedId), copiedBefore, "nor is the match copied earlier");
}
console.log(
  "OK: P4/P5 — the next night's run sweeps every upload the NAS lacks, even when its render is skipped",
);

// ============================================================================================
// P12 — the archive is what makes a delete recoverable
// ============================================================================================
{
  const id = copiedId; // archived above, by the real rsync
  const before = snapshot(path.join(media, String(id)));
  const result = await deleteMatch(id);
  assert.equal(
    result.archived,
    true,
    "the delete reply says it is recoverable — the confirm button's only signal",
  );
  assert.ok(result.bytesFreed > 64 * 1024, "the SSD space was actually freed");
  assert.equal(existsSync(path.join(media, String(id))), false, "the working directory is gone");
  // Recover it the way an operator would: copy the NAS folder back.
  cpSync(path.join(nas, String(id)), path.join(media, String(id)), { recursive: true });
  assert.deepEqual(snapshot(path.join(media, String(id))), before, "recovered byte for byte from the NAS");
}
console.log("OK: P12 — an archived match deleted from the SSD comes back from the NAS intact");

// ============================================================================================
// P13 — a copy that failed is not a copy
// ============================================================================================
const failedId = 13766294;
{
  const src = seedMatch(failedId);
  // One file the copy cannot read: rsync copies the rest, exits non-zero, and leaves a partial
  // <id>/ on the mount — what a CIFS I/O error mid-transfer leaves behind.
  const unreadable = path.join(src, `final-${failedId}.mp4`);
  chmodSync(unreadable, 0o000);
  const state = await capturingErrors(() => archiveMatch(failedId, INSIDE)).then((r) => r.value);
  await waitFor(() => !state.running, "the failing copy to finish");
  chmodSync(unreadable, 0o644);
  assert.ok(state.error, "the failure is reported on the state the dashboard shows");
  assert.ok(
    existsSync(path.join(nas, String(failedId))),
    "precondition: a partial folder was left on the mount",
  );
  assert.equal(
    existsSync(path.join(nas, String(failedId), `final-${failedId}.mp4`)),
    false,
    "precondition: the export is missing from it",
  );
  assert.equal(isArchived(failedId), false, "the same process does not count the failed copy as archived");

  await deviation(
    "sweepArchive covers every upload the NAS does not have yet (handbook, The NAS)",
    async () => {
      const queued: number[] = [];
      await sweepArchive(NEXT_NIGHT, (matchId) => queued.push(matchId));
      assert.deepEqual(
        queued,
        [failedId],
        "the next night's sweep must queue the failed copy again; it queued none",
      );
    },
  );
  await deviation("/archive holds published matches (recoverable delete) (CLAUDE.md, The NAS)", async () => {
    const result = await deleteMatch(failedId);
    assert.equal(
      result.archived,
      false,
      "a delete after a failed copy must not be reported recoverable; it was",
    );
  });
}
console.log(
  "OK: P13 — a failed copy reports its error (see DEVIATION lines for what the sweep and delete do next)",
);

// ============================================================================================
// P14 + P15 + P16 — the share the pipeline must never touch, and the manual archive script
// ============================================================================================
{
  const sources: Array<{ file: string; text: string }> = [];
  for (const top of ["src", "scripts", "remotion"]) {
    const root = path.join(repo, top);
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!e.isFile() || !/\.(ts|tsx|js|mjs|sh|py)$/.test(e.name) || /\.test\.ts$/.test(e.name)) continue;
      const file = path.join(e.parentPath, e.name);
      sources.push({ file: path.relative(repo, file), text: readFileSync(file, "utf8") });
    }
  }
  assert.ok(sources.length > 50, "the scan actually read the codebase");
  // P14 — the operator's movies, music and backups: no code path may even name the share.
  const namesShare = sources
    .filter((s) => /\/home-media(?!\/mcsr-replayoffs)/.test(s.text))
    .map((s) => s.file);
  assert.deepEqual(namesShare, [], "no module names /home-media outside the pipeline's own folder");
  // P15 — tripwire: a module that ever writes the pipeline's NAS folder must log to its ledger.
  const unledgered = sources
    .filter((s) => s.text.includes("mcsr-replayoffs") && !s.text.includes("ledger.jsonl"))
    .map((s) => s.file);
  assert.deepEqual(unledgered, [], "every module naming mcsr-replayoffs also writes ledger.jsonl");

  // P16 — README: `archive -- <id>` "copies a finished match to the NAS with rsync. Nothing is deleted."
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts.archive;
  assert.ok(script, "the README's archive script exists");
  assert.match(script, /rsync/, "it copies with rsync, as the README says");
  assert.doesNotMatch(
    script,
    /--delete|--remove-source-files|\brm\b|\bmv\b/,
    "nothing is deleted on either side",
  );
  await deviation(
    "Transfers run only 03:00–08:00 Warsaw (CLAUDE.md, The NAS) — README's `npm run archive`",
    () => {
      assert.ok(
        !/^sh -c '\s*rsync/.test(script) || /inNasWindow|archive\.(ts|js)/.test(script),
        `npm run archive runs rsync straight away at any hour: ${script}`,
      );
    },
  );
}
console.log("OK: P14–P16 — no code names the operator's share; the manual archive script deletes nothing");

rmSync(media, { recursive: true, force: true });
rmSync(nas, { recursive: true, force: true });
if (deviations.length) console.log(`${deviations.length} deviation(s) recorded for triage`);
console.log("archive contract: all checks passed");
