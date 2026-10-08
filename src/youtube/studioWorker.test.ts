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
import { startTestAndCompare } from "./studioActions.js";
import type { Experiment } from "./studioExperiments.js";
import {
  inBlackoutWindow,
  markEndScreenDone,
  planCycle,
  playersFor,
  readHeartbeat,
  readLedger,
  testFor,
  writeHeartbeat,
  writeLedger,
  type LongFormRef,
  type StudioLedger,
} from "./studioWorker.js";

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
  const ledger: StudioLedger = { endScreens: { a: { at: "x", matchId: 1 } } };
  const plan = planCycle(new Date("2026-10-11T12:00:00.000Z"), longForms, ledger, []);
  const ids = plan.endScreenTargets.map((t) => t.videoId);
  assert.ok(!ids.includes("a"), "already in the ledger — must not be offered again");
  assert.ok(!ids.includes("d"), "old and private — neither condition holds");
  assert.ok(ids.includes("b"), "uploaded on/after the cutoff, even while private");
  assert.ok(ids.includes("c"), "old but public");
  assert.equal(plan.endScreenTargets.length, 3, `capped at 3 per cycle, got ${ids.join(",")}`);
  console.log("OK: end-screen candidates are ledger-filtered, cutoff-or-public, capped at 3");
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
  const plan = planCycle(now, [], { endScreens: {} }, experiments);
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

// --- inBlackoutWindow ------------------------------------------------------------------------
{
  assert.equal(inBlackoutWindow(new Date("2026-10-11T02:49:00.000Z")), false);
  assert.equal(inBlackoutWindow(new Date("2026-10-11T02:50:00.000Z")), true);
  assert.equal(inBlackoutWindow(new Date("2026-10-11T04:30:00.000Z")), true);
  assert.equal(inBlackoutWindow(new Date("2026-10-11T04:31:00.000Z")), false);
  console.log("OK: the 02:50-04:30 UTC blackout window's edges are inclusive/exclusive as expected");
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
  const ledger = await readLedger();
  assert.equal(ledger.endScreens.vidZ?.matchId, 99);
  const files = await readdir(media);
  assert.ok(!files.includes(".studio-ledger.json.tmp"), "no leftover .tmp after a write");
  assert.ok(existsSync(path.join(media, ".studio-ledger.json")));

  writeFileSync(path.join(media, ".studio-ledger.json"), "{not json");
  const recovered = await readLedger();
  assert.deepEqual(recovered, { endScreens: {} }, "a corrupt ledger degrades to empty, never throws");

  await writeHeartbeat({ pid: 123, at: "t", lastCycle: null, lastError: null });
  const hb = await readHeartbeat();
  assert.equal(hb?.pid, 123);
  console.log("OK: ledger and heartbeat round-trip atomically and a corrupt ledger degrades to empty");
}

console.log("studioWorker: all checks passed");
