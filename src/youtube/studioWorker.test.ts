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
import {
  parseTcReport,
  pickStarterLayoutLabel,
  startTestAndCompare,
  STARTER_LAYOUT_PREFERENCE,
  titleTestProblem,
} from "./studioActions.js";
import type { Experiment } from "./studioExperiments.js";
import {
  inBlackoutWindow,
  liveNightlyHour,
  markEndScreenDone,
  markPickerEmptySeen,
  MAX_PINS_PER_CYCLE,
  MAX_RELATED_LINKS_PER_CYCLE,
  newCodeWaiting,
  pinsThisCycle,
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

// --- readLedger / readHeartbeat: no file at all yet (before any write in this run) -------------
{
  assert.deepEqual(
    await readLedger(),
    { endScreens: {}, pickerEmptySeen: {}, relatedLinks: {}, relatedRetrySeen: {} },
    "a fresh mediaDir with no .studio-ledger.json reads as the empty default, not a throw",
  );
  assert.equal(
    await readHeartbeat(),
    null,
    "a fresh mediaDir with no .studio-worker.json reads as null, not a throw",
  );
  console.log("OK: readLedger/readHeartbeat default safely when neither file exists yet");
}

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
    relatedLinks: {},
    relatedRetrySeen: {},
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
  const yesterday: StudioLedger = {
    endScreens: {},
    pickerEmptySeen: { b: "2026-10-10T00:00:01.000Z" },
    relatedLinks: {},
    relatedRetrySeen: {},
  };
  const plan2 = planCycle(new Date("2026-10-11T12:00:00.000Z"), longForms, yesterday, []);
  assert.ok(
    plan2.endScreenTargets.map((t) => t.videoId).includes("b"),
    "a picker-empty from a previous UTC day is retried",
  );
  console.log("OK: a picker-empty candidate is retried on a later UTC day, not blocked forever");
}

// --- planCycle: end screens — a scheduled upload whose publish time has passed (14 Oct 2026) ---
// (the chain uploads private with a publishAt and the record's privacyStatus never changes, so 31
// pre-cutoff long-forms that had long gone public could never qualify.)
{
  const longForms: LongFormRef[] = [
    {
      videoId: "p",
      matchId: 1,
      uploadedAt: "2026-10-01T00:00:00.000Z",
      privacyStatus: "private",
      publishAt: "2026-10-08T23:00:00.000Z",
    },
    {
      videoId: "q",
      matchId: 2,
      uploadedAt: "2026-10-01T00:00:00.000Z",
      privacyStatus: "private",
      publishAt: "2026-10-20T19:00:00.000Z",
    },
    { videoId: "r", matchId: 3, uploadedAt: "2026-10-01T00:00:00.000Z", privacyStatus: "private", publishAt: null },
  ];
  const plan = planCycle(
    new Date("2026-10-14T12:00:00.000Z"),
    longForms,
    { endScreens: {}, pickerEmptySeen: {}, relatedLinks: {}, relatedRetrySeen: {} },
    [],
    () => false,
  );
  assert.deepEqual(
    plan.endScreenTargets.map((t) => t.videoId),
    ["p"],
    "publishAt passed counts as public; one still ahead, or none at all, does not",
  );
  console.log("OK: an old scheduled upload whose publish time has passed is an end-screen candidate");
}

// --- planCycle: a blocked runner's match never gets an end screen or a pin (14 Oct 2026) ------
// (8 Oct 2026: end screens went onto four blocked runners' videos; a comment posted before the
// block leaves `finishedComment` at null, so the pin plan reached them too.)
{
  const twin = (videoId: string, matchId: number): LongFormRef => ({
    videoId,
    matchId,
    uploadedAt: "2026-10-08T01:00:00.000Z",
    privacyStatus: "public",
    finishedComment: null,
  });
  const plan = planCycle(
    new Date("2026-10-14T12:00:00.000Z"),
    [twin("blk", 13), twin("ok", 14)],
    { endScreens: {}, pickerEmptySeen: {}, relatedLinks: {}, relatedRetrySeen: {} },
    [],
    (matchId) => matchId === 13,
  );
  assert.deepEqual(plan.endScreenTargets.map((t) => t.videoId), ["ok"], "blocked: no end screen");
  assert.deepEqual(plan.pinTargets.map((t) => t.videoId), ["ok"], "blocked: no pin");
  console.log("OK: a blocked runner's match is in neither endScreenTargets nor pinTargets");
}

// --- planCycle: related-video link targets (11 Oct 2026) --------------------------------------
{
  const longForms: LongFormRef[] = [
    { videoId: "lf1", matchId: 1, uploadedAt: "2026-10-07T01:00:00.000Z", privacyStatus: "private" },
    { videoId: "lf2", matchId: 2, uploadedAt: "2026-10-07T01:00:00.000Z", privacyStatus: "public" },
    { videoId: "lf3", matchId: 3, uploadedAt: "2026-10-07T01:00:00.000Z", privacyStatus: "private" },
    { videoId: "lf4", matchId: 4, uploadedAt: "2026-10-07T01:00:00.000Z", privacyStatus: "private" },
    { videoId: "lf5", matchId: 5, uploadedAt: "2026-10-07T01:00:00.000Z", privacyStatus: "private" },
  ];
  const shorts = [
    { matchId: 1, videoId: "s1" }, // already linked — never reopened
    { matchId: 2, videoId: "s2" }, // picker-empty/not-found seen today — retried tomorrow
    { matchId: 3, videoId: "s3" }, // seen yesterday — offered again
    { matchId: 4, videoId: "s4" }, // blocked player's match — never a target
    { matchId: 5, videoId: "s5" }, // a plain candidate, long-form still private — no privacy filter
    { matchId: 6, videoId: "s6" }, // no long-form recorded for match 6 yet
  ];
  const now = new Date("2026-10-11T12:00:00.000Z");
  const ledger: StudioLedger = {
    endScreens: {},
    pickerEmptySeen: {},
    relatedLinks: { s1: { at: "x", matchId: 1, longFormVideoId: "lf1" } },
    relatedRetrySeen: { s2: "2026-10-11T00:00:01.000Z", s3: "2026-10-10T00:00:01.000Z" },
  };
  const isBlocked = (matchId: number): boolean => matchId === 4;
  const plan = planCycle(now, longForms, ledger, [], isBlocked, shorts);
  const ids = plan.relatedLinkTargets.map((t) => t.shortVideoId);
  assert.ok(!ids.includes("s1"), "already linked — never reopened");
  assert.ok(!ids.includes("s2"), "seen today — retried tomorrow, not this cycle");
  assert.ok(ids.includes("s3"), "seen on an earlier UTC day — offered again");
  assert.ok(!ids.includes("s4"), "blocked player's match — never a target");
  assert.ok(ids.includes("s5"), "a plain candidate, offered despite its long-form still being private");
  assert.ok(!ids.includes("s6"), "no long-form recorded for this match yet");
  const s5 = plan.relatedLinkTargets.find((t) => t.shortVideoId === "s5");
  assert.equal(s5?.longFormVideoId, "lf5", "paired with its own match's long-form, not any other's");
  console.log(
    "OK: related-link candidates are ledger-filtered, long-form-paired, blocked-excluded, no privacy filter",
  );

  const manyShorts = [1, 2, 3, 4, 5].map((n) => ({ matchId: n, videoId: `m${n}` }));
  const manyLongForms: LongFormRef[] = [1, 2, 3, 4, 5].map((n) => ({
    videoId: `lf${n}`,
    matchId: n,
    uploadedAt: "2026-10-07T01:00:00.000Z",
    privacyStatus: "private",
  }));
  const capped = planCycle(
    now,
    manyLongForms,
    { endScreens: {}, pickerEmptySeen: {}, relatedLinks: {}, relatedRetrySeen: {} },
    [],
    () => false,
    manyShorts,
  );
  assert.equal(capped.relatedLinkTargets.length, MAX_RELATED_LINKS_PER_CYCLE, "capped per cycle");
  console.log(`OK: related-link targets capped at ${MAX_RELATED_LINKS_PER_CYCLE} a cycle`);
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
  const plan = planCycle(
    now,
    [],
    { endScreens: {}, pickerEmptySeen: {}, relatedLinks: {}, relatedRetrySeen: {} },
    experiments,
  );
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
{
  // The worker's own process booted on one hour; Settings (another process) moved it in the file.
  // runWorker reads the file every cycle, so the blackout follows the live hour, not the boot one.
  const file = path.join(mkdtempSync(path.join(tmpdir(), "studio-hour-")), "mcsr-vid.config.json");
  writeFileSync(file, JSON.stringify({ nightlyRenderHourUtc: 20 }));
  assert.equal(liveNightlyHour(file), 20);
  assert.equal(inBlackoutWindow(new Date("2026-10-11T20:30:00.000Z"), liveNightlyHour(file)), true);
  writeFileSync(file, JSON.stringify({ nightlyRenderHourUtc: null }));
  assert.equal(liveNightlyHour(file), null, "null: the nightly is off, and so is the blackout");
  writeFileSync(file, "{}");
  assert.equal(liveNightlyHour(file), 3, "no key: the default");
  assert.equal(liveNightlyHour(path.join(path.dirname(file), "missing.json")), 3, "no file: the default");
  writeFileSync(file, '{"nightlyRenderHourUtc": 2');
  assert.equal(liveNightlyHour(file), config.nightlyRenderHourUtc, "mid-write: the boot hour");
  writeFileSync(file, JSON.stringify({ nightlyRenderHourUtc: 25 }));
  assert.equal(liveNightlyHour(file), config.nightlyRenderHourUtc, "off the clock: the boot hour");
  console.log("OK: the worker's blackout reads the nightly hour live from the config file");
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

// --- testFor / playersFor: edge cases with no usable arms at all --------------------------------
{
  // Thumbnail: only the control arm has a usable file (one left after filtering) — below the
  // 2-file floor `testFor` itself enforces, same as `planTcExperiments` does at plan time.
  const oneFileThumb: Experiment = {
    id: "tc-thumbnail-lonely",
    kind: "tc",
    variable: "thumbnail",
    controlArm: "control",
    arms: [
      { name: "control", settings: { file: "/a/control.png" } },
      { name: "challenger1", settings: {} }, // no file at all
    ],
    videos: [{ videoId: "z", matchId: 1, arm: "tc" }],
    status: "planned",
  };
  assert.equal(testFor(oneFileThumb), null, "fewer than 2 usable thumbnail files — no test");

  // Title: every non-control arm lacks a title — no challenger to offer.
  const noChallengerTitle: Experiment = {
    id: "tc-title-lonely",
    kind: "tc",
    variable: "title",
    controlArm: "control",
    arms: [{ name: "control", settings: { title: "LIVE | edcr vs doogile" } }, { name: "challenger1" }],
    videos: [{ videoId: "w", matchId: 1, arm: "tc" }],
    status: "planned",
  };
  assert.equal(testFor(noChallengerTitle), null, "no arm but control carries a title — no test");

  // playersFor: no arm matches controlArm's name at all — nothing to split, so no players named.
  const noControlArm: Experiment = { ...noChallengerTitle, controlArm: "missing" };
  assert.deepEqual(playersFor(noControlArm), [], "control arm not found — names nobody");
  console.log(
    "OK: testFor returns null with no usable challenger, playersFor returns [] with no control arm",
  );
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

  // Read per segment, a question hook keeps its exemption: the whole line ends in "Minecraft
  // Speedrun", and read whole it refused the pipeline's own chip (14 Oct 2026 edge run). "Who
  // takes it?" stays refused — on purpose, by `hookProblem`'s own word list.
  const line = (hook: string) => `${hook} | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun`;
  assert.equal(titleTestProblem(line("Can a 45-second lead survive?"), players), null);
  assert.equal(titleTestProblem(line("DOOGILE WINS IT"), players), "it gives the result away");
  assert.notEqual(titleTestProblem(line("Who takes it?"), players), null);
  // The finishing-verb words spoilsTheResult gained the same day keep the question exemption too.
  for (const q of ["THE UPSET NOBODY SAW COMING?", "CAN EDCR CLOSE IT OUT?", "WHO TAKES GAME 3?"])
    assert.equal(titleTestProblem(line(q), players), null, q);
  assert.equal(titleTestProblem(line("EDCR CLOSES IT OUT"), players), "it gives the result away");

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
    { endScreens: {}, pickerEmptySeen: {}, relatedLinks: {}, relatedRetrySeen: {} },
    "a corrupt ledger degrades to empty, never throws",
  );

  await writeHeartbeat({ pid: 123, at: "t", lastCycle: null, lastError: "a", lastErrors: ["a", "b"] });
  const hb = await readHeartbeat();
  assert.equal(hb?.pid, 123);
  assert.deepEqual(hb?.lastErrors, ["a", "b"], "every error of the cycle, not just the first");

  writeFileSync(path.join(media, ".studio-worker.json"), "{not json either");
  assert.equal(await readHeartbeat(), null, "a corrupt heartbeat degrades to null, never throws");
  console.log("OK: ledger and heartbeat round-trip atomically and a corrupt file degrades safely");
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
  const plan = planCycle(
    now,
    longForms,
    { endScreens: {}, pickerEmptySeen: {}, relatedLinks: {}, relatedRetrySeen: {} },
    experiments,
    isBlocked,
  );
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
    // Two more fresh candidates: the plan itself is uncapped (`pinsThisCycle` caps).
    { videoId: "f", matchId: 7, uploadedAt: "x", privacyStatus: "public", finishedComment: null },
    { videoId: "g", matchId: 8, uploadedAt: "x", privacyStatus: "public", finishedComment: null },
  ];
  const plan = planCycle(
    new Date("2026-10-11T12:00:00.000Z"),
    longForms,
    { endScreens: {}, pickerEmptySeen: {}, relatedLinks: {}, relatedRetrySeen: {} },
    [],
  );
  const ids = plan.pinTargets.map((t) => t.videoId);
  assert.ok(ids.includes("a") && ids.includes("b"), "comment posted, pin never done or previously failed");
  assert.ok(!ids.includes("c"), "pin already done — never offered again");
  assert.ok(!ids.includes("d"), "comment never attempted — nothing to pin");
  assert.ok(!ids.includes("e"), "comment attempt itself failed — nothing to pin");
  assert.equal(ids.filter((id) => id === "a").length, 1, "a series copy of the same video is de-duped");
  assert.deepEqual(ids, ["a", "b", "f", "g"], "every candidate — the cap comes after runCycle's skips");
  console.log(
    "OK: pinTargets is comment-posted/pin-not-done, de-duped by videoId across series copies, uncapped",
  );
}

// --- pinsThisCycle: the cap comes after the day's skips and the live check (14 Oct 2026) ------
// (8–14 Oct 2026: the plan was capped first, so one private and two "no-channel-comment" videos
// held all three slots every cycle and no pin was ever tried past them.)
{
  const targets: LongFormRef[] = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map((videoId, i) => ({
    videoId,
    matchId: i + 1,
    uploadedAt: "x",
    privacyStatus: "private",
    finishedComment: null,
  }));
  const pins = pinsThisCycle(
    targets,
    (id) => id !== "s2", // live private
    (id) => id === "s1" || id === "s3", // skipped earlier today
  );
  assert.deepEqual(
    pins.map((t) => t.videoId),
    ["s4", "s5", "s6"],
    `skips come first, then at most ${MAX_PINS_PER_CYCLE}`,
  );
  console.log(`OK: pinsThisCycle skips today's skips and non-public videos, then caps at ${MAX_PINS_PER_CYCLE}`);
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
    { endScreens: {}, pickerEmptySeen: {}, relatedLinks: {}, relatedRetrySeen: {} },
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

// --- setExperimentChecked: a running test that reads back as a blank form asks a human (14 Oct) ---
// (a Save that never landed still returned "started"; every daily read then saw the blank form and
// rewrote "running" forever, with nothing in the report saying so.)
{
  const expId = "tc-thumbnail-blank-test";
  await updateTcExperiments((tc) => [
    ...tc,
    {
      id: expId,
      kind: "tc",
      variable: "thumbnail",
      arms: [{ name: "control" }],
      videos: [{ videoId: "vidBlank", matchId: 1, arm: "tc" }],
      status: "running",
      start: "2026-10-10T08:00:00.000Z",
    },
  ]);
  await setExperimentChecked(expId, { state: "none", raw: "Set up a new test" });
  const exp = (await readExperiments()).experiments.find((e) => e.id === expId);
  assert.equal(exp?.status, "running", "status kept — never re-planned or restarted on its own");
  assert.equal(exp?.start, "2026-10-10T08:00:00.000Z");
  assert.match(String(exp?.needsHuman), /no A\/B test/, "flagged for the operator");
  assert.ok((exp?.result as { checkedAt?: string }).checkedAt, "today's check is recorded");
  console.log("OK: a running test read back as a blank form keeps its status and gets needsHuman");
}

// --- parseTcReport + setExperimentChecked on a finished test (11 Oct 2026) ----------------------
// The real report text of the first finished test (_2EOkOOX0PQ, the Grand Finals title test): the
// first build looked for "winner" in the title box, which says "Results ready", and never saw it end.
{
  const GF = [
    "Title only",
    "A/B Test report",
    "We have a winner!",
    "35:46",
    "IT ALL COMES DOWN TO THE END | lowkey vs Infume | MCSR Ranked Season 11 Playoffs | Grand Finals",
    "MCSR Replayoffs",
    "Now visible to all viewers",
    "62.1%",
    "Watch time share",
    "Winner",
    "35:46",
    "A SUB-9 TO WIN IT | lowkey vs Infume | MCSR Ranked Season 11 Playoffs | Grand Finals",
    "MCSR Replayoffs",
    "37.9%",
    "Watch time share",
    "Set this option",
    "Test finished. Ran from October 8, 2026 at 11:00 PM to October 11, 2026 at 11:31 AM.",
    "New test",
    "Done",
  ].join("\n");
  const r = parseTcReport(GF);
  assert.equal(r.done, true);
  assert.deepEqual(r.shares, [62.1, 37.9]);
  assert.equal(r.winnerSlot, 1);
  assert.match(r.titles?.[1] ?? "", /^A SUB-9 TO WIN IT/);
  assert.equal(parseTcReport("A/B Testing titles\nResults ready\nView test report").done, true);
  assert.equal(parseTcReport("A/B Testing titles\nRunning…\nView test report").done, false);
  assert.equal(parseTcReport("A/B Test report\nTest running…\n29.2%\nWatch time share").done, false);
  // The two winner marks disagreeing (a layout never seen) gives no winner rather than a wrong one.
  assert.equal(
    parseTcReport(
      GF.replace("Now visible to all viewers\n62.1%", "62.1%").replace(
        "37.9%",
        "Now visible to all viewers\n37.9%",
      ),
    ).winnerSlot,
    undefined,
  );

  const expId = "tc-title-gf-shape";
  await updateTcExperiments((tc) => [
    ...tc,
    {
      id: expId,
      kind: "tc",
      variable: "title",
      // Arms deliberately in the opposite order to the report: the titles must name the arm.
      arms: [
        { name: "challenger1", settings: { title: r.titles![1] } },
        { name: "control", settings: { title: r.titles![0] } },
      ],
      videos: [{ videoId: "vidGF", matchId: 1, arm: "tc" }],
      status: "running",
    },
  ]);
  await setExperimentChecked(expId, { state: "done", raw: GF, ...r });
  const done = (await readExperiments()).experiments.find((e) => e.id === expId);
  assert.equal(done?.status, "done");
  assert.deepEqual((done?.result as { watchTimeShare?: object }).watchTimeShare, {
    control: 62.1,
    challenger1: 37.9,
  });
  assert.equal((done?.result as { winner?: string }).winner, "control");
  assert.equal(done?.verdict, "control wins: 62.1% vs 37.9% watch time share");

  // No winner (358mpZeBqFo, 11 Oct 2026): the live title stays live and is marked "Now visible",
  // but Studio's headline says no one won. That is not a control win.
  const TIE = [
    "Title only",
    "A/B Test report",
    "They all performed well",
    "10:09",
    "DECIDED BY 4.2 SECONDS | hackingnoises vs romuxii | MCSR Ranked 1v1 | Minecraft Speedrun",
    "MCSR Replayoffs",
    "Now visible to all viewers",
    "50.1%",
    "Watch time share",
    "10:09",
    "A SUB-10 TO WIN IT | hackingnoises vs romuxii | MCSR Ranked 1v1 | Minecraft Speedrun",
    "MCSR Replayoffs",
    "49.9%",
    "Watch time share",
    "Set this option",
    "Test finished. Ran from October 8, 2026 at 11:11 AM to October 11, 2026 at 6:52 PM.",
    "New test",
    "Done",
  ].join("\n");
  const tie = parseTcReport(TIE);
  assert.equal(tie.done, true);
  assert.deepEqual(tie.shares, [50.1, 49.9]);
  assert.equal(tie.winnerSlot, undefined, "Now visible alone is not a win");
  assert.equal(tie.headline, "They all performed well");
  assert.equal(r.headline, "We have a winner!");
  const tieId = "tc-title-tie-shape";
  await updateTcExperiments((tc) => [
    ...tc,
    {
      id: tieId,
      kind: "tc",
      variable: "title",
      arms: [{ name: "control" }, { name: "challenger1" }],
      videos: [{ videoId: "vidTie", matchId: 2, arm: "tc" }],
      status: "running",
    },
  ]);
  await setExperimentChecked(tieId, { state: "done", raw: TIE, ...tie });
  const tied = (await readExperiments()).experiments.find((e) => e.id === tieId);
  assert.equal(
    tied?.verdict,
    'no winner (Studio: "They all performed well"): 50.1% vs 49.9% watch time share',
  );
  assert.equal((tied?.result as { winner?: string }).winner, undefined);
  console.log("OK: a finished test's report is read for its shares and its winning arm, by title");
}

// --- setExperimentChecked: a "planned" experiment read as already "done" (never seen running) --
// (the `tcToStart` loop's own reconcile branch skips straight from `readTestAndCompare` to this
// function without ever calling setExperimentRunning first — a test that both started and
// finished between cycles, or was never caught mid-run).
{
  const expId2 = "tc-title-skip-to-done";
  await updateTcExperiments((tc) => [
    ...tc,
    {
      id: expId2,
      kind: "tc",
      variable: "title",
      arms: [{ name: "control" }],
      videos: [{ videoId: "vidSkip", matchId: 2, arm: "tc" }],
      status: "planned",
    },
  ]);
  await setExperimentChecked(expId2, { state: "done", winner: "Title B", raw: "Winner: Title B" });
  const afterSkip = (await readExperiments()).experiments.find((e) => e.id === expId2);
  assert.equal(afterSkip?.status, "done", "planned promotes straight to done when that's what Studio shows");
  assert.equal(afterSkip?.start, undefined, "the done branch never backfills a start it never saw");
  assert.match(afterSkip?.verdict ?? "", /Title B/);
  console.log("OK: setExperimentChecked can promote planned straight to done, with no start ever recorded");
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
      relatedLinksAdded: 0,
      errors: [],
    },
    "neither --enable/STUDIO_WORKER=1 nor config.studioAutomation set",
  );
  console.log(
    "OK: runCycle no-ops without config.studioAutomation or an explicit enable, no browser touched",
  );
}

// --- runWorker: one `--once` pass through the real loop, gate still off -----------------------
// (nothing above calls `runWorker` directly — only its inner `runCycle` — so the loop's own
// heartbeat-writing side effect, and that `--once` actually returns instead of looping forever,
// were both unpinned.)
{
  await runWorker({ once: true, enable: false });
  const hb = await readHeartbeat();
  assert.equal(hb?.pid, process.pid, "the loop's own heartbeat names this process");
  assert.equal(hb?.lastCycle?.probe, "skipped", "gate still off — this cycle did nothing");
  assert.equal(hb?.lastError, null, "a clean skip is not an error");
  assert.equal(hb?.sameErrorStreak, 0, "no error this cycle — no streak");
  console.log("OK: runWorker({ once: true }) runs exactly one cycle, writes the heartbeat, and returns");
}

// --- runWorker: each real cycle re-reads the blocklist the Settings tab saves ------------------
// This process outlives a Settings save, so a runner blocked there after it started stayed open to
// end screens, pins, tests and links until the next restart.
{
  const saved = config.blockedPlayers;
  config.blockedPlayers = ["stale-list-sentinel"];
  await runWorker({ once: true, enable: false, now: () => new Date("2026-10-11T12:00:00Z") });
  assert.ok(!config.blockedPlayers.includes("stale-list-sentinel"), "the cycle ran on the file's list");
  config.blockedPlayers = saved;
  console.log("OK: runWorker reloads blockedPlayers before every cycle outside the blackout");
}

// --- runWorker: a blackout cycle keeps the standing error and its streak (14 Oct 2026) ---------
// The 07:00 Warsaw report (05:00/06:00 UTC) always lands inside the 02:50–07:30 UTC blackout, so
// resetting the streak there meant "the same error 3 cycles running" never reached it.
{
  await writeHeartbeat({
    pid: 1,
    at: "t0",
    lastCycle: null,
    lastError: "x",
    lastErrors: ["x"],
    sameErrorStreak: 3,
  });
  const h = "abc1234";
  await runWorker({ once: true, now: () => new Date("2026-10-11T05:00:00Z"), bootHead: h, headNow: () => h });
  const hb = await readHeartbeat();
  assert.equal(hb?.lastCycle?.probe, "skipped", "the blackout cycle is still recorded as skipped");
  assert.notEqual(hb?.at, "t0", "the heartbeat itself is refreshed, so the staleness check stays quiet");
  assert.equal(hb?.lastError, "x", "the last real cycle's error is carried through the blackout");
  assert.deepEqual(hb?.lastErrors, ["x"]);
  assert.equal(hb?.sameErrorStreak, 3, "the streak neither resets nor grows on a cycle that never ran");
  console.log("OK: runWorker carries lastError and sameErrorStreak through a blackout cycle unchanged");
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
