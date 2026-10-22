// Contract test for the experiment engine's schedule side (src/dashboard/experiments.ts), written
// from the docs, not the code. Run: npx tsx src/dashboard/experiments.contract.test.ts
//
// What the docs promise (CLAUDE.md "The experiment engine runs between-video A/B tests
// unattended"; handbook/claude-md-reference.md, same bullet; README "The experiment engine"):
//
//  1. `.experiments.json` is read defensively: a corrupt file is "nothing running", never a crash,
//     and the render tick never writes an empty file over it.
//  2. A tick 30 minutes before `nightlyRenderHourUtc` applies the schedule entry of the UTC date it
//     is about to render on — across midnight too (a 00:00 render hour arms the NEXT date).
//  3. It changes a setting only through `saveSettings` — the config file itself, so the arm survives
//     a restart until the next night's entry.
//  4. Only real SETTINGS keys: an unknown key is refused with ONE log line and the rest still
//     applies. The three switches CLAUDE.md keeps off the Settings tab (`youtubeUploadEnabled`,
//     `nightlyUpload`, `studioAutomation`) and the config-file-only Telegram hour are never written.
//  5. A value Settings itself would reject is not applied, the config file is left intact, and the
//     tick neither throws nor retries every 15 minutes (`appliedOn` still records the night).
//  6. `appliedOn` once per date; the next night's entry still applies (arms alternate by day), and
//     a tick outside the lead window (too early, or just after the hour) does nothing.
//  7. "tc" experiments, `baseline` and `evaluatedOn` are carried through the tick's write untouched.
//  8. A render entry and a slot entry of different experiments coexist on one date: the render side
//     takes the render-tagged one, the slot side the slot-tagged one (the FIRST slot-tagged one when
//     two exist), and a render-only date changes no publish hour or Short delay.
//  9. The nightly's experiment-arm.json snapshots the settings the tick just applied, naming the
//     render experiment and arm, end to end.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Experiment, ExperimentsFile } from "./experiments.js";

// CONFIG_PATH is resolved once, at config.js's first import, from cwd — this test owns both its
// Settings file (written by saveSettings) and its mediaDir (same recipe as experiments.test.ts).
const cwdDir = mkdtempSync(path.join(tmpdir(), "mcsr-expc-cwd-"));
const media = mkdtempSync(path.join(tmpdir(), "mcsr-expc-media-"));
process.chdir(cwdDir);
delete process.env.MCSR_CONFIG;
const configFile = path.join(cwdDir, "mcsr-vid.config.json");
writeFileSync(configFile, JSON.stringify({ mediaDir: media }, null, 2));

const { config } = await import("../config.js");
const {
  readExperiments,
  writeExperiments,
  applyScheduledRenderArm,
  writeExperimentArmFile,
  slotEntryFor,
  rankedHoursForDate,
  shortDelayMsForDate,
} = await import("./experiments.js");

const experimentsFile = path.join(media, ".experiments.json");
const configOnDisk = (): Record<string, unknown> =>
  JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;

function quiet<T>(fn: () => T): { value: T; logged: string[] } {
  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    return { value: fn(), logged };
  } finally {
    console.error = real;
  }
}

const between = (over: Partial<Experiment> = {}): Experiment => ({
  id: "x",
  kind: "between",
  hypothesis: "h",
  variable: "introSec",
  metric: "average view %",
  controlArm: "7s",
  arms: [
    { name: "7s", settings: { introSec: 7 } },
    { name: "4s", settings: { introSec: 4 } },
  ],
  videos: [],
  start: "2026-10-01",
  end: "2026-10-30",
  status: "running",
  ...over,
});

config.nightlyRenderHourUtc = 3;

// --- 1. A corrupt file is never overwritten by the render tick --------------------------------------
{
  const corrupt = '{ "experiments": [ { "id": "x", }, ], "schedule": [] ';
  writeFileSync(experimentsFile, corrupt);
  const introBefore = config.introSec;
  const { value } = quiet(() => applyScheduledRenderArm(Date.parse("2026-10-08T02:45:00Z")));
  // A hand-edit's trailing comma must not cost every experiment, the schedule and the tc records.
  assert.equal(readFileSync(experimentsFile, "utf8"), corrupt, "left byte for byte");
  assert.equal(value, false);
  assert.equal(config.introSec, introBefore, "nothing applied from a file nobody can read");
}

// --- 3. Applied through saveSettings: the config FILE carries the arm -------------------------------
{
  writeExperiments({
    experiments: [between()],
    schedule: [{ date: "2026-10-08", experimentId: "x", arm: "4s", render: { introSec: 4 } }],
  });
  applyScheduledRenderArm(Date.parse("2026-10-08T02:45:00Z"));
  assert.equal(config.introSec, 4, "live for tonight's render");
  assert.equal(configOnDisk().introSec, 4, "and in mcsr-vid.config.json, so a restart before 03:00 keeps it");
  assert.equal(configOnDisk().mediaDir, media, "the rest of the operator's config file survives the write");
}

// --- 4. Only real SETTINGS keys; the deliberate box-only switches are never flipped ------------------
{
  const before = {
    youtubeUploadEnabled: config.youtubeUploadEnabled,
    nightlyUpload: config.nightlyUpload,
    studioAutomation: config.studioAutomation,
  };
  writeExperiments({
    experiments: [between()],
    schedule: [
      {
        date: "2026-10-09",
        experimentId: "x",
        arm: "5s",
        render: {
          introSec: 5,
          youtubeUploadEnabled: !before.youtubeUploadEnabled,
          nightlyUpload: before.nightlyUpload === "off" ? "scheduled" : "off",
          studioAutomation: !before.studioAutomation,
          telegramReportHourWarsaw: 5,
        },
      },
    ],
  });
  const { logged } = quiet(() => applyScheduledRenderArm(Date.parse("2026-10-09T02:45:00Z")));
  // CLAUDE.md: these three "stay a deliberate edit on the box" — an experiment is not the operator.
  assert.deepEqual(
    {
      youtubeUploadEnabled: config.youtubeUploadEnabled,
      nightlyUpload: config.nightlyUpload,
      studioAutomation: config.studioAutomation,
    },
    before,
    "upload, nightly-upload and Studio switches untouched",
  );
  for (const key of ["youtubeUploadEnabled", "nightlyUpload", "studioAutomation", "telegramReportHourWarsaw"])
    assert.ok(!(key in configOnDisk()), `${key} never reaches the config file`);
  assert.equal(config.introSec, 5, "the real key beside them still applies");
  const refusals = logged.filter((l) => /unknown key/.test(l));
  assert.equal(refusals.length, 1, `one log line for the refusal, got ${JSON.stringify(logged)}`);
  for (const key of ["youtubeUploadEnabled", "nightlyUpload", "studioAutomation", "telegramReportHourWarsaw"])
    assert.ok(refusals[0]!.includes(key), `the line names ${key}`);
}

// --- 5. A value Settings rejects: not applied, file intact, no throw, not retried all night ---------
{
  const fileBefore = readFileSync(configFile, "utf8");
  const introBefore = config.introSec;
  writeExperiments({
    experiments: [between()],
    schedule: [{ date: "2026-10-10", experimentId: "x", arm: "typo", render: { introSec: 99 } }],
  });
  const { logged } = quiet(() => applyScheduledRenderArm(Date.parse("2026-10-10T02:45:00Z")));
  assert.equal(config.introSec, introBefore, "introSec is 2-7 on the Settings tab; 99 is never live");
  assert.equal(readFileSync(configFile, "utf8"), fileBefore, "the config file is not half-written");
  assert.ok(
    logged.some((l) => l.includes("failed")),
    `the failure is logged, got ${JSON.stringify(logged)}`,
  );
  assert.equal(readExperiments().appliedOn, "2026-10-10", "the night is recorded: no retry every 15 minutes");
}

// --- 2. A 00:00 UTC render hour: the 23:45 tick arms TOMORROW's date -------------------------------
{
  config.nightlyRenderHourUtc = 0;
  writeExperiments({
    experiments: [between()],
    schedule: [
      { date: "2026-10-11", experimentId: "x", arm: "3s", render: { introSec: 3 } },
      { date: "2026-10-12", experimentId: "x", arm: "6s", render: { introSec: 6 } },
    ],
  });
  applyScheduledRenderArm(Date.parse("2026-10-11T23:45:00Z"));
  assert.equal(config.introSec, 6, "the render at 00:00 runs on 12 Oct, so 12 Oct's arm applies");
  assert.equal(readExperiments().appliedOn, "2026-10-12");
  config.nightlyRenderHourUtc = 3;
}

// --- 6. Once a night, next night again; outside the window nothing -------------------------------------
{
  writeExperiments({
    experiments: [between()],
    schedule: [
      { date: "2026-10-13", experimentId: "x", arm: "4s", render: { introSec: 4 } },
      { date: "2026-10-14", experimentId: "x", arm: "7s", render: { introSec: 7 } },
    ],
  });
  applyScheduledRenderArm(Date.parse("2026-10-13T00:30:00Z")); // 2.5 h early
  assert.equal(readExperiments().appliedOn, undefined, "too early: not armed yet");
  applyScheduledRenderArm(Date.parse("2026-10-13T02:40:00Z"));
  assert.equal(config.introSec, 4, "13 Oct's arm");
  config.introSec = 5; // the operator moves it by hand after the tick
  applyScheduledRenderArm(Date.parse("2026-10-13T02:55:00Z"));
  assert.equal(config.introSec, 5, "same night again: not re-applied over the operator's hand");
  applyScheduledRenderArm(Date.parse("2026-10-13T03:10:00Z")); // just after the hour: next render is 23 h away
  assert.equal(config.introSec, 5, "just after the render hour: nothing to arm");
  applyScheduledRenderArm(Date.parse("2026-10-14T02:45:00Z"));
  assert.equal(config.introSec, 7, "the next night's arm applies — arms alternate by day");
  assert.equal(readExperiments().appliedOn, "2026-10-14");
}

// --- 7. tc entries, baseline and evaluatedOn ride through the tick's write untouched -------------------
{
  // A Studio-written Test & Compare entry: none of the between fields, its own result shape.
  const tc = {
    id: "tc-thumbnail-abc123",
    kind: "tc",
    variable: "thumbnail",
    controlArm: "control",
    arms: [
      { name: "control", settings: { file: "/media/1/tc/tc-control.png" } },
      { name: "challenger1", settings: { file: "/media/1/tc/tc-pose.png" } },
    ],
    videos: [{ videoId: "abc123", matchId: 1, arm: "tc" }],
    status: "running",
    start: "2026-10-08T07:41:00.000Z",
    result: { checkedAt: "2026-10-09T08:00:00.000Z", raw: "Test in progress" },
  } as unknown as Experiment;
  const file: ExperimentsFile = {
    baseline: { introSec: 7, explainMovesSec: null },
    experiments: [tc, between()],
    schedule: [{ date: "2026-10-15", experimentId: "x", arm: "4s", render: { introSec: 4 } }],
    evaluatedOn: "2026-10-14",
  };
  writeExperiments(file);
  applyScheduledRenderArm(Date.parse("2026-10-15T02:45:00Z"));
  const after = readExperiments();
  assert.equal(after.appliedOn, "2026-10-15", "the tick did write");
  assert.deepEqual(after.experiments[0], tc, "the tc entry is carried through byte for byte");
  assert.deepEqual(after.baseline, file.baseline, "baseline untouched");
  assert.equal(after.evaluatedOn, "2026-10-14", "the evaluator's once-a-day guard untouched");
}

// --- 8. Render and slot entries of different experiments on one date -----------------------------------
{
  const data: ExperimentsFile = {
    experiments: [],
    schedule: [
      { date: "2026-10-16", experimentId: "render-x", arm: "4s", render: { introSec: 4 } },
      { date: "2026-10-16", experimentId: "hours-a", arm: "two-a-day", slot: { rankedHoursUtc: [23, 19] } },
      {
        date: "2026-10-16",
        experimentId: "hours-b",
        arm: "late",
        slot: { rankedHoursUtc: [21], shortDelayHours: 6 },
      },
      { date: "2026-10-17", experimentId: "render-x", arm: "7s", render: { introSec: 7 } },
    ],
  };
  // "the slot lookups take the date's first entry tagged slot"
  assert.equal(slotEntryFor("2026-10-16", data)?.experimentId, "hours-a");
  assert.deepEqual(rankedHoursForDate("2026-10-16", data), [19, 23], "sorted, first free hour wins");
  assert.equal(
    shortDelayMsForDate("2026-10-16", data),
    6 * 3600_000,
    "the delay comes from the slot entry that sets one, whichever experiment's (22 Oct 2026)",
  );
  // A render-only date leaves the publish slot and the Short's delay at their standing values.
  assert.equal(rankedHoursForDate("2026-10-17", data), undefined, "render arm never moves a publish hour");
  assert.equal(shortDelayMsForDate("2026-10-17", data), undefined, "nor the Short's 18 h");

  // A slot-only date: the render tick has nothing to apply.
  writeExperiments({
    experiments: [],
    schedule: [
      { date: "2026-10-18", experimentId: "hours-a", arm: "two-a-day", slot: { rankedHoursUtc: [19, 23] } },
    ],
  });
  const before = readFileSync(configFile, "utf8");
  const introBefore = config.introSec;
  applyScheduledRenderArm(Date.parse("2026-10-18T02:45:00Z"));
  assert.equal(config.introSec, introBefore, "a slot entry carries no Settings patch");
  assert.equal(readFileSync(configFile, "utf8"), before, "the config file is not touched");
}

// --- 9. End to end: tick applies the arm, the nightly's arm file snapshots it ---------------------------
{
  writeExperiments({
    experiments: [
      between({
        id: "x2-explain-moves",
        variable: "explainMovesSec",
        controlArm: "on",
        arms: [
          { name: "on", settings: { explainMovesSec: 8 } },
          { name: "off", settings: { explainMovesSec: null } },
        ],
      }),
    ],
    schedule: [
      { date: "2026-10-19", experimentId: "slot-exp", arm: "19", slot: { rankedHoursUtc: [19] } },
      { date: "2026-10-19", experimentId: "x2-explain-moves", arm: "on", render: { explainMovesSec: 8 } },
    ],
  });
  applyScheduledRenderArm(Date.parse("2026-10-19T02:45:00Z"));
  const matchId = 13673240; // src/fixtures/match-13673240.json
  writeExperimentArmFile(matchId, Date.parse("2026-10-19T03:00:05Z"));
  const armPath = path.join(media, String(matchId), "experiment-arm.json");
  assert.ok(existsSync(armPath), "the nightly's render is labelled with its arm");
  const body = JSON.parse(readFileSync(armPath, "utf8")) as {
    date: string;
    experimentId: string;
    arm: string;
    settings: Record<string, unknown>;
  };
  assert.deepEqual([body.date, body.experimentId, body.arm], ["2026-10-19", "x2-explain-moves", "on"]);
  assert.equal(body.settings.explainMovesSec, 8, "the snapshot is the setting the tick just made live");
  assert.equal(body.settings.introSec, config.introSec, "the confounders ride along");
}

process.chdir(tmpdir());
for (const dir of [cwdDir, media]) rmSync(dir, { recursive: true, force: true });
console.log("experiments.contract: all checks passed");
