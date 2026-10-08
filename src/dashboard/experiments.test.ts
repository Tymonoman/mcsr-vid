// Self-check for experiments.ts. Run: npx tsx src/dashboard/experiments.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// CONFIG_PATH (src/config.ts) is resolved once, at config.js's first import, from cwd/MCSR_CONFIG
// — so this test owns both: a temp cwd for the Settings file `applyScheduledRenderArm` writes
// through (`saveSettings`), and a separate temp mediaDir for `.experiments.json` and
// `experiment-arm.json`. Same recipe as settings.test.ts, which owns CONFIG_PATH the same way.
const cwdDir = mkdtempSync(path.join(tmpdir(), "mcsr-exp-cwd-"));
const media = mkdtempSync(path.join(tmpdir(), "mcsr-exp-media-"));
process.chdir(cwdDir);
delete process.env.MCSR_CONFIG;
writeFileSync(path.join(cwdDir, "mcsr-vid.config.json"), JSON.stringify({ mediaDir: media }, null, 2));

const { config } = await import("../config.js");
assert.equal(config.mediaDir, media, "this test owns its own mediaDir");
const {
  readExperiments,
  writeExperiments,
  scheduleEntryFor,
  rankedHoursForDate,
  shortDelayMsForDate,
  applyScheduledRenderArm,
  writeExperimentArmFile,
  testsSummary,
  needsHumanExperiments,
  renderExperimentsDoc,
} = await import("./experiments.js");

const experimentsFile = path.join(media, ".experiments.json");

// --- Reading: missing and corrupt are both "nothing running", never a crash ---------------------
assert.deepEqual(readExperiments(), { experiments: [], schedule: [] });
writeFileSync(experimentsFile, "{ not json");
assert.deepEqual(readExperiments(), { experiments: [], schedule: [] }, "corrupt reads as empty");

// --- Writing is atomic (write-then-rename) and round-trips ---------------------------------------
writeExperiments({ experiments: [], schedule: [{ date: "2026-10-08", experimentId: "e1", arm: "a" }] });
assert.ok(!existsSync(`${experimentsFile}.part`), "no .part left behind");
assert.deepEqual(readExperiments().schedule, [{ date: "2026-10-08", experimentId: "e1", arm: "a" }]);

// --- Schedule lookup -------------------------------------------------------------------------------
{
  const data = {
    experiments: [],
    schedule: [
      { date: "2026-10-08", experimentId: "e1", arm: "19", slot: { rankedHoursUtc: [19, 15] } },
      { date: "2026-10-09", experimentId: "e1", arm: "control", slot: { shortDelayHours: 6 } },
      { date: "2026-10-10", experimentId: "e1", arm: "bad-delay", slot: { shortDelayHours: 72 } },
      { date: "2026-10-11", experimentId: "e1", arm: "zero-delay", slot: { shortDelayHours: 0 } },
    ],
  };
  assert.equal(scheduleEntryFor("2026-10-08", data)?.arm, "19");
  assert.equal(scheduleEntryFor("2026-10-30", data), undefined);

  // Sorted, first free hour wins — a two-a-day day is exactly this.
  assert.deepEqual(rankedHoursForDate("2026-10-08", data), [15, 19]);
  assert.equal(rankedHoursForDate("2026-10-09", data), undefined, "no rankedHoursUtc on this day's entry");
  assert.equal(rankedHoursForDate("2026-10-30", data), undefined, "no entry at all — the no-entry path");

  assert.equal(shortDelayMsForDate("2026-10-09", data), 6 * 3600_000);
  assert.equal(shortDelayMsForDate("2026-10-10", data), undefined, "72 h is out of the 1-48 range");
  assert.equal(shortDelayMsForDate("2026-10-11", data), undefined, "0 h is out of range too");
  assert.equal(shortDelayMsForDate("2026-10-30", data), undefined, "no entry at all");
}

// --- applyScheduledRenderArm: once, only with valid keys ------------------------------------------
{
  writeExperiments({ experiments: [], schedule: [] });
  config.nightlyRenderHourUtc = null;
  applyScheduledRenderArm(Date.parse("2026-10-08T02:45:00Z"));
  assert.equal(readExperiments().appliedOn, undefined, "no nightly scheduled — nothing to arm");

  config.nightlyRenderHourUtc = 3;
  applyScheduledRenderArm(Date.parse("2026-10-08T00:00:00Z")); // 3 h out, outside the 30-minute window
  assert.equal(readExperiments().appliedOn, undefined, "outside the lead window — too early to apply");

  // Nothing ever set up (no experiments, no schedule): a tick inside the window still leaves no
  // trace — no appliedOn recorded — rather than writing one for a day that never had anything to apply.
  applyScheduledRenderArm(Date.parse("2026-10-08T02:45:00Z"));
  assert.equal(readExperiments().appliedOn, undefined, "nothing to track — nothing recorded");

  writeExperiments({
    experiments: [
      {
        id: "e1",
        kind: "between",
        hypothesis: "h",
        variable: "v",
        metric: "ctr",
        controlArm: "control",
        arms: [],
        videos: [],
        start: "2026-10-08",
        end: "2026-10-14",
        status: "running",
      },
    ],
    schedule: [
      {
        date: "2026-10-08",
        experimentId: "e1",
        arm: "4s",
        render: { introSec: 4, mediaDir: "/not/allowed" },
      },
    ],
  });
  const originalIntroSec = config.introSec;
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    applyScheduledRenderArm(Date.parse("2026-10-08T02:45:00Z")); // 15 min before 03:00 UTC
  } finally {
    console.error = realError;
  }
  assert.equal(config.introSec, 4, "the valid key was applied through saveSettings");
  assert.equal(readExperiments().appliedOn, "2026-10-08");
  assert.ok(
    logged.some((l) => String(l[0]).includes("mediaDir")),
    `the refused key is named in a log line (got ${JSON.stringify(logged)})`,
  );

  // Applied once: a restart (another process reading the same file) or the next 15-minute tick
  // inside the same window must not re-apply, even if the live setting were pushed back by hand.
  config.introSec = originalIntroSec;
  applyScheduledRenderArm(Date.parse("2026-10-08T02:50:00Z"));
  assert.equal(config.introSec, originalIntroSec, "already appliedOn today — a no-op");
}

// --- The no-entry path is byte-identical: a day with nothing scheduled changes nothing -----------
// (the file is not empty — it holds yesterday's entry — so this is "no entry for *this* date",
// not "nothing was ever set up", which the block above covers separately.)
{
  writeExperiments({ experiments: [], schedule: [{ date: "2026-10-08", experimentId: "e1", arm: "a" }] });
  const before = config.introSec;
  applyScheduledRenderArm(Date.parse("2026-10-09T02:45:00Z"));
  assert.equal(config.introSec, before);
  assert.equal(
    readExperiments().appliedOn,
    "2026-10-09",
    "still recorded, so the window is cheap to re-check",
  );
}

// --- applyScheduledRenderArm: tells the caller when nightlyRenderHourUtc itself just moved -----
// (so server.ts knows to rearm the nightly's own pending timer — the same signal /api/settings'
// PUT handler already acts on; scheduleNightly's setTimeout would otherwise keep firing at the
// stale hour until the render it's mid-way through finishes and re-arms itself.)
{
  writeExperiments({
    experiments: [],
    schedule: [{ date: "2026-10-10", experimentId: "e1", arm: "later", render: { introSec: 5 } }],
  });
  config.nightlyRenderHourUtc = 3;
  const noHourChange = applyScheduledRenderArm(Date.parse("2026-10-10T02:45:00Z"));
  assert.equal(noHourChange, false, "the patch didn't touch nightlyRenderHourUtc — nothing to rearm");

  writeExperiments({
    experiments: [],
    schedule: [{ date: "2026-10-11", experimentId: "e1", arm: "later", render: { nightlyRenderHourUtc: 4 } }],
  });
  config.nightlyRenderHourUtc = 3;
  const hourChanged = applyScheduledRenderArm(Date.parse("2026-10-11T02:45:00Z"));
  assert.equal(hourChanged, true, "nightlyRenderHourUtc itself moved — the caller must rearm the nightly");
  assert.equal(config.nightlyRenderHourUtc, 4, "the new hour took effect through saveSettings");
}

// --- writeExperimentArmFile: a snapshot, only when today has an entry ----------------------------
{
  writeExperiments({ experiments: [], schedule: [] });
  writeExperimentArmFile(900001, Date.parse("2026-10-09T03:00:00Z"));
  assert.ok(!existsSync(path.join(media, "900001")), "no entry today — nothing written, no directory either");

  writeExperiments({
    experiments: [
      {
        id: "e2",
        kind: "between",
        hypothesis: "h",
        variable: "midRollCtaAtSec",
        metric: "ctr",
        controlArm: "control",
        arms: [
          { name: "control", settings: { midRollCtaAtSec: 90 } },
          { name: "off", settings: { midRollCtaAtSec: null } },
        ],
        videos: [],
        start: "2026-10-08",
        end: "2026-10-14",
        status: "running",
      },
    ],
    schedule: [{ date: "2026-10-08", experimentId: "e2", arm: "off" }],
  });
  config.midRollCtaAtSec = null;
  writeExperimentArmFile(900002, Date.parse("2026-10-08T03:00:00Z"));
  const armFile = path.join(media, "900002", "experiment-arm.json");
  assert.ok(existsSync(armFile));
  const body = JSON.parse(readFileSync(armFile, "utf8")) as {
    date: string;
    experimentId: string;
    arm: string;
    settings: Record<string, unknown>;
  };
  assert.equal(body.date, "2026-10-08");
  assert.equal(body.experimentId, "e2");
  assert.equal(body.arm, "off");
  assert.equal(body.settings.midRollCtaAtSec, null, "the arm's own tested key is in the snapshot");
  assert.equal(body.settings.introSec, config.introSec, "the fixed keys ride along too");
  assert.ok(!existsSync(`${armFile}.part`));
}

// --- writeExperimentArmFile: prefers the night applyScheduledRenderArm actually applied for ----
// A chained render (nightlyMaxRenders > 1) that starts after UTC midnight must not file itself
// under *tomorrow's* schedule entry while the settings actually in effect are still last night's.
{
  writeExperiments({
    experiments: [],
    schedule: [{ date: "2026-10-08", experimentId: "e3", arm: "late-night" }],
    appliedOn: "2026-10-08",
  });
  // The chained render starts just after UTC midnight — wall-clock "today" is already 2026-10-09,
  // a date this schedule has no entry for.
  writeExperimentArmFile(900003, Date.parse("2026-10-09T00:10:00Z"));
  const armFile3 = path.join(media, "900003", "experiment-arm.json");
  assert.ok(existsSync(armFile3), "filed under the night's own date, not the one it happened to start on");
  const body3 = JSON.parse(readFileSync(armFile3, "utf8")) as { date: string; experimentId: string };
  assert.equal(body3.date, "2026-10-08", "appliedOn's date wins over wall-clock 'today'");
  assert.equal(body3.experimentId, "e3");

  // A stale appliedOn (the nightly off since, or never armed this far back) is not trusted —
  // falls back to wall-clock today, same as before this existed.
  writeExperiments({
    experiments: [],
    schedule: [{ date: "2026-10-09", experimentId: "e4", arm: "today" }],
    appliedOn: "2026-09-20",
  });
  writeExperimentArmFile(900004, Date.parse("2026-10-09T03:00:00Z"));
  const armFile4 = path.join(media, "900004", "experiment-arm.json");
  assert.ok(existsSync(armFile4), "a stale appliedOn falls back to wall-clock today's own entry");
  const body4 = JSON.parse(readFileSync(armFile4, "utf8")) as { date: string; experimentId: string };
  assert.equal(body4.date, "2026-10-09");
  assert.equal(body4.experimentId, "e4");
}

// --- needsHumanExperiments: the "Needs you" source gatherAlerts (src/telegram/facts.ts) reads ---
{
  const data = {
    experiments: [
      {
        id: "stuck",
        kind: "between" as const,
        hypothesis: "h",
        variable: "v",
        metric: "ctr",
        controlArm: "control",
        arms: [],
        videos: [],
        start: "2026-09-01",
        end: "2026-09-14",
        status: "running" as const,
        needsHuman: "Reporting API down",
      },
      {
        id: "fine",
        kind: "between" as const,
        hypothesis: "h",
        variable: "v",
        metric: "ctr",
        controlArm: "control",
        arms: [],
        videos: [],
        start: "2026-10-01",
        end: "2026-10-14",
        status: "running" as const,
      },
      {
        id: "tc-stuck",
        kind: "tc" as const,
        hypothesis: "h",
        variable: "v",
        metric: "ctr",
        controlArm: "control",
        arms: [],
        videos: [],
        start: "2026-09-01",
        end: "2026-09-14",
        status: "running" as const,
        needsHuman: "should never be set on a tc experiment, but filtered out either way",
      },
    ],
    schedule: [],
  };
  const flagged = needsHumanExperiments(data);
  assert.deepEqual(
    flagged.map((e) => e.id),
    ["stuck"],
    "only the between experiment that needs one",
  );
}

// --- testsSummary: running count, today's schedule, verdicts/decisions since the last report -----
{
  const data = {
    experiments: [
      {
        id: "running-one",
        kind: "between" as const,
        hypothesis: "h",
        variable: "v",
        metric: "ctr",
        controlArm: "control",
        arms: [],
        videos: [],
        start: "2026-10-01",
        end: "2026-10-14",
        status: "running" as const,
      },
      {
        id: "done-recent",
        kind: "between" as const,
        hypothesis: "h",
        variable: "v",
        metric: "ctr",
        controlArm: "control",
        arms: [],
        videos: [],
        start: "2026-09-01",
        end: "2026-10-01",
        status: "done" as const,
        verdict: "no difference on CTR",
        decision: "kept control: no difference on CTR",
        evaluatedAt: "2026-10-08T04:15:00Z",
      },
      {
        id: "done-stale",
        kind: "between" as const,
        hypothesis: "h",
        variable: "v",
        metric: "ctr",
        controlArm: "control",
        arms: [],
        videos: [],
        start: "2026-08-01",
        end: "2026-08-14",
        status: "done" as const,
        verdict: "no difference on CTR",
        decision: "kept control: no difference on CTR",
        evaluatedAt: "2026-08-15T04:15:00Z",
      },
      {
        id: "tc-one",
        kind: "tc" as const,
        hypothesis: "h",
        variable: "v",
        metric: "ctr",
        controlArm: "control",
        arms: [],
        videos: [],
        start: "2026-10-01",
        end: "2026-10-14",
        status: "running" as const,
      },
    ],
    schedule: [{ date: "2026-10-08", experimentId: "running-one", arm: "19" }],
  };
  const nowMs = Date.parse("2026-10-08T07:00:00Z");
  const sinceMs = Date.parse("2026-10-07T07:00:00Z");
  const summary = testsSummary(nowMs, sinceMs, data);
  assert.equal(summary.runningCount, 1, "the tc experiment does not count");
  assert.deepEqual(summary.scheduleToday, [{ experimentId: "running-one", arm: "19" }]);
  assert.deepEqual(summary.since, [
    {
      experimentId: "done-recent",
      verdict: "no difference on CTR",
      decision: "kept control: no difference on CTR",
    },
  ]);
}

// --- renderExperimentsDoc: a title, between experiments only, schedule ahead only ------------------
{
  const data = {
    experiments: [
      {
        id: "e3",
        kind: "between" as const,
        hypothesis: "publish hour moves CTR",
        variable: "publishHourUtc",
        metric: "ctr",
        controlArm: "control",
        arms: [{ name: "control" }, { name: "21" }],
        videos: [{ matchId: 1, arm: "control" }],
        start: "2026-10-01",
        end: "2026-10-14",
        status: "running" as const,
        verdict: "no difference on CTR",
      },
      {
        id: "tc-skip",
        kind: "tc" as const,
        hypothesis: "studio test",
        variable: "title",
        metric: "ctr",
        controlArm: "control",
        arms: [],
        videos: [],
        start: "2026-10-01",
        end: "2026-10-14",
        status: "running" as const,
      },
    ],
    schedule: [
      { date: "2026-10-01", experimentId: "e3", arm: "control" },
      { date: "2026-10-09", experimentId: "e3", arm: "21" },
    ],
  };
  const doc = renderExperimentsDoc(Date.parse("2026-10-08T07:00:00Z"), data);
  assert.ok(doc.startsWith("# Experiments"));
  assert.ok(doc.includes("## e3 — publish hour moves CTR"));
  assert.ok(doc.includes("verdict: no difference on CTR"));
  assert.ok(!doc.includes("tc-skip"), "Studio's own Test & Compare runs are not listed");
  assert.ok(doc.includes("2026-10-09: e3 / 21"), "ahead of today");
  assert.ok(!doc.includes("2026-10-01: e3 / control"), "past dates are not 'ahead'");
}

console.log("experiments: all checks passed");
