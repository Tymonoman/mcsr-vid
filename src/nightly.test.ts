// Self-check for nightly.ts. The scheduler runs unattended at 03:00 UTC, so the two decisions
// nobody will be awake to correct — *when* it fires and *what* it picks — are pinned here.
// The timer itself is not tested: that would be a test of setTimeout.
// Run: npx tsx src/nightly.test.ts
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chainShort, msUntilNextRun, pickNightlyCandidate } from "./nightly.js";
import type { ShortRunner } from "./shortsRoutes.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (iso: string): number => Date.parse(iso);

// Before the hour: later today.
assert.equal(msUntilNextRun(at("2026-09-07T01:30:00Z"), 3), 1.5 * HOUR);
// After the hour: tomorrow, which also means crossing a date boundary correctly.
assert.equal(msUntilNextRun(at("2026-09-07T04:00:00Z"), 3), 23 * HOUR);
assert.equal(msUntilNextRun(at("2026-09-07T23:30:00Z"), 3), 3.5 * HOUR);
// Exactly on the hour is the reschedule case at the end of a run. A zero here would spin the
// scheduler: fire, reschedule for now, fire again, forever.
assert.equal(msUntilNextRun(at("2026-09-07T03:00:00Z"), 3), DAY);
// Hour 0 has no special case; it is just "the next midnight".
assert.equal(msUntilNextRun(at("2026-09-07T00:00:00Z"), 0), DAY);
assert.equal(msUntilNextRun(at("2026-09-06T23:59:59Z"), 0), 1000);

// DST is why this is UTC. Europe/Warsaw goes 02:00 -> 03:00 local on 2026-03-29, so a
// local-hour schedule would skip or repeat a day; in UTC every gap is exactly 24h.
for (const day of ["2026-03-28", "2026-03-29", "2026-10-25"]) {
  assert.equal(msUntilNextRun(at(`${day}T03:00:00Z`), 3), DAY, `${day} must be a plain 24h`);
}

const suggestion = (matchId: number) => ({ metrics: { matchId } });
const ranked = [suggestion(1), suggestion(2), suggestion(3), suggestion(4)];
const roomy = { processedIds: [], hiddenIds: new Set<number>(), freeMatches: 9 };

// Ranked order is the whole point of the suggester, so the pick is the first survivor, never
// a "best remaining" recomputed here.
assert.equal(pickNightlyCandidate(ranked, roomy)?.metrics.matchId, 1);
assert.equal(pickNightlyCandidate(ranked, { ...roomy, processedIds: [1, 2] })?.metrics.matchId, 3);
assert.equal(pickNightlyCandidate(ranked, { ...roomy, hiddenIds: new Set([1, 3]) })?.metrics.matchId, 2);
// Both filters at once: 1 rendered before, 2 hidden, 3 rendered before.
assert.equal(
  pickNightlyCandidate(ranked, { processedIds: [1, 3], hiddenIds: new Set([2]), freeMatches: 9 })?.metrics
    .matchId,
  4,
);
assert.equal(pickNightlyCandidate(ranked, { ...roomy, processedIds: [1, 2, 3, 4] }), null);
assert.equal(pickNightlyCandidate([], roomy), null);

// A match is ~7 GB. Starting one with a single slot left means a render that dies at the write
// stage, having burned the night; unknown capacity is reported as 0 and must behave the same.
assert.equal(pickNightlyCandidate(ranked, { ...roomy, freeMatches: 1 }), null);
assert.equal(pickNightlyCandidate(ranked, { ...roomy, freeMatches: 0 }), null);
assert.equal(pickNightlyCandidate(ranked, { ...roomy, freeMatches: 2 })?.metrics.matchId, 1);

// --- Whether the night ends with a Short. The spawn is injected: the real one is a full render,
// and this is a test of the decision, not of ffmpeg.
{
  const spawned: Array<{ matchId: number; pick: number }> = [];
  const runner =
    (code: number): ShortRunner =>
    (matchId, pick) => {
      spawned.push({ matchId, pick });
      const proc = new EventEmitter() as ChildProcess;
      // The close listener is attached after the runner returns, so it cannot fire synchronously.
      setImmediate(() => proc.emit("close", code));
      return proc;
    };

  assert.equal(await chainShort(1, "done", true, runner(0)), " + Short rendered");
  // The flag is the whole point of the flag.
  assert.equal(await chainShort(2, "done", false, runner(0)), "");
  // An abort is the operator saying stop, and a failed render may have left nothing to cut from;
  // neither is a licence to spend the rest of the night on a Short.
  assert.equal(await chainShort(3, "aborted", true, runner(0)), "");
  assert.equal(await chainShort(4, "failed: ffmpeg died", true, runner(0)), "");
  assert.deepEqual(
    spawned,
    [{ matchId: 1, pick: 0 }],
    "only a clean render with the flag on may spawn, and always the top moment",
  );

  // A Short that fails does not turn a rendered match into a failure — it is a clause, not a
  // verdict, and the notification has to carry both halves.
  assert.match(await chainShort(5, "done", true, runner(1)), /Short failed/);
}

console.log("nightly: all checks passed");
