// Contract test for `.experiments.json`'s shared-file rules on the Studio side
// (src/youtube/studioExperiments.ts) and where they meet the dashboard's experiment engine — written
// from the docs, not the code. No browser, no network.
// Run: npx tsx src/youtube/studioExperiments.contract.test.ts
//
// What the docs promise (CLAUDE.md "Studio automation" lockfile bullet and the experiment engine
// bullet; handbook/claude-md-reference.md, the `withExperimentsLock` paragraph and "Phase 4"):
//
//  1. The tc read-merge-write is serialized through a lockfile (`.experiments.json.lock`): a lock
//     younger than 30 s belongs to a live holder and is waited on, never broken.
//  2. A lock older than 30 s is a crashed holder's leftover and is broken.
//  3. The lock is released however the critical section ends — a throwing mutate does not wedge the
//     next writer, and writes nothing.
//  4. A corrupt file is never read as "no experiments" by this side: the tc write refuses, leaving
//     the file byte for byte, and still releases the lock.
//  5. The dashboard's own experiments.ts does NOT take this lock (a known, documented gap: "a race
//     there is still possible") — pinned so closing the gap updates the docs too.
//  6. End to end across both writers: a tc import between two render ticks on the same night never
//     makes the night's render arm apply twice (appliedOn survives), the evaluator leaves the tc
//     entries byte for byte, and a later tc import keeps the evaluator's evaluatedOn.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Experiment as TcExperiment } from "./studioExperiments.js";

// CONFIG_PATH is resolved once, at config.js's first import, from cwd: the render tick in check 6
// writes Settings through saveSettings, so this test owns a temp cwd and its config file.
const cwdDir = mkdtempSync(path.join(tmpdir(), "mcsr-studioc-cwd-"));
const media = mkdtempSync(path.join(tmpdir(), "mcsr-studioc-media-"));
process.chdir(cwdDir);
delete process.env.MCSR_CONFIG;
writeFileSync(path.join(cwdDir, "mcsr-vid.config.json"), JSON.stringify({ mediaDir: media }, null, 2));

const { config } = await import("../config.js");
const { importTcPlan, readExperiments, updateTcExperiments, writeExperiments } =
  await import("./studioExperiments.js");
const dashboard = await import("../dashboard/experiments.js");
const { evaluateExperiments } = await import("../dashboard/experimentsEvaluator.js");

const file = path.join(media, ".experiments.json");
const lock = `${file}.lock`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tcOf = (id: string): TcExperiment => ({
  id,
  kind: "tc",
  arms: [{ name: "control" }],
  videos: [],
  status: "planned",
});
const ageLock = (seconds: number): void => {
  writeFileSync(lock, "");
  const then = new Date(Date.now() - seconds * 1000);
  utimesSync(lock, then, then);
};
const idsOnDisk = (): string[] =>
  (JSON.parse(readFileSync(file, "utf8")) as { experiments: { id: string }[] }).experiments.map((e) => e.id);

// --- 1. A 25-second-old lock is a live holder: waited on, never broken -------------------------------
{
  await writeExperiments({ experiments: [], schedule: [] });
  ageLock(25);
  let finished = false;
  const pending = updateTcExperiments((tc) => [...tc, tcOf("waited")]).then(() => {
    finished = true;
  });
  await sleep(300);
  // Breaking a live holder's lock is exactly the lost-update the lock exists to prevent.
  assert.equal(finished, false, "the write waits while the holder is inside its critical section");
  assert.ok(existsSync(lock), "the holder's lock is not broken");
  assert.deepEqual(idsOnDisk(), [], "nothing written yet");
  unlinkSync(lock); // the holder finishes
  await pending;
  assert.deepEqual(idsOnDisk(), ["waited"], "and lands once the holder lets go");
}

// --- 2. Stale after 30 s: a 31-second-old lock is broken -------------------------------------------
{
  ageLock(31);
  const started = Date.now();
  await updateTcExperiments((tc) => [...tc, tcOf("after-stale")]);
  assert.ok(Date.now() - started < 2000, "broken at once, not after the 10 s wait");
  assert.ok(idsOnDisk().includes("after-stale"));
  assert.ok(!existsSync(lock), "and released again afterwards");
}

// --- 3. A throwing mutate releases the lock and writes nothing ---------------------------------------
{
  const before = readFileSync(file, "utf8");
  await assert.rejects(
    () =>
      updateTcExperiments(() => {
        throw new Error("plan rejected mid-merge");
      }),
    /plan rejected mid-merge/,
  );
  assert.equal(readFileSync(file, "utf8"), before, "nothing half-written");
  assert.ok(!existsSync(lock), "the lock is released on the error path too");
  const started = Date.now();
  await updateTcExperiments((tc) => tc);
  assert.ok(Date.now() - started < 1000, "the next writer is not wedged for 30 s behind a dead lock");
}

// --- 4. A corrupt file: the tc write refuses, leaves it, releases the lock ----------------------------
{
  const corrupt = '{ "experiments": [ { "id": "x2", "kind": "between", }, ], ';
  writeFileSync(file, corrupt);
  await assert.rejects(() => updateTcExperiments((tc) => [...tc, tcOf("never")]), /did not parse as JSON/);
  // Reading corrupt as "no experiments" would plan every tc test again and drop every between one.
  assert.equal(readFileSync(file, "utf8"), corrupt, "left byte for byte for a human to fix");
  assert.ok(!existsSync(lock), "and the lock is not left behind");
}

// --- 5. The documented gap: the dashboard's writer does not take this lock ----------------------------
{
  dashboard.writeExperiments({
    experiments: [],
    schedule: [{ date: "2026-10-20", experimentId: "x", arm: "a", render: {} }],
  });
  ageLock(1); // a Studio worker cycle is mid-write
  config.nightlyRenderHourUtc = 3;
  dashboard.applyScheduledRenderArm(Date.parse("2026-10-20T02:45:00Z"));
  // CLAUDE.md: "The dashboard's own src/dashboard/experiments.ts doesn't take this lock, so a race
  // there is still possible." If this starts failing, the gap was closed — update CLAUDE.md with it.
  assert.equal(
    dashboard.readExperiments().appliedOn,
    "2026-10-20",
    "the dashboard wrote straight through the held lock",
  );
  unlinkSync(lock);
}

// --- 6. End to end: render tick, tc import, render tick, evaluator, tc import ----------------------------
{
  const between = {
    id: "x3-countdown-teaser",
    kind: "between" as const,
    hypothesis: "the COMING UP line holds viewers past the countdown",
    variable: "countdownTeaser",
    metric: "average view %",
    controlArm: "off",
    arms: [
      { name: "off", settings: { countdownTeaser: false } },
      { name: "on", settings: { countdownTeaser: true } },
    ],
    videos: [],
    start: "2026-10-13",
    end: "2026-10-30",
    status: "running" as const,
  };
  dashboard.writeExperiments({
    baseline: { countdownTeaser: false },
    experiments: [between],
    schedule: [
      {
        date: "2026-10-21",
        experimentId: "x3-countdown-teaser",
        arm: "on",
        render: { countdownTeaser: true },
      },
    ],
  });
  config.countdownTeaser = false;
  dashboard.applyScheduledRenderArm(Date.parse("2026-10-21T02:35:00Z"));
  assert.equal(config.countdownTeaser, true, "tonight's arm applied");

  // A Studio worker cycle plans a thumbnail test in between (real match id, src/fixtures).
  const dir = path.join(media, "13766294", "tc");
  mkdirSync(dir, { recursive: true });
  const plan = {
    thumbnails: [
      {
        matchId: 13766294,
        videoId: "vidRunback",
        variants: [`${dir}/tc-control.png`, `${dir}/tc-pose.png`],
        approved: true,
      },
    ],
  };
  const first = await importTcPlan(plan);
  assert.equal(first.added.length, 1);

  // The operator flips it back by hand; the next 15-minute tick the same night must not re-apply.
  config.countdownTeaser = false;
  dashboard.applyScheduledRenderArm(Date.parse("2026-10-21T02:50:00Z"));
  assert.equal(
    config.countdownTeaser,
    false,
    "appliedOn survived the tc write: the night's arm is not applied twice",
  );

  const tcBefore = (await readExperiments()).experiments.find((e) => e.kind === "tc");
  await evaluateExperiments({ fetch: async () => null, now: () => Date.parse("2026-10-21T04:15:00Z") });
  const afterEval = await readExperiments();
  assert.deepEqual(
    afterEval.experiments.find((e) => e.kind === "tc"),
    tcBefore,
    "the evaluator leaves tc entries byte for byte",
  );
  assert.equal(afterEval.evaluatedOn, "2026-10-21");
  assert.equal(afterEval.appliedOn, "2026-10-21", "and keeps the render tick's guard");

  const again = await importTcPlan(plan);
  assert.equal(again.added.length, 0, "re-importing the same plan adds nothing");
  const final = await readExperiments();
  assert.equal(final.evaluatedOn, "2026-10-21", "a later tc write keeps the evaluator's once-a-day guard");
  assert.deepEqual(final.baseline, { countdownTeaser: false }, "and the baseline");
  assert.equal(final.experiments.filter((e) => e.kind === "between").length, 1, "and the between experiment");
}

console.log("studioExperiments.contract: all checks passed");
