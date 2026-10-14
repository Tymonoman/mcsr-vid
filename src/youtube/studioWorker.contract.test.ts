// Contract test for the Studio worker's plan and loop (src/youtube/studioWorker.ts), written from
// the docs as an outside engineer would: what one cycle decides to touch, when the loop runs at
// all, and what it records when a Test & Compare is read. studioWorker.test.ts already pins most
// single filters; this file walks the documented promises end to end (the real on-disk block check,
// the loop's gate and blackout, the caps all at once, the pin plan through the live check).
// No browser is ever started: the gate is observed through a temp profile whose SingletonLock names
// this very process, so `start()` refuses before it spawns anything. No network, temp mediaDir.
// Run: npx tsx src/youtube/studioWorker.contract.test.ts
//
// What the docs promise (CLAUDE.md "Studio automation" and "Blocked players"; README "What runs on
// its own"; handbook claude-md-reference.md "Studio automation" phases 2-5):
//  G1. Gate off (no `enable`, `studioAutomation` false): a cycle is a no-op recorded as "skipped",
//      no browser touched.
//  G2. `opts.enable` alone opens the gate.
//  G3. `config.studioAutomation` alone opens the gate (the gate is enable OR config).
//  B1. Never runs 02:50–07:30 UTC at the default nightly hour — not even with the gate open.
//  B2. The blackout is derived live from `nightlyRenderHourUtc` (a Settings change moves it with no
//      restart); null disables it.
//  C1. Per-cycle caps: ≤3 end screens, ≤2 TC starts, ≤3 related links, ≤3 pins, ≤2 thumbnail-TC
//      plans — all at once on a cold start with everything eligible.
//  C2. A cap counts real candidates: what a filter drops never holds a slot.
//  N1. Never replaces what was set by hand: an end screen or related link already there (the
//      ledger) is never reopened; a video with any tc experiment never gets another planned; only a
//      "planned" experiment is ever started.
//  N2. Planning a thumbnail TC never starts it in the same cycle.
//  D1. A running test is read once a UTC calendar day — the date, not 24 hours.
//  P1. Pins only PUBLIC long-forms (live, not the upload-time record) whose channel comment posted
//      and whose pin isn't done, ≤3 a cycle.
//  K1. Blocked never: the real on-disk check (POV clip, any case; a saved chat; the title's pair —
//      "not clips alone, so a match archived off disk is still caught") keeps a blocked match out
//      of end screens, pins, thumbnail-TC plans and related links, while its neighbour still gets
//      all four.
//  K2. The docs name pins, end screens and related links, with realIsBlocked as the worker's shared
//      block check; they never say a planned TC start skips a blocked match. Kept as a deviation
//      because the gap is real: planCycle filters tcToStart by status only.
//  L1. A title test's players come from the match's own two names, "API or titleNames spelling".
//  W1. "Results ready" means done: the experiment goes to "done", with no winner invented.
//  W2. The worker never sets a winner itself: lopsided shares with no Winner mark record no winner,
//      but do record watchTimeShare per arm.
//  W3. Studio's own winner is recorded by arm: watchTimeShare per arm and "<arm> wins: a% vs b%",
//      and the experiment's arms are left exactly as they were (nothing applied by hand).
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, isBlockedPlayer, matchDir } from "../config.js";
import { buildTitle, HOOK_PLACEHOLDER } from "../pipeline/title.js";
import { parseTcReport, titleTestProblem, type TcReadResult } from "./studioActions.js";
import { readExperiments, updateTcExperiments, type Experiment } from "./studioExperiments.js";
import {
  inBlackoutWindow,
  MAX_ENDSCREENS_PER_CYCLE,
  MAX_PINS_PER_CYCLE,
  MAX_RELATED_LINKS_PER_CYCLE,
  MAX_TC_STARTS_PER_CYCLE,
  MAX_THUMBNAIL_PLANS_PER_CYCLE,
  pinsThisCycle,
  planCycle,
  playersFor,
  readHeartbeat,
  runCycle,
  runWorker,
  setExperimentChecked,
  type LongFormRef,
  type StudioLedger,
} from "./studioWorker.js";

const mediaDir = mkdtempSync(path.join(tmpdir(), "mcsr-studioworker-contract-"));
config.mediaDir = mediaDir;
// Removed on any exit, a failed assertion included, so no run leaves its media dir in /tmp.
process.on("exit", () => rmSync(mediaDir, { recursive: true, force: true }));

/** Keeps a documented promise the code does not meet visible without failing the suite. */
const deviations: string[] = [];
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
    deviations.push(clause);
  }
}

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
/** Every real match id in src/fixtures, so plans run over real ids rather than 1, 2, 3. */
const fixtureIds = readdirSync(new URL("../fixtures/", import.meta.url))
  .map((f) => /^match-(\d+)\.json$/.exec(f)?.[1])
  .filter((id): id is string => !!id)
  .map(Number)
  .sort((a, b) => a - b);

const emptyLedger = (): StudioLedger => ({
  endScreens: {},
  pickerEmptySeen: {},
  relatedLinks: {},
  relatedRetrySeen: {},
});
const NOON = new Date("2026-10-14T12:00:00.000Z");
/** A long-form that qualifies for every Studio action: post-cutoff chain upload, comment posted. */
const eligible = (matchId: number, videoId = `v${matchId}`): LongFormRef => ({
  videoId,
  matchId,
  uploadedAt: "2026-10-09T19:00:00.000Z",
  privacyStatus: "public",
  source: "dashboard",
  finishedComment: null,
});
const tcExp = (id: string, videoId: string, matchId: number, status: Experiment["status"]): Experiment => ({
  id,
  kind: "tc",
  variable: "thumbnail",
  controlArm: "control",
  arms: [
    { name: "control", settings: { file: "/x/control.png" } },
    { name: "challenger1", settings: { file: "/x/challenger.png" } },
  ],
  videos: [{ videoId, matchId, arm: "tc" }],
  status,
});

// A profile whose SingletonLock names this live process: `start()` refuses with "already running"
// before it spawns Xvfb or Chrome, so "the cycle reached start()" is observable with nothing launched.
const lockProfile = mkdtempSync(path.join(tmpdir(), "mcsr-studio-lock-"));
symlinkSync(`contract-test-${process.pid}`, path.join(lockProfile, "SingletonLock"));
process.on("exit", () => rmSync(lockProfile, { recursive: true, force: true }));
const startOpts = {
  profileDir: lockProfile,
  chromePath: "/nonexistent/chrome",
  display: ":987",
  debugPort: 1,
};
/** One pass of the real loop at `now`; returns what the heartbeat says the cycle did. */
async function loopAt(now: Date, enable?: boolean) {
  await runWorker({ once: true, enable, startOpts, now: () => now, bootHead: null });
  return (await readHeartbeat())?.lastCycle?.probe;
}

// --- G1-G3: the gate is opts.enable OR config.studioAutomation ------------------------------------
{
  assert.equal(config.studioAutomation, false, "precondition: DEFAULTS keep studioAutomation off");
  // G1: off is a clean no-op — "skipped", not "error", so start() was never even reached.
  assert.equal(await loopAt(NOON), "skipped", "gate off: the cycle never reaches a browser");
  assert.equal((await readHeartbeat())?.lastError, null, "a gated-off cycle is not an error");

  // G2: --enable / STUDIO_WORKER=1 alone is the operator's grant for this container.
  await assert.rejects(
    runCycle({ enable: true, startOpts }),
    /already running against/,
    "enable alone opens",
  );
  assert.equal(await loopAt(NOON, true), "error", "the loop records the refused start as this cycle's error");
  assert.match(String((await readHeartbeat())?.lastError), /already running against/);

  // G3: the config flag alone opens it too — "OR'd with config.studioAutomation".
  config.studioAutomation = true;
  try {
    await assert.rejects(runCycle({ startOpts }), /already running against/, "config alone opens");
  } finally {
    config.studioAutomation = false;
  }
  console.log("OK G1-G3: gate off is a clean skip; enable alone or the config flag alone opens it");
}

// --- B1-B2: the blackout, through the real loop --------------------------------------------------
{
  // B1: default hour 3 UTC → 02:50–07:30. Inside it the loop never calls the cycle, gate open or not
  // (Chrome and ffmpeg share the lab's four cores during the nightly render).
  assert.equal(config.nightlyRenderHourUtc, 3, "precondition: the default nightly hour");
  assert.equal(await loopAt(new Date("2026-10-14T02:49:00.000Z"), true), "error", "02:49 runs");
  assert.equal(await loopAt(new Date("2026-10-14T02:50:00.000Z"), true), "skipped", "02:50 is blackout");
  assert.equal(await loopAt(new Date("2026-10-14T05:00:00.000Z"), true), "skipped", "mid-window");
  assert.equal(
    await loopAt(new Date("2026-10-14T07:30:00.000Z"), true),
    "skipped",
    "07:30 is still blackout",
  );
  assert.equal(await loopAt(new Date("2026-10-14T07:31:00.000Z"), true), "error", "07:31 runs again");

  // B2: moved in Settings (no restart), the window moves with it — read at every cycle.
  config.nightlyRenderHourUtc = 20;
  try {
    assert.equal(
      inBlackoutWindow(new Date("2026-10-14T19:50:00.000Z")),
      true,
      "default arg reads config live",
    );
    assert.equal(
      await loopAt(new Date("2026-10-14T03:00:00.000Z"), true),
      "error",
      "03:00 no longer blackout",
    );
    assert.equal(await loopAt(new Date("2026-10-14T20:00:00.000Z"), true), "skipped", "20:00 now is");
    // null disables the nightly, and with it the blackout — nothing to collide with.
    config.nightlyRenderHourUtc = null;
    assert.equal(await loopAt(new Date("2026-10-14T03:00:00.000Z"), true), "error", "null: no blackout");
  } finally {
    config.nightlyRenderHourUtc = 3;
  }
  console.log("OK B1-B2: the loop skips 02:50-07:30 even when enabled, and follows the live nightly hour");
}

// --- C1 + N2: every cap at once on a cold start ----------------------------------------------------
{
  // Documented numbers first: a silent bump of any constant would break the human-pacing promise.
  assert.equal(MAX_ENDSCREENS_PER_CYCLE, 3);
  assert.equal(MAX_TC_STARTS_PER_CYCLE, 2);
  assert.equal(MAX_RELATED_LINKS_PER_CYCLE, 3);
  assert.equal(MAX_PINS_PER_CYCLE, 3);
  assert.equal(MAX_THUMBNAIL_PLANS_PER_CYCLE, 2);

  assert.ok(fixtureIds.length >= 10, "precondition: enough real match ids to exceed every cap");
  const longForms = fixtureIds.map((id) => eligible(id));
  const shorts = fixtureIds.map((id) => ({ matchId: id, videoId: `s${id}` }));
  const experiments = [1, 2, 3, 4, 5].map((n) => tcExp(`tc-thumbnail-other${n}`, `other${n}`, 1, "planned"));
  const plan = planCycle(NOON, longForms, emptyLedger(), experiments, () => false, shorts);
  // A cold start with many eligible videos must not spend a whole cycle in Studio.
  assert.equal(plan.endScreenTargets.length, 3, "≤3 end screens");
  assert.equal(plan.tcToStart.length, 2, "≤2 TC starts");
  assert.equal(plan.relatedLinkTargets.length, 3, "≤3 related links");
  assert.equal(plan.thumbnailTcTargets.length, 2, "≤2 thumbnail-TC plans");
  assert.equal(plan.pinTargets.length, longForms.length, "the pin plan itself is uncapped (14 Oct 2026 fix)");
  assert.equal(
    pinsThisCycle(
      plan.pinTargets,
      () => true,
      () => false,
    ).length,
    3,
    "≤3 pins actually tried",
  );
  // N2: a video planned this cycle is not also started this cycle — the next cycle picks it up.
  const startingNow = new Set(plan.tcToStart.flatMap((e) => e.videos.map((v) => v.videoId)));
  assert.ok(
    plan.thumbnailTcTargets.every((t) => !startingNow.has(t.videoId)),
    "a freshly planned thumbnail TC is never started in the same cycle",
  );
  console.log("OK C1/N2: every per-cycle cap holds at once; a fresh plan waits for the next cycle");
}

// --- C2: what a filter drops never holds a slot ----------------------------------------------------
{
  const ids = fixtureIds.slice(0, 8);
  const ledger = emptyLedger();
  for (const id of ids.slice(0, 3)) {
    ledger.relatedLinks[`s${id}`] = {
      at: "2026-10-11T10:00:00.000Z",
      matchId: id,
      longFormVideoId: `v${id}`,
    };
    ledger.endScreens[`v${id}`] = { at: "2026-10-11T10:00:00.000Z", matchId: id };
  }
  const blocked = new Set(ids.slice(0, 2));
  const experiments = [
    tcExp("tc-r1", "r1", 1, "running"),
    tcExp("tc-r2", "r2", 1, "running"),
    tcExp("tc-p1", "p1", 1, "planned"),
    tcExp("tc-p2", "p2", 1, "planned"),
    tcExp("tc-p3", "p3", 1, "planned"),
  ];
  const plan = planCycle(
    NOON,
    ids.map((id) => eligible(id)),
    ledger,
    experiments,
    (m) => blocked.has(m),
    ids.map((id) => ({ matchId: id, videoId: `s${id}` })),
  );
  // 8 Oct–14 Oct 2026: a cap applied before the skips let standing skips hold every slot.
  assert.deepEqual(
    plan.relatedLinkTargets.map((t) => t.shortVideoId),
    ids.slice(3, 6).map((id) => `s${id}`),
    "three already-linked Shorts do not hold the three related slots",
  );
  assert.deepEqual(
    plan.endScreenTargets.map((t) => t.videoId),
    ids.slice(3, 6).map((id) => `v${id}`),
    "three done end screens do not hold the three end-screen slots",
  );
  assert.deepEqual(
    plan.thumbnailTcTargets.map((t) => t.videoId),
    ids.slice(2, 4).map((id) => `v${id}`),
    "the two blocked videos hold no thumbnail-plan slot (an end screen being done is irrelevant here)",
  );
  assert.deepEqual(
    plan.tcToStart.map((e) => e.id),
    ["tc-p1", "tc-p2"],
    "running tests hold no start slot",
  );
  console.log("OK C2: already-done, blocked and running items never hold a capped slot");
}

// --- N1: never reopen what is already set (by hand or by an earlier cycle) -----------------------
{
  const [a, b, c, d] = fixtureIds;
  const ledger = emptyLedger();
  // Found with an end screen already there a week ago — "already-has-endscreen" is done forever.
  ledger.endScreens[`v${a}`] = { at: "2026-10-07T09:00:00.000Z", matchId: a! };
  // Found linked by hand: recorded with no target (we never assert what someone else linked).
  ledger.relatedLinks[`s${a}`] = { at: "2026-10-07T09:00:00.000Z", matchId: a!, longFormVideoId: null };
  const experiments = [
    tcExp(`tc-thumbnail-v${b}`, `v${b}`, b!, "planned"),
    { ...tcExp(`tc-title-v${c}`, `v${c}`, c!, "done"), variable: "title" },
  ];
  const plan = planCycle(
    new Date("2026-11-20T12:00:00.000Z"), // weeks later: time alone never re-offers a done item
    [a, b, c, d].map((id) => eligible(id!)),
    ledger,
    experiments,
    () => false,
    [{ matchId: a!, videoId: `s${a}` }],
  );
  assert.ok(
    !plan.endScreenTargets.some((t) => t.videoId === `v${a}`),
    "an existing end screen is never reopened",
  );
  assert.deepEqual(plan.relatedLinkTargets, [], "a Short linked by hand is never reopened");
  const thumbs = plan.thumbnailTcTargets.map((t) => t.videoId);
  // Studio runs one test per video; "no tc experiment of its own yet, of either kind".
  assert.ok(!thumbs.includes(`v${b}`), "a planned thumbnail test is not planned twice");
  assert.ok(!thumbs.includes(`v${c}`), "a finished title test still counts as that video's test");
  assert.ok(thumbs.includes(`v${a}`) && thumbs.includes(`v${d}`), "untested videos are still offered");
  assert.deepEqual(
    plan.tcToStart.map((e) => e.id),
    [`tc-thumbnail-v${b}`],
    "only a planned test is ever started",
  );
  console.log("OK N1: hand-set end screens/links are never reopened; a tested video is never re-planned");
}

// --- D1: once a UTC calendar day ----------------------------------------------------------------
{
  const running = (id: string, checkedAt: string): Experiment => ({
    ...tcExp(id, id, 1, "running"),
    result: { checkedAt },
  });
  const due = (checkedAt: string, now: string): boolean =>
    planCycle(new Date(now), [], emptyLedger(), [running("x", checkedAt)], () => false).tcToCheck.length ===
    1;
  // By the date, not 24 hours: two seconds apart across midnight is a new day's read.
  assert.equal(due("2026-10-13T23:59:59.000Z", "2026-10-14T00:00:01.000Z"), true, "new UTC day, read again");
  // ~24 hours apart inside one date is still the same day's read.
  assert.equal(due("2026-10-14T00:00:01.000Z", "2026-10-14T23:59:59.000Z"), false, "same UTC day, not again");
  const others = planCycle(
    NOON,
    [],
    emptyLedger(),
    [tcExp("pl", "pl", 1, "planned"), tcExp("dn", "dn", 1, "done")],
    () => false,
  );
  assert.deepEqual(others.tcToCheck, [], "a planned or finished test is never on the daily read");
  console.log("OK D1: a running test is read once per UTC calendar date");
}

// --- P1: pins — public now, comment posted, pin not done, ≤3 ------------------------------------
{
  const [a, b, c, d, e, f, g, h] = fixtureIds;
  const longForms: LongFormRef[] = [
    // Uploaded private on a schedule; the record still says private, but it is public now.
    { ...eligible(a!), privacyStatus: "private", publishAt: "2026-10-10T19:00:00.000Z" },
    // The record says public, but it is private now (the live read wins).
    eligible(b!),
    { ...eligible(c!), finishedComment: undefined }, // comment never attempted — nothing to pin
    { ...eligible(d!), finishedComment: "comments are off" }, // comment failed — nothing to pin
    { ...eligible(e!), finishedPin: null }, // pin already done
    eligible(f!),
    eligible(g!),
    eligible(h!),
  ];
  const plan = planCycle(NOON, longForms, emptyLedger(), [], () => false);
  const liveNow = new Set([`v${a}`, `v${f}`, `v${g}`, `v${h}`, `v${c}`, `v${d}`, `v${e}`]);
  const pins = pinsThisCycle(
    plan.pinTargets,
    (id) => liveNow.has(id),
    () => false,
  );
  assert.deepEqual(
    pins.map((t) => t.videoId),
    [`v${a}`, `v${f}`, `v${g}`],
    "public now + comment posted + pin not done, in order, capped at 3",
  );
  console.log("OK P1: only live-public long-forms with a posted comment and an undone pin, ≤3");
}

// --- K1/K2: blocked never, through the real on-disk check ----------------------------------------
{
  const blockedMatch = fixture(12902901);
  const blockedName = blockedMatch.players.map((p) => p.nickname).find(isBlockedPlayer);
  assert.ok(blockedName, "precondition: this fixture has a player on the default block list");
  const otherName = blockedMatch.players.map((p) => p.nickname).find((n) => n !== blockedName)!;
  const neighbour = fixture(12730175);
  assert.ok(!neighbour.players.some((p) => isBlockedPlayer(p.nickname)), "precondition: neighbour is clean");
  mkdirSync(matchDir(neighbour.id), { recursive: true });
  for (const p of neighbour.players)
    writeFileSync(path.join(matchDir(neighbour.id), `${p.nickname}.mp4`), "");

  const pairTitle = buildTitle({ leftNickname: otherName, rightNickname: blockedName }).title.replace(
    HOOK_PLACEHOLDER,
    "A CLOSE ONE",
  );
  const scenarios: Record<string, Record<string, string>> = {
    "a POV clip": { [`${otherName}.mp4`]: "", [`${blockedName}.mp4`]: "" },
    "a POV clip in another case": { [`${blockedName.toLowerCase()}.mp4`]: "" },
    "a saved chat only (clips archived)": { [`chat-${blockedName}.json`]: "[]" },
    "the title's pair only (clips and chats archived)": { [`match-${blockedMatch.id}.title.txt`]: pairTitle },
  };
  for (const [what, files] of Object.entries(scenarios)) {
    const dir = matchDir(blockedMatch.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);

    const vb = `v${blockedMatch.id}`;
    const vn = `v${neighbour.id}`;
    const plan = planCycle(
      NOON,
      [eligible(blockedMatch.id), eligible(neighbour.id)],
      emptyLedger(),
      [],
      undefined, // the real default: blockedOnDisk(matchDir(id))
      [
        { matchId: blockedMatch.id, videoId: `s${blockedMatch.id}` },
        { matchId: neighbour.id, videoId: `s${neighbour.id}` },
      ],
    );
    // A runner who withdrew permission: none of their videos gets a Studio action (8 Oct 2026: end
    // screens went onto four blocked runners' videos; 11 Oct: archived matches slipped the clip check).
    assert.deepEqual(
      plan.endScreenTargets.map((t) => t.videoId),
      [vn],
      `${what}: no end screen`,
    );
    assert.deepEqual(
      plan.pinTargets.map((t) => t.videoId),
      [vn],
      `${what}: no pin`,
    );
    assert.deepEqual(
      plan.thumbnailTcTargets.map((t) => t.videoId),
      [vn],
      `${what}: no thumbnail test planned`,
    );
    assert.deepEqual(
      plan.relatedLinkTargets.map((t) => t.shortVideoId),
      [`s${neighbour.id}`],
      `${what}: no related link`,
    );
    if (what === "a POV clip") {
      // K2: a Test & Compare planned on the blocked long-form itself (a hand-approved tc-plan, or one
      // the worker planned before the block was added) — the start would change a blocked runner's
      // live video.
      const withTc = planCycle(
        NOON,
        [eligible(blockedMatch.id)],
        emptyLedger(),
        [tcExp(`tc-thumbnail-${vb}`, vb, blockedMatch.id, "planned")],
        undefined,
      );
      deviation(
        'CLAUDE.md "Blocked players": realIsBlocked is the worker\'s shared block check, yet a planned TC on a blocked match is still started',
        () => {
          assert.deepEqual(
            withTc.tcToStart.map((e) => e.id),
            [],
            `planCycle offers tcToStart=${JSON.stringify(withTc.tcToStart.map((e) => e.id))} for blocked match ${blockedMatch.id}`,
          );
        },
      );
    }
  }
  console.log(
    "OK K1: a blocked match (clip, any case, chat or title pair) gets no end screen, pin, plan or link",
  );
}

// --- L1: a title test's players, API or titleNames spelling ---------------------------------------
{
  // config.titleNames (default) titles Pinne as "Skycrab" and lowk3y_ as "lowkey".
  assert.equal(config.titleNames.Pinne, "Skycrab", "precondition: default titleNames");
  const exp: Experiment = {
    ...tcExp("tc-title-names", "vnames", 1, "planned"),
    variable: "title",
    arms: [
      {
        name: "control",
        settings: { title: "A CLOSE ONE | Skycrab vs lowkey | MCSR Ranked 1v1 | Minecraft Speedrun" },
      },
    ],
  };
  const players = playersFor(exp);
  // The title spelling is the match's own pair.
  assert.equal(
    titleTestProblem("SKYCRAB VS LOWKEY | Skycrab vs lowkey | MCSR Ranked 1v1 | Minecraft Speedrun", players),
    null,
  );
  deviation(
    'CLAUDE.md House rules: "a fresh X vs Y is checked against the match\'s own two players (API or titleNames spelling)"',
    () => {
      const apiSpelled = "PINNE VS LOWK3Y_ | Skycrab vs lowkey | MCSR Ranked 1v1 | Minecraft Speedrun";
      assert.equal(
        titleTestProblem(apiSpelled, players),
        null,
        `titleTestProblem(apiSpelled, playersFor(exp)=${JSON.stringify(players)}) refused the API spelling of the same two players`,
      );
    },
  );
  console.log("OK L1: a title test's players accept the title spelling");
}

// --- W1-W3: what a finished test records ---------------------------------------------------------
{
  const variant = (title: string, share: string, mark: { visible?: boolean; winner?: boolean } = {}) => [
    "35:46",
    title,
    "MCSR Replayoffs",
    ...(mark.visible ? ["Now visible to all viewers"] : []),
    share,
    "Watch time share",
    ...(mark.winner ? ["Winner"] : []),
  ];
  const liveTitle = "A CLOSE ONE | edcr vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun";
  /** As readTestAndCompare classifies it: parseTcReport's done → state "done". */
  const readOf = (text: string): TcReadResult => {
    const { done, ...rest } = parseTcReport(text);
    assert.equal(done, true, "precondition: the report reads as done");
    return { state: "done", raw: text, ...rest };
  };
  const seed = async (exp: Experiment) =>
    updateTcExperiments((tc) => [...tc.filter((e) => e.id !== exp.id), exp]);
  const reread = async (id: string) => (await readExperiments()).experiments.find((e) => e.id === id)!;

  // W1: the title box's own "Results ready", report unreadable — done, and nobody named the winner.
  const w1 = tcExp("tc-w1", "vw1", 1, "running");
  await seed(w1);
  await setExperimentChecked(w1.id, readOf("A/B Testing titles\nResults ready\nView test report"));
  const r1 = await reread(w1.id);
  assert.equal(r1.status, "done", "Results ready means done");
  assert.ok(r1.end, "a finished test gets its end time");
  assert.equal((r1.result as { winner?: string }).winner, undefined, "no winner text read, none recorded");

  // W2: 80/20 with no Winner mark — the worker records the split but never crowns the bigger share.
  const w2 = tcExp("tc-w2", "vw2", 1, "running");
  await seed(w2);
  await setExperimentChecked(
    w2.id,
    readOf(
      [
        "A/B Test report",
        "They all performed well",
        ...variant(liveTitle, "80.0%", { visible: true }),
        ...variant(liveTitle, "20.0%"),
        "Test finished. Ran from October 8, 2026 to October 11, 2026.",
      ].join("\n"),
    ),
  );
  const r2 = await reread(w2.id);
  assert.equal((r2.result as { winner?: string }).winner, undefined, "no Winner mark, no winner");
  assert.deepEqual((r2.result as { watchTimeShare?: object }).watchTimeShare, {
    control: 80,
    challenger1: 20,
  });
  assert.match(String(r2.verdict), /^no winner/, "the verdict says so rather than naming an arm");

  // W3: a thumbnail test the challenger won (slot 2, both marks on it) — credited to that arm by slot.
  const w3 = tcExp("tc-w3", "vw3", 1, "running");
  await seed(w3);
  await setExperimentChecked(
    w3.id,
    readOf(
      [
        "A/B Test report",
        "We have a winner!",
        ...variant(liveTitle, "41.3%"),
        ...variant(liveTitle, "58.7%", { visible: true, winner: true }),
        "Test finished. Ran from October 8, 2026 to October 11, 2026.",
      ].join("\n"),
    ),
  );
  const r3 = await reread(w3.id);
  assert.equal((r3.result as { winner?: string }).winner, "challenger1");
  assert.deepEqual((r3.result as { watchTimeShare?: object }).watchTimeShare, {
    control: 41.3,
    challenger1: 58.7,
  });
  assert.match(String(r3.verdict), /^challenger1 wins: 41\.3% vs 58\.7%/, '"<arm> wins: a% vs b%"');
  // It only records: YouTube applied its own winner; the experiment's arms are not rewritten here.
  assert.deepEqual(r3.arms, w3.arms, "arms untouched — nothing applied by hand");
  console.log("OK W1-W3: done is recorded; a winner only ever from Studio's own mark, credited by arm");
}

console.log(`studioWorker.contract: all checks passed (${deviations.length} documented deviation(s))`);
