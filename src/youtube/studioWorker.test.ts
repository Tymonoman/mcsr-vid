// Pure-logic self-check for the Studio worker (src/youtube/studioWorker.ts): what one cycle
// decides to do, and that a bad Test & Compare title is refused before any browser is touched.
// No real browser, no network. Run: npx tsx src/youtube/studioWorker.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { StudioHandle } from "./studioBrowser.js";
import { pickStarterLayoutLabel, startTestAndCompare, STARTER_LAYOUT_PREFERENCE } from "./studioActions.js";
import type { Experiment } from "./studioExperiments.js";
import {
  inBlackoutWindow,
  markEndScreenDone,
  markPickerEmptySeen,
  newCodeWaiting,
  planCycle,
  playersFor,
  nextSameErrorStreak,
  readHeartbeat,
  readLedger,
  runCycle,
  runWorker,
  setExperimentChecked,
  setExperimentReadFailed,
  testFor,
  writeHeartbeat,
  writeLedger,
  type LongFormRef,
  type StudioLedger,
} from "./studioWorker.js";
import { readExperiments, updateTcExperiments } from "./studioExperiments.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-studioworker-"));
config.mediaDir = media;

// --- planCycle: end screens -------------------------------------------------------------------
{
  const longForms: LongFormRef[] = [
    { videoId: "a", matchId: 1, uploadedAt: "2026-10-07T01:00:00.000Z", privacyStatus: "public" },
    { videoId: "b", matchId: 2, uploadedAt: "2026-10-08T01:00:00.000Z", privacyStatus: "private" },
    { videoId: "c", matchId: 3, uploadedAt: "2026-01-01T00:00:00.000Z", privacyStatus: "public" },
    { videoId: "d", matchId: 4, uploadedAt: "2026-01-01T00:00:00.000Z", privacyStatus: "private" },
    { videoId: "e", matchId: 5, uploadedAt: "2026-10-09T01:00:00.000Z", privacyStatus: "private" },
    { videoId: "f", matchId: 6, uploadedAt: "2026-10-10T01:00:00.000Z", privacyStatus: "private" },
  ];
  const ledger: StudioLedger = {
    endScreens: { a: { at: "x", matchId: 1 } },
    pickerEmptySeen: { b: "2026-10-11T00:00:01.000Z" },
  };
  const plan = planCycle(new Date("2026-10-11T12:00:00.000Z"), longForms, ledger, []);
  const ids = plan.endScreenTargets.map((t) => t.videoId);
  assert.ok(!ids.includes("a"), "already in the ledger — must not be offered again");
  assert.ok(!ids.includes("d"), "old and private — neither condition holds");
  assert.ok(!ids.includes("b"), "already hit the picker-empty bug earlier today — not retried this same day");
  assert.ok(ids.includes("c"), "old but public");
  assert.ok(
    ids.includes("e"),
    "uploaded on/after the cutoff — b's exclusion must not shrink the cap below 3",
  );
  assert.equal(plan.endScreenTargets.length, 3, `capped at 3 per cycle, got ${ids.join(",")}`);
  console.log("OK: end-screen candidates are ledger-filtered, cutoff-or-public, capped at 3");

  // A picker-empty seen on an earlier UTC day is offered again — the bug may be fixed by then.
  const yesterday: StudioLedger = { endScreens: {}, pickerEmptySeen: { b: "2026-10-10T00:00:01.000Z" } };
  const plan2 = planCycle(new Date("2026-10-11T12:00:00.000Z"), longForms, yesterday, []);
  assert.ok(
    plan2.endScreenTargets.map((t) => t.videoId).includes("b"),
    "a picker-empty from a previous UTC day is retried",
  );
  console.log("OK: a picker-empty candidate is retried on a later UTC day, not blocked forever");
}

// --- planCycle: Test & Compare starts and daily checks ----------------------------------------
{
  const planned = (id: string): Experiment => ({
    id,
    kind: "tc",
    arms: [{ name: "control" }],
    videos: [{ videoId: id, matchId: 1, arm: "tc" }],
    status: "planned",
  });
  const running = (id: string, checkedAt?: string): Experiment => ({
    id,
    kind: "tc",
    arms: [{ name: "control" }],
    videos: [{ videoId: id, matchId: 1, arm: "tc" }],
    status: "running",
    result: checkedAt ? { checkedAt } : undefined,
  });
  const between: Experiment = {
    id: "between-x",
    kind: "between",
    arms: [{ name: "a" }],
    videos: [],
    status: "running",
  };
  const now = new Date("2026-10-11T12:00:00.000Z");
  const experiments = [
    planned("p1"),
    planned("p2"),
    planned("p3"),
    running("r1", "2026-10-11T00:00:01.000Z"), // checked earlier today — skip
    running("r2", "2026-10-10T23:00:00.000Z"), // checked yesterday — due
    running("r3"), // never checked — due
    between,
  ];
  const plan = planCycle(now, [], { endScreens: {}, pickerEmptySeen: {} }, experiments);
  assert.deepEqual(
    plan.tcToStart.map((e) => e.id),
    ["p1", "p2"],
    "capped at 2 starts a cycle",
  );
  assert.deepEqual(
    new Set(plan.tcToCheck.map((e) => e.id)),
    new Set(["r2", "r3"]),
    "only running tc experiments not already checked today",
  );
  assert.ok(!plan.tcToStart.some((e) => e.kind !== "tc") && !plan.tcToCheck.some((e) => e.kind !== "tc"));
  console.log(
    "OK: tc starts capped at 2, daily check skips one already checked today, 'between' entries ignored",
  );
}

// --- inBlackoutWindow --------------------------------------------------------------------------
{
  // Default hour (3 UTC): 10 min lead-in, through the 4h chain window plus a 30 min finish
  // buffer — 02:50 through 07:30 UTC inclusive.
  assert.equal(inBlackoutWindow(new Date("2026-10-11T02:49:00.000Z"), 3), false);
  assert.equal(inBlackoutWindow(new Date("2026-10-11T02:50:00.000Z"), 3), true);
  assert.equal(inBlackoutWindow(new Date("2026-10-11T07:30:00.000Z"), 3), true);
  assert.equal(inBlackoutWindow(new Date("2026-10-11T07:31:00.000Z"), 3), false);
  console.log("OK: the default hour's blackout window (02:50-07:30 UTC) edges are inclusive/exclusive");
}
{
  // The window follows a different configured hour rather than a hardcoded 3 — the regression
  // this fixes: the operator moving nightlyRenderHourUtc in Settings (no restart) must move the
  // worker's own blackout with it.
  assert.equal(inBlackoutWindow(new Date("2026-10-11T19:49:00.000Z"), 20), false);
  assert.equal(inBlackoutWindow(new Date("2026-10-11T19:50:00.000Z"), 20), true);
  console.log("OK: the window tracks nightlyRenderHourUtc, not a hardcoded hour");
}
{
  // Wraps past midnight UTC without a word.
  assert.equal(inBlackoutWindow(new Date("2026-10-12T00:30:00.000Z"), 23), true);
  assert.equal(inBlackoutWindow(new Date("2026-10-12T03:31:00.000Z"), 23), false);
  console.log("OK: the window wraps across UTC midnight");
}
{
  // null (nightly disabled) turns the blackout off entirely — nothing to avoid colliding with.
  assert.equal(inBlackoutWindow(new Date("2026-10-11T03:00:00.000Z"), null), false);
  console.log("OK: a null nightlyRenderHourUtc disables the blackout");
}

// --- newCodeWaiting: pure HEAD-changed check (the supervisor's own restart signal) --------------
{
  assert.equal(newCodeWaiting("abc1234", "abc1234"), false, "same HEAD — nothing waiting");
  assert.equal(newCodeWaiting("abc1234", "def5678"), true, "live HEAD moved past the boot HEAD");
  assert.equal(newCodeWaiting(null, "def5678"), false, "an unreadable boot HEAD never counts as a change");
  assert.equal(newCodeWaiting("abc1234", null), false, "an unreadable live HEAD never counts as a change");
  console.log("OK: newCodeWaiting is true only when both HEADs are readable and differ");
}

// --- runWorker: exits cleanly for new code at the start of the blackout, never mid-cycle --------
{
  const exits: number[] = [];
  // Inside the blackout window at the default hour (3 UTC; see inBlackoutWindow's own tests).
  const blackout = new Date("2026-10-11T03:00:00.000Z");
  await runWorker({
    bootHead: "abc1234",
    headNow: () => "def5678",
    now: () => blackout,
    exit: (code) => {
      exits.push(code);
    },
  });
  assert.deepEqual(exits, [0], "exits exactly once, with code 0, on new code during the blackout");
  // No heartbeat written for this cycle: the exit happens before any cycle work, same as a real
  // process dying right there — nothing to report that the next (new-code) process won't also say.
  assert.equal(await readHeartbeat(), null, "exited before ever reaching the heartbeat write");
  console.log("OK: runWorker exits once (code 0) when new code is waiting during the blackout");
}
{
  // Same blackout window, no code change: the loop must NOT exit — it writes a skipped heartbeat
  // and returns normally when `once` is set, exactly like today's behaviour.
  const exits: number[] = [];
  const blackout = new Date("2026-10-11T03:00:00.000Z");
  await runWorker({
    once: true,
    bootHead: "abc1234",
    headNow: () => "abc1234",
    now: () => blackout,
    exit: (code) => {
      exits.push(code);
    },
  });
  assert.deepEqual(exits, [], "no code change — never exits");
  const hb = await readHeartbeat();
  assert.equal(hb?.lastCycle?.probe, "skipped", "the blackout cycle itself is still recorded as skipped");
  console.log("OK: runWorker does not exit for new code when the live HEAD matches what it started on");
}
{
  // `--once` is for a manual/test run: it must not call exit() on our behalf even if new code is
  // waiting — the caller already gets a normal return after one cycle.
  const exits: number[] = [];
  const blackout = new Date("2026-10-11T03:00:00.000Z");
  await runWorker({
    once: true,
    bootHead: "abc1234",
    headNow: () => "def5678",
    now: () => blackout,
    exit: (code) => {
      exits.push(code);
    },
  });
  assert.deepEqual(exits, [], "--once never calls exit() itself, even with new code waiting");
  console.log("OK: --once returns normally rather than exiting, even during a new-code blackout");
}

// --- testFor / playersFor --------------------------------------------------------------------
{
  const titleExp: Experiment = {
    id: "tc-title-x",
    kind: "tc",
    variable: "title",
    controlArm: "control",
    arms: [
      { name: "control", settings: { title: "LIVE | edcr vs doogile | MCSR Ranked 1v1" } },
      { name: "challenger1", settings: { title: "NEW HOOK | edcr vs doogile | MCSR Ranked 1v1" } },
    ],
    videos: [{ videoId: "x", matchId: 1, arm: "tc" }],
    status: "planned",
  };
  const test = testFor(titleExp);
  assert.deepEqual(test, { kind: "title", titles: ["NEW HOOK | edcr vs doogile | MCSR Ranked 1v1"] });
  assert.deepEqual(playersFor(titleExp), [{ nickname: "edcr" }, { nickname: "doogile" }]);

  const thumbExp: Experiment = {
    id: "tc-thumbnail-y",
    kind: "tc",
    variable: "thumbnail",
    controlArm: "control",
    arms: [
      { name: "control", settings: { file: "/a/control.png" } },
      { name: "challenger1", settings: { file: "/a/challenger.png" } },
    ],
    videos: [{ videoId: "y", matchId: 1, arm: "tc" }],
    status: "planned",
  };
  assert.deepEqual(testFor(thumbExp), { kind: "thumbnail", files: ["/a/control.png", "/a/challenger.png"] });
  assert.deepEqual(playersFor(thumbExp), [], "a thumbnail experiment names no players");

  assert.equal(testFor({ ...titleExp, variable: undefined }), null, "no variable, no test");
  console.log("OK: testFor/playersFor read an experiment's arms correctly for both kinds");
}

// --- startTestAndCompare refuses a bad title before touching the browser ----------------------
{
  // Any access to `.browser` fails the test rather than the function: proof the refusal happened
  // before the browser was ever reached.
  const poisoned = {
    get browser(): never {
      throw new Error("must not touch the browser — validation should have refused first");
    },
    debugPort: 0,
    async stop() {},
  } as unknown as StudioHandle;
  const players = [{ nickname: "edcr" }, { nickname: "doogile" }];

  const spoiler = "DOOGILE WINS IT | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun";
  const r1 = await startTestAndCompare(
    poisoned,
    "vid",
    { kind: "title", titles: [spoiler] },
    { matchId: 1, players },
  );
  assert.ok(typeof r1 === "object" && "error" in r1, `expected a refusal, got ${JSON.stringify(r1)}`);
  assert.match((r1 as { error: string }).error, /gives the result away/);

  const tooLong = `${"X".repeat(90)} | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun`;
  const r2 = await startTestAndCompare(
    poisoned,
    "vid",
    { kind: "title", titles: [tooLong] },
    { matchId: 1, players },
  );
  assert.ok(typeof r2 === "object" && "error" in r2);
  assert.match((r2 as { error: string }).error, /100 characters/);

  const r3 = await startTestAndCompare(
    poisoned,
    "vid",
    { kind: "thumbnail", files: ["/no/such/file-a.png", "/no/such/file-b.png"] },
    { matchId: 1 },
  );
  assert.ok(typeof r3 === "object" && "error" in r3);
  assert.match((r3 as { error: string }).error, /not found/);

  console.log(
    "OK: startTestAndCompare refuses a spoiler, an over-length title and a missing thumbnail file without ever opening a page",
  );
}

// --- ledger / heartbeat: atomic write-then-rename, corrupt file degrades safely ----------------
{
  await markEndScreenDone("vidZ", 99);
  await markPickerEmptySeen("vidY", new Date("2026-10-11T00:00:00.000Z"));
  const ledger = await readLedger();
  assert.equal(ledger.endScreens.vidZ?.matchId, 99);
  assert.equal(ledger.pickerEmptySeen.vidY, "2026-10-11T00:00:00.000Z");
  const files = await readdir(media);
  assert.ok(!files.includes(".studio-ledger.json.tmp"), "no leftover .tmp after a write");
  assert.ok(existsSync(path.join(media, ".studio-ledger.json")));

  writeFileSync(path.join(media, ".studio-ledger.json"), "{not json");
  const recovered = await readLedger();
  assert.deepEqual(
    recovered,
    { endScreens: {}, pickerEmptySeen: {} },
    "a corrupt ledger degrades to empty, never throws",
  );

  await writeHeartbeat({ pid: 123, at: "t", lastCycle: null, lastError: "a", lastErrors: ["a", "b"] });
  const hb = await readHeartbeat();
  assert.equal(hb?.pid, 123);
  assert.deepEqual(hb?.lastErrors, ["a", "b"], "every error of the cycle, not just the first");
  console.log("OK: ledger and heartbeat round-trip atomically and a corrupt ledger degrades to empty");
}

// --- nextSameErrorStreak: read-before-write streak the morning report leans on ------------------
{
  await writeHeartbeat({ pid: 1, at: "t0", lastCycle: null, lastError: null, lastErrors: [] });
  assert.equal(await nextSameErrorStreak(null), 0, "no error this cycle — no streak");
  assert.equal(await nextSameErrorStreak("boom"), 1, "a fresh error after a clean cycle starts at 1");

  await writeHeartbeat({
    pid: 1,
    at: "t1",
    lastCycle: null,
    lastError: "boom",
    lastErrors: ["boom"],
    sameErrorStreak: 1,
  });
  assert.equal(await nextSameErrorStreak("boom"), 2, "the same message again — streak grows");
  assert.equal(await nextSameErrorStreak("different"), 1, "a different message resets to 1, not 0");

  await writeHeartbeat({ pid: 1, at: "t2", lastCycle: null, lastError: null, lastErrors: [] });
  assert.equal(await nextSameErrorStreak("boom"), 1, "a clean cycle in between resets the streak");
  console.log("OK: nextSameErrorStreak grows on a repeat, resets on a change or a clean cycle");
}

// --- planCycle: thumbnailTcTargets, auto-planned thumbnail tests (phase 4, 8 Oct 2026) ---------
{
  const longForms: LongFormRef[] = [
    // Not source "dashboard" — a Studio-recorded upload is never auto-tested.
    {
      videoId: "studio1",
      matchId: 10,
      uploadedAt: "2026-10-09T00:00:00.000Z",
      privacyStatus: "public",
      source: "studio",
    },
    // Before the cutoff — never retroactive.
    {
      videoId: "old1",
      matchId: 11,
      uploadedAt: "2026-10-07T23:59:59.000Z",
      privacyStatus: "public",
      source: "dashboard",
    },
    // Already has a tc experiment (a title test, not even a thumbnail one — "no tc experiment
    // yet" covers any kind, since Studio only ever runs one at a time anyway).
    {
      videoId: "titled1",
      matchId: 12,
      uploadedAt: "2026-10-09T00:00:00.000Z",
      privacyStatus: "public",
      source: "dashboard",
    },
    // Blocked player's footage — never offered, same as every other Studio action.
    {
      videoId: "blocked1",
      matchId: 13,
      uploadedAt: "2026-10-09T00:00:00.000Z",
      privacyStatus: "private",
      source: "dashboard",
    },
    // Two good candidates, to prove the cap.
    {
      videoId: "good1",
      matchId: 14,
      uploadedAt: "2026-10-08T00:00:00.000Z",
      privacyStatus: "private",
      source: "dashboard",
    },
    {
      videoId: "good2",
      matchId: 15,
      uploadedAt: "2026-10-09T00:00:00.000Z",
      privacyStatus: "private",
      source: "dashboard",
    },
    {
      videoId: "good3",
      matchId: 16,
      uploadedAt: "2026-10-09T00:00:00.000Z",
      privacyStatus: "private",
      source: "dashboard",
    },
  ];
  const experiments: Experiment[] = [
    {
      id: "tc-title-titled1",
      kind: "tc",
      variable: "title",
      arms: [{ name: "control" }],
      videos: [{ videoId: "titled1", matchId: 12, arm: "tc" }],
      status: "running",
    },
  ];
  const now = new Date("2026-10-09T12:00:00.000Z");
  const isBlocked = (matchId: number): boolean => matchId === 13;
  const plan = planCycle(now, longForms, { endScreens: {}, pickerEmptySeen: {} }, experiments, isBlocked);
  const ids = plan.thumbnailTcTargets.map((t) => t.videoId);
  assert.ok(!ids.includes("studio1"), "a Studio-recorded upload is never auto-tested");
  assert.ok(!ids.includes("old1"), "uploaded before the cutoff — never retroactive");
  assert.ok(!ids.includes("titled1"), "already has a tc experiment of its own (any kind)");
  assert.ok(!ids.includes("blocked1"), "a blocked player's footage is never offered");
  assert.equal(plan.thumbnailTcTargets.length, 2, `capped at 2 per cycle, got ${ids.join(",")}`);
  assert.ok(
    ids.includes("good1") && ids.includes("good2"),
    `good1/good2 expected ahead of good3, got ${ids.join(",")}`,
  );
  console.log(
    "OK: thumbnailTcTargets is dashboard-sourced, on/after the cutoff, untested, unblocked, capped at 2",
  );
}

// --- planCycle: pinTargets (phase 5, 8 Oct 2026) -----------------------------------------------
{
  const longForms: LongFormRef[] = [
    // Comment posted, pin never attempted — a candidate.
    { videoId: "a", matchId: 1, uploadedAt: "x", privacyStatus: "public", finishedComment: null },
    // Comment posted, pin already failed once — still "to do", worth retrying.
    {
      videoId: "b",
      matchId: 2,
      uploadedAt: "x",
      privacyStatus: "public",
      finishedComment: null,
      finishedPin: "a Studio error from last time",
    },
    // Comment posted, pin already done — never offered again.
    {
      videoId: "c",
      matchId: 3,
      uploadedAt: "x",
      privacyStatus: "public",
      finishedComment: null,
      finishedPin: null,
    },
    // No comment posted yet (never attempted) — nothing for Studio to pin.
    { videoId: "d", matchId: 4, uploadedAt: "x", privacyStatus: "public", finishedComment: undefined },
    // Comment attempt failed (private at the time) — still no comment to pin.
    { videoId: "e", matchId: 5, uploadedAt: "x", privacyStatus: "private", finishedComment: "left alone" },
    // A series copy of "a" in a second game folder — same videoId, different matchId.
    { videoId: "a", matchId: 6, uploadedAt: "x", privacyStatus: "public", finishedComment: null },
    // Three more fresh candidates to prove the cap.
    { videoId: "f", matchId: 7, uploadedAt: "x", privacyStatus: "public", finishedComment: null },
    { videoId: "g", matchId: 8, uploadedAt: "x", privacyStatus: "public", finishedComment: null },
  ];
  const plan = planCycle(
    new Date("2026-10-11T12:00:00.000Z"),
    longForms,
    { endScreens: {}, pickerEmptySeen: {} },
    [],
  );
  const ids = plan.pinTargets.map((t) => t.videoId);
  assert.ok(ids.includes("a") && ids.includes("b"), "comment posted, pin never done or previously failed");
  assert.ok(!ids.includes("c"), "pin already done — never offered again");
  assert.ok(!ids.includes("d"), "comment never attempted — nothing to pin");
  assert.ok(!ids.includes("e"), "comment attempt itself failed — nothing to pin");
  assert.equal(ids.filter((id) => id === "a").length, 1, "a series copy of the same video is de-duped");
  assert.equal(plan.pinTargets.length, 3, `capped at 3 per cycle, got ${ids.join(",")}`);
  console.log(
    "OK: pinTargets is comment-posted/pin-not-done, de-duped by videoId across series copies, capped at 3",
  );
}

// --- planCycle: pinTargets — a series copy already marked done elsewhere is never re-offered ---
// (a cross-cycle case: `markPinDone` only ever writes the one matchId it pinned through, so a
// *different* game folder's own copy of the same video can still read `finishedPin: undefined` on
// the very next cycle. Without the OR-merge this must still exclude every copy of that videoId.)
{
  const longForms: LongFormRef[] = [
    // Game 1's own copy: already pinned (a previous cycle marked this one done).
    {
      videoId: "a",
      matchId: 1,
      uploadedAt: "x",
      privacyStatus: "public",
      finishedComment: null,
      finishedPin: null,
    },
    // Game 2's copy of the SAME video: never itself marked done — would pass the per-entry filter
    // on its own, and must still be excluded because the video it points at is already pinned.
    { videoId: "a", matchId: 2, uploadedAt: "x", privacyStatus: "public", finishedComment: null },
    // An unrelated, genuinely pending video must still be offered.
    { videoId: "h", matchId: 9, uploadedAt: "x", privacyStatus: "public", finishedComment: null },
  ];
  const plan = planCycle(
    new Date("2026-10-11T12:00:00.000Z"),
    longForms,
    { endScreens: {}, pickerEmptySeen: {} },
    [],
  );
  const ids = plan.pinTargets.map((t) => t.videoId);
  assert.ok(
    !ids.includes("a"),
    "a videoId already pinned through one series copy is never re-offered via another",
  );
  assert.ok(ids.includes("h"), "a genuinely pending, unrelated video is still offered");
  console.log("OK: pinTargets excludes a videoId already marked done through a different series copy");
}

// --- setExperimentChecked: promotes "planned" to "running" when Studio already has one going ---
// (phase 4, 8 Oct 2026 — LUI5E7yF0zE's own history: a test started by hand before this experiment
// was ever planned must be reconciled, never started a second time).
{
  const expId = "tc-thumbnail-reconcile-test";
  await updateTcExperiments((tc) => [
    ...tc,
    {
      id: expId,
      kind: "tc",
      variable: "thumbnail",
      arms: [{ name: "control" }],
      videos: [{ videoId: "vidReconcile", matchId: 1, arm: "tc" }],
      status: "planned",
    },
  ]);

  await setExperimentChecked(expId, { state: "running", raw: "Your test is live." });
  const afterRunning = (await readExperiments()).experiments.find((e) => e.id === expId);
  assert.equal(
    afterRunning?.status,
    "running",
    "a 'planned' experiment is promoted once Studio shows it running",
  );
  assert.ok(afterRunning?.start, "a start timestamp is set when promoting from planned");
  const firstStart = afterRunning?.start;

  // A later daily check of the same already-running experiment must not reset its start time.
  await setExperimentChecked(expId, { state: "running", raw: "Your test is live." });
  const afterSecondCheck = (await readExperiments()).experiments.find((e) => e.id === expId);
  assert.equal(afterSecondCheck?.status, "running");
  assert.equal(afterSecondCheck?.start, firstStart, "start is not clobbered on a later check");

  await setExperimentChecked(expId, { state: "done", winner: "Thumbnail 2", raw: "Winner: Thumbnail 2" });
  const afterDone = (await readExperiments()).experiments.find((e) => e.id === expId);
  assert.equal(afterDone?.status, "done");
  assert.match(afterDone?.verdict ?? "", /Thumbnail 2/);
  console.log(
    "OK: setExperimentChecked promotes planned->running on first sight of a live test, keeps start stable, and still reaches done",
  );
}

// --- pickStarterLayoutLabel: end-screen starter-layout preference (phase 4, 8 Oct 2026) --------
{
  assert.equal(
    pickStarterLayoutLabel(new Set(STARTER_LAYOUT_PREFERENCE)),
    "2 videos, 1 subscribe",
    "closest to the operator's own template wins when both are on offer",
  );
  assert.equal(
    pickStarterLayoutLabel(new Set(["1 video, 1 subscribe"])),
    "1 video, 1 subscribe",
    "falls back to 1 video + 1 subscribe when that is all there is — the real gallery's own shape",
  );
  assert.equal(
    pickStarterLayoutLabel(new Set(["2 videos", "1 video, 1 playlist, 1 subscribe"])),
    null,
    "a plain '2 videos' card (no subscribe element) is not a close-enough match on its own",
  );
  assert.equal(
    pickStarterLayoutLabel(new Set()),
    null,
    "no starter cards at all — the Import fallback's cue",
  );
  console.log("OK: pickStarterLayoutLabel prefers 2 videos + 1 subscribe, falls back to 1 + 1, else null");
}

// --- runCycle: the explicit-enable gate (phase 4, 8 Oct 2026) ----------------------------------
{
  // config.studioAutomation is false by default (DEFAULTS, src/config.ts) and nothing above
  // turns it on — neither it nor an explicit enable is set, so this must no-op before ever
  // touching a browser (no Chrome/Xvfb exists in this test environment; if the gate let this
  // through, `start()` would throw or hang instead of resolving cleanly).
  assert.equal(config.studioAutomation, false, "precondition: the flag this test relies on being off");
  const result = await runCycle({});
  assert.deepEqual(
    result,
    {
      probe: "skipped",
      endScreensAdded: 0,
      endScreenPickerEmpty: 0,
      tcStarted: 0,
      tcChecked: 0,
      thumbnailTestsPlanned: 0,
      pinsAdded: 0,
      errors: [],
    },
    "neither --enable/STUDIO_WORKER=1 nor config.studioAutomation set",
  );
  console.log(
    "OK: runCycle no-ops without config.studioAutomation or an explicit enable, no browser touched",
  );
}

// --- renderTcThumbSet's own real command must put nothing but data on stdout (review fix, 8 Oct
// 2026): `npm run --silent tc-thumbs -- <id>` is `npm run build-overlay-css && tsx
// src/thumbnails/tcThumbs.ts`, and `renderTcThumbSet` (studioWorker.ts) `JSON.parse`s the whole
// of stdout. `build-overlay-css.mjs` used to `console.log` its own "written (N bytes)" status
// line — on stdout, ahead of tc-thumbs' own JSON, every single time — which made that parse
// throw on every real invocation; this never surfaced in a plain-terminal run because a human
// reads past an extra line a JSON parser cannot skip past. Spawning the exact nested command
// `tc-thumbs` runs first, rather than the full tc-thumbs pipeline (which needs a rendered match
// on disk and Remotion/ffmpeg), is the cheap way to pin that stdout carries nothing to confuse a
// JSON parser.
{
  const { spawnSync } = await import("node:child_process");
  const root = path.resolve(new URL("../..", import.meta.url).pathname);
  const result = spawnSync("npm", ["run", "--silent", "build-overlay-css"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `build-overlay-css failed: ${result.stderr}`);
  assert.equal(
    result.stdout.trim(),
    "",
    `build-overlay-css's own status line must go to stderr, not stdout a JSON-parsing caller reads: got ${JSON.stringify(result.stdout)}`,
  );
  console.log("OK: build-overlay-css's status line no longer leaks onto stdout");
}

/* --- a failed daily read is that day's check, and only a second day's failure asks for a human --- */
{
  await updateTcExperiments((tc) => [
    ...tc.filter((e) => e.id !== "tc-title-readfail"),
    {
      id: "tc-title-readfail",
      kind: "tc",
      status: "running",
      arms: [],
      videos: [{ matchId: 1, videoId: "readfailvid", arm: "live" }],
    } as unknown as Experiment,
  ]);
  await setExperimentReadFailed(
    "tc-title-readfail",
    "locator.waitFor: Timeout 15000ms exceeded.\nCall log: …",
  );
  let exp = (await readExperiments()).experiments.find((e) => e.id === "tc-title-readfail")!;
  const result = exp.result as { checkedAt?: string; readError?: string };
  assert.ok(result.checkedAt, "a failed read still counts as today's check");
  assert.equal(exp.needsHuman, undefined, "one failed read is not a human call");
  assert.equal(
    planCycle(
      new Date(),
      [],
      { endScreensDone: {} } as unknown as StudioLedger,
      (await readExperiments()).experiments,
    ).tcToCheck.some((e) => e.id === exp.id),
    false,
    "not re-read the same day",
  );
  await setExperimentReadFailed("tc-title-readfail", "locator.waitFor: Timeout 15000ms exceeded.");
  exp = (await readExperiments()).experiments.find((e) => e.id === "tc-title-readfail")!;
  assert.equal(exp.needsHuman, undefined, "two failures an evening apart are not two days running");
  await updateTcExperiments((tc) =>
    tc.map((e) =>
      e.id === "tc-title-readfail"
        ? {
            ...e,
            result: {
              ...(e.result as object),
              readErrorSince: new Date(Date.now() - 21 * 3600_000).toISOString(),
            },
          }
        : e,
    ),
  );
  await setExperimentReadFailed("tc-title-readfail", "locator.waitFor: Timeout 15000ms exceeded.");
  exp = (await readExperiments()).experiments.find((e) => e.id === "tc-title-readfail")!;
  assert.match(
    String(exp.needsHuman),
    /two days running: locator\.waitFor/,
    "failing 20 h+ asks, first line only",
  );
  console.log("OK: a failed A/B read is retried tomorrow, not every cycle; two in a row ask for a human");
}

console.log("studioWorker: all checks passed");
