// Self-check for restartWhenIdle.ts. `blockedBy`/`idle` are pure functions over injected deps —
// no fixture directory needed, the whole point of the signal list being functions rather than
// disk reads baked in. `armRestart`'s stateful loop is exercised with `ArmOptions` overrides (a
// fake idle reading, a fake boot check, millisecond timings) so the test needs no real tsc spawn
// and no real six-hour wait, and never reaches the real exit path (which would kill this process).
// Run: npx tsx src/dashboard/restartWhenIdle.test.ts
import assert from "node:assert/strict";
import {
  armRestart,
  blockedBy,
  disarmRestart,
  idle,
  restartState,
  type IdleDeps,
} from "./restartWhenIdle.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const allClear = (): IdleDeps => ({
  jobRunning: () => false,
  exportRunning: () => false,
  shortRunning: () => false,
  pickRunning: () => false,
  chainRunning: () => false,
  uploadRunning: () => false,
  uploadSessionFile: () => false,
  archiveRunning: () => false,
  nightlyChainRunning: () => false,
  thumbnailRunning: () => false,
  videoWriting: () => false,
  nightlyHourUtc: null,
});

// --- idle()/blockedBy(): every signal, toggled one at a time -----------------------------------
assert.equal(idle(allClear()), true, "nothing running is idle");
assert.deepEqual(blockedBy(allClear()), [], "nothing running blocks on nothing");

const SIGNALS: [Exclude<keyof IdleDeps, "nightlyHourUtc">, string][] = [
  ["jobRunning", "a render is running"],
  ["exportRunning", "an export is running"],
  ["shortRunning", "a Short is rendering"],
  ["pickRunning", "the model is picking a Short's moment"],
  ["chainRunning", "the publish chain is running"],
  ["uploadRunning", "an upload is running"],
  ["uploadSessionFile", "an upload session is still on disk"],
  ["archiveRunning", "an archive copy to the NAS is running"],
  ["nightlyChainRunning", "a nightly chain is between renders"],
  ["thumbnailRunning", "a thumbnail re-render is running"],
  ["videoWriting", "a Finish or Put on YouTube is writing"],
];
for (const [key, reason] of SIGNALS) {
  const deps = { ...allClear(), [key]: () => true };
  assert.equal(idle(deps), false, `${key} alone must block idle()`);
  assert.deepEqual(blockedBy(deps), [reason], `${key} must read as "${reason}"`);
}
// Two at once: both reasons, in the checked order — not just "something is wrong".
assert.deepEqual(
  blockedBy({ ...allClear(), jobRunning: () => true, uploadRunning: () => true }),
  ["a render is running", "an upload is running"],
  "every true signal is named, not just the first",
);
console.log("OK: every idle() signal blocks on its own and names itself");

// --- The window before the nightly hour ---------------------------------------------------------
const at = (iso: string): number => Date.parse(iso);
// 03:00 UTC is the default nightly hour in these tests' fixtures below.
assert.equal(
  idle({ ...allClear(), nightlyHourUtc: 3 }, at("2026-10-08T02:39:00Z")),
  true,
  "21 min before — clear",
);
assert.equal(
  idle({ ...allClear(), nightlyHourUtc: 3 }, at("2026-10-08T02:40:00Z")),
  false,
  "exactly 20 min before — blocked",
);
assert.equal(
  idle({ ...allClear(), nightlyHourUtc: 3 }, at("2026-10-08T02:59:00Z")),
  false,
  "1 min before — blocked",
);
assert.equal(
  idle({ ...allClear(), nightlyHourUtc: 3 }, at("2026-10-08T03:01:00Z")),
  true,
  "just after the hour — clear (almost 24h to the next one)",
);
assert.equal(
  idle({ ...allClear(), nightlyHourUtc: null }, at("2026-10-08T02:59:00Z")),
  true,
  "nightly disabled — never blocks",
);
assert.ok(
  blockedBy({ ...allClear(), nightlyHourUtc: 3 }, at("2026-10-08T02:45:00Z"))[0].includes("nightly"),
  "the reason names the nightly render",
);
console.log("OK: the 20-minute nightly window blocks exactly on its boundary");

// --- A failed boot check disarms: no automatic retry, the error stays on the state -------------
{
  let bootCalls = 0;
  const state = armRestart({
    idleDeps: () => allClear(),
    bootCheck: async () => {
      bootCalls += 1;
      return "src/foo.ts(1,1): error TS1: bogus";
    },
    checkIntervalMs: 10,
    expireMs: 5_000,
  });
  assert.equal(state.error, undefined, "a fresh arm starts with no error");
  await sleep(120);
  const after = restartState();
  assert.ok(after, "still armed — the error is kept visible, not cleared");
  assert.equal(after?.error, "src/foo.ts(1,1): error TS1: bogus");
  assert.equal(
    bootCalls,
    1,
    "a failing boot check must not be retried on its own — only a fresh POST tries again",
  );
  disarmRestart();
}
console.log("OK: a failed boot check disarms the loop and keeps its error");

// --- A signal function throwing (not just a failed tsc) also surfaces as an error --------------
{
  const state = armRestart({
    // Idle on the first read (so the boot check runs), broken on the second (the one right
    // before the would-be exit) — the exact shape of a transient failure in one of the real
    // idleDeps functions, not a failing tsc.
    idleDeps: (() => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls === 1) return { ...allClear() };
        throw new Error("transient: disk read failed");
      };
    })(),
    bootCheck: async () => null,
    checkIntervalMs: 10,
    expireMs: 5_000,
  });
  assert.equal(state.error, undefined, "a fresh arm starts with no error");
  await sleep(120);
  const after = restartState();
  assert.ok(after, "still armed — a broken check must not silently vanish");
  assert.equal(
    after?.error,
    "transient: disk read failed",
    "a thrown signal must surface the same way a failed boot check does, not only in the log",
  );
  disarmRestart();
}
console.log("OK: a thrown idleDeps signal sets the same visible error a failed boot check does");

// --- Something starts during the (idle) boot check: resume rather than exit --------------------
{
  let idleReads = 0;
  let exitCalls = 0;
  const state = armRestart({
    idleDeps: () => {
      idleReads += 1;
      // Idle for the check that gates the boot check; blocked again by the time it is re-checked
      // right before the would-be exit.
      return idleReads === 1 ? allClear() : { ...allClear(), jobRunning: () => true };
    },
    bootCheck: async () => null,
    checkIntervalMs: 10,
    expireMs: 5_000,
    exit: () => (exitCalls += 1),
  });
  assert.equal(state.blockedBy.length, 0);
  await sleep(120);
  const after = restartState();
  assert.ok(after, "a render that started mid-check must not have been exited past");
  assert.deepEqual(after?.blockedBy, ["a render is running"], "the second reading wins, not the first");
  assert.equal(exitCalls, 0, "a new blocker on the second read must stop this from ever calling exit");
  disarmRestart();
}
console.log("OK: a signal that turns true during the boot check is caught before exiting");

// --- Genuinely idle both times, the boot check passes: exit is actually called ------------------
{
  let exitCalls = 0;
  const state = armRestart({
    idleDeps: () => allClear(),
    bootCheck: async () => null,
    checkIntervalMs: 10,
    expireMs: 5_000,
    exit: () => (exitCalls += 1),
  });
  assert.equal(state.blockedBy.length, 0);
  await sleep(120);
  assert.equal(exitCalls, 1, "idle before and after a passing boot check must call exit exactly once");
  disarmRestart();
}
console.log("OK: idle() clear on both reads with a clean boot check actually calls exit, once");

// --- A DELETE (or a fresh POST) while the boot check runs: that tick speaks for no arm ---------
{
  let exitCalls = 0;
  let checking = false;
  let idleReads = 0;
  armRestart({
    idleDeps: () => {
      idleReads += 1;
      return allClear();
    },
    bootCheck: async () => {
      checking = true;
      await sleep(200);
      return null;
    },
    checkIntervalMs: 10,
    expireMs: 5_000,
    exit: () => (exitCalls += 1),
  });
  while (!checking) await sleep(5);
  assert.equal(disarmRestart(), true);
  const reads = idleReads;
  await sleep(400);
  assert.equal(exitCalls, 0, "cancelled during tsc: the passing check must not exit anyway");
  assert.equal(restartState(), null);
  assert.equal(idleReads, reads, "and the cancelled arm's poll is not resurrected");
}
{
  let exitCalls = 0;
  let checking = false;
  armRestart({
    idleDeps: () => allClear(),
    bootCheck: async () => {
      checking = true;
      await sleep(200);
      return "error TS2304: the old checkout";
    },
    checkIntervalMs: 10,
    expireMs: 5_000,
    exit: () => (exitCalls += 1),
  });
  while (!checking) await sleep(5);
  armRestart({
    idleDeps: () => ({ ...allClear(), jobRunning: () => true }),
    bootCheck: async () => null,
    checkIntervalMs: 10,
    expireMs: 5_000,
    exit: () => (exitCalls += 1),
  });
  await sleep(400);
  assert.equal(exitCalls, 0);
  assert.equal(restartState()?.error, undefined, "the replaced arm's tsc error is not the new arm's");
  assert.deepEqual(restartState()?.blockedBy, ["a render is running"], "the new arm polls on its own");
  disarmRestart();
}
console.log("OK: a DELETE or a fresh POST during the boot check wins over the tick already in it");

// --- Expiry: an arm that never goes idle gives up after its window, cleanly --------------------
{
  const state = armRestart({
    idleDeps: () => ({ ...allClear(), jobRunning: () => true }),
    bootCheck: async () => null,
    checkIntervalMs: 10,
    expireMs: 40,
  });
  assert.ok(state);
  await sleep(120);
  assert.equal(
    restartState(),
    null,
    "an arm that stayed blocked past its window is dropped, not left pending",
  );
}
console.log("OK: an arm that never goes idle expires and clears itself");

// --- DELETE's return value: whether anything was actually armed --------------------------------
assert.equal(disarmRestart(), false, "nothing armed — DELETE says so rather than pretending");
armRestart({
  idleDeps: () => ({ ...allClear(), jobRunning: () => true }),
  bootCheck: async () => null,
  checkIntervalMs: 10_000,
  expireMs: 10_000,
});
assert.equal(disarmRestart(), true, "an armed restart — DELETE says it cancelled one");
assert.equal(restartState(), null, "cancelled means gone, not just paused");
console.log("OK: disarmRestart reports whether it actually cancelled something");
