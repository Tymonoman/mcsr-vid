// Self-check for experimentsEvaluator.ts. Run: npx tsx src/dashboard/experimentsEvaluator.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Experiment } from "./experiments.js";
import type { ArmTotals, VideoMetrics } from "./experimentsEvaluator.js";
import type { UploadRecord } from "../youtube/youtubeStore.js";

// Same recipe as experiments.test.ts / settings.test.ts: CONFIG_PATH is resolved once at config.js's
// first import, so `settle()`'s `saveSettings` calls need their own cwd, and the ledger its own
// mediaDir.
const cwdDir = mkdtempSync(path.join(tmpdir(), "mcsr-evalu-cwd-"));
const media = mkdtempSync(path.join(tmpdir(), "mcsr-evalu-media-"));
process.chdir(cwdDir);
delete process.env.MCSR_CONFIG;
writeFileSync(path.join(cwdDir, "mcsr-vid.config.json"), JSON.stringify({ mediaDir: media }, null, 2));

const { config, matchDir } = await import("../config.js");
const { readExperiments, writeExperiments } = await import("./experiments.js");
const { armTotalsFor, twoProportionZ, verdictFor, evaluateExperiments } =
  await import("./experimentsEvaluator.js");
const { writeUpload } = await import("../youtube/youtubeStore.js");

// Fixtures for `enrolVideos`: a real match directory, since it's discovered by `listProcessedMatchIds`
// (a directory scan), not by anything in `.experiments.json` itself.
function fixtureArmFile(matchId: number, experimentId: string, arm: string): void {
  mkdirSync(matchDir(matchId), { recursive: true });
  writeFileSync(
    path.join(matchDir(matchId), "experiment-arm.json"),
    JSON.stringify({ date: "2026-10-01", experimentId, arm, settings: {} }),
  );
}
async function fixtureUpload(matchId: number, over: Partial<UploadRecord> = {}): Promise<void> {
  mkdirSync(matchDir(matchId), { recursive: true });
  await writeUpload(matchId, {
    videoId: `v${matchId}`,
    uploadedAt: "2026-10-01T00:00:00Z",
    publishAt: null,
    privacyStatus: "public",
    thumbnailVariant: null,
    title: "t",
    ...over,
  });
}

const DAY_MS = 86_400_000;
const arm = (name: string, impressions: number, clicks: number, pcts: number[] = []): ArmTotals => ({
  arm: name,
  videos: pcts.length,
  impressions,
  clicks,
  views: 1000 * pcts.length,
  engagedViews: 0,
  subscribersGained: 0,
  avgViewPercentage: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0,
  avgViewPercentages: pcts,
});

const baseExperiment = (over: Partial<Experiment> = {}): Experiment => ({
  id: "e1",
  kind: "between",
  hypothesis: "h",
  variable: "v",
  metric: "ctr",
  controlArm: "control",
  arms: [{ name: "control" }, { name: "variant" }],
  videos: [],
  start: "2026-10-01",
  end: "2026-10-14",
  status: "running",
  ...over,
});

// --- twoProportionZ ---------------------------------------------------------------------------
assert.equal(twoProportionZ(50, 1000, 50, 1000), 0, "identical rates: no z");
assert.equal(twoProportionZ(0, 0, 10, 100), 0, "nothing to divide by on one side");
{
  const z = twoProportionZ(250, 5000, 100, 5000); // 5% vs 2%, both well over 1,000 impressions
  assert.ok(z > 1.96, `expected a significant z, got ${z}`);
}

// --- verdictFor: the 1,000-impression floor first, regardless of metric -----------------------
{
  const v = verdictFor(baseExperiment(), [arm("control", 500, 20), arm("variant", 5000, 200)]);
  assert.equal(v.text, "inconclusive (500 impressions in arm control)");
  assert.equal(v.winnerArm, null);
}

// --- verdictFor: CTR, both directions -----------------------------------------------------------
{
  // The variant clearly wins.
  const up = verdictFor(baseExperiment(), [arm("control", 5000, 100), arm("variant", 5000, 250)]);
  assert.ok(up.text.startsWith("variant wins on CTR"), up.text);
  assert.equal(up.winnerArm, "variant");

  // The control clearly wins — nothing for `settle` to adopt even with adoptWinner on.
  const down = verdictFor(baseExperiment(), [arm("control", 5000, 250), arm("variant", 5000, 100)]);
  assert.ok(down.text.startsWith("control wins on CTR"), down.text);
  assert.equal(down.winnerArm, null);

  // Close enough that 1.96 is not crossed.
  const flat = verdictFor(baseExperiment(), [arm("control", 5000, 150), arm("variant", 5000, 155)]);
  assert.equal(flat.text, "no difference on CTR");
  assert.equal(flat.winnerArm, null);
}

// --- verdictFor: a retention metric, numbers-only unless every video of one arm beats the other -
{
  const metric = baseExperiment({ metric: "averageViewPercentage" });
  // Fewer than 3 videos on one side: numbers only, however far apart the means are.
  const thin = verdictFor(metric, [
    arm("control", 5000, 100, [10, 90]),
    arm("variant", 5000, 100, [80, 85, 90]),
  ]);
  assert.equal(thin.text, "numbers only");
  assert.equal(thin.winnerArm, null);

  // Every "variant" video beats every "control" video, 3 a side: a real winner.
  const dominant = verdictFor(metric, [
    arm("control", 5000, 100, [40, 42, 45]),
    arm("variant", 5000, 100, [50, 52, 55]),
  ]);
  assert.ok(dominant.text.startsWith("variant wins on average view %"), dominant.text);
  assert.equal(dominant.winnerArm, "variant");

  // Overlapping ranges: no dominance either way.
  const overlap = verdictFor(metric, [
    arm("control", 5000, 100, [40, 50, 60]),
    arm("variant", 5000, 100, [45, 55, 65]),
  ]);
  assert.equal(overlap.text, "numbers only");
  assert.equal(overlap.winnerArm, null);
}

// --- armTotalsFor: sums by arm, skips a video `fetch` returns null for ------------------------
{
  const m = (impressions: number, clicks: number, pct: number, views: number): VideoMetrics => ({
    impressions,
    clicks,
    views,
    engagedViews: Math.round(views * 0.4),
    averageViewPercentage: pct,
    subscribersGained: 1,
  });
  const byMatch = new Map<number, VideoMetrics | null>([
    [1, m(1000, 50, 40, 100)],
    [2, m(1000, 60, 60, 200)],
    [3, null], // this video's metrics could not be read — skipped, not counted
  ]);
  const exp = baseExperiment({
    videos: [
      { matchId: 1, arm: "control" },
      { matchId: 2, arm: "control" },
      { matchId: 3, arm: "control" },
    ],
  });
  const totals = await armTotalsFor(exp, async (matchId) => byMatch.get(matchId) ?? null);
  const control = totals.find((a) => a.arm === "control")!;
  assert.equal(control.videos, 2, "the unreadable video does not count");
  assert.equal(control.impressions, 2000);
  assert.equal(control.clicks, 110);
  // View-weighted mean: (40*100 + 60*200) / 300 = 53.33...
  assert.ok(Math.abs(control.avgViewPercentage - (40 * 100 + 60 * 200) / 300) < 1e-9);
  assert.equal(totals.find((a) => a.arm === "variant")!.videos, 0);
}

// --- evaluateExperiments: tc experiments are never touched -------------------------------------
{
  const tc: Experiment = {
    id: "studio-tc",
    kind: "tc",
    hypothesis: "h",
    variable: "title",
    metric: "ctr",
    controlArm: "control",
    arms: [{ name: "control" }],
    videos: [{ matchId: 999, arm: "control" }],
    start: "2026-10-01",
    end: "2026-10-14",
    status: "running",
  };
  writeExperiments({ experiments: [tc], schedule: [] });
  let called = false;
  await evaluateExperiments({
    fetch: async () => {
      called = true;
      throw new Error("must not be called for a tc experiment");
    },
    now: () => Date.parse("2026-10-08T04:15:00Z"),
  });
  assert.equal(called, false, "a tc experiment's videos are never fetched");
  const after = readExperiments().experiments[0]!;
  assert.deepEqual(after, tc, "a tc experiment is carried through byte-for-byte");
}

// --- evaluateExperiments: a running experiment not yet ended gets a result, stays running ------
{
  const exp = baseExperiment({
    id: "mid-run",
    videos: [
      { matchId: 10, arm: "control", videoId: "v10" },
      { matchId: 11, arm: "variant", videoId: "v11" },
    ],
    end: "2026-10-20", // in the future
  });
  writeExperiments({ experiments: [exp], schedule: [] });
  const metricsOf = new Map<string, VideoMetrics>([
    [
      "v10",
      {
        impressions: 5000,
        clicks: 100,
        views: 1000,
        engagedViews: 400,
        averageViewPercentage: 40,
        subscribersGained: 1,
      },
    ],
    [
      "v11",
      {
        impressions: 5000,
        clicks: 250,
        views: 1000,
        engagedViews: 400,
        averageViewPercentage: 42,
        subscribersGained: 2,
      },
    ],
  ]);
  await evaluateExperiments({
    fetch: async (_matchId, videoId) => (videoId ? (metricsOf.get(videoId) ?? null) : null),
    now: () => Date.parse("2026-10-08T04:15:00Z"),
  });
  const after = readExperiments().experiments.find((e) => e.id === "mid-run")!;
  assert.equal(after.status, "running", "not ended yet — still running");
  assert.ok(after.verdict?.startsWith("variant wins on CTR"), after.verdict);
  assert.equal(after.decision, undefined);
  assert.ok(after.evaluatedAt);
}

// --- evaluateExperiments: adoption and revert decisions at `end` -------------------------------
{
  const winningMetrics = new Map<string, VideoMetrics>([
    [
      "c1",
      {
        impressions: 5000,
        clicks: 100,
        views: 1000,
        engagedViews: 400,
        averageViewPercentage: 40,
        subscribersGained: 1,
      },
    ],
    [
      "v1",
      {
        impressions: 5000,
        clicks: 250,
        views: 1000,
        engagedViews: 400,
        averageViewPercentage: 42,
        subscribersGained: 2,
      },
    ],
  ]);
  const fetch = async (_matchId: number, videoId: string | undefined): Promise<VideoMetrics | null> =>
    videoId ? (winningMetrics.get(videoId) ?? null) : null;

  // adoptWinner: true — the winning arm's settings become the new default.
  config.publishHourUtc = 17; // whatever it was before, should be overwritten
  const adopt = baseExperiment({
    id: "adopt-case",
    end: "2026-10-08",
    adoptWinner: true,
    arms: [
      { name: "control", settings: { publishHourUtc: 19 } },
      { name: "variant", settings: { publishHourUtc: 21 } },
    ],
    videos: [
      { matchId: 20, arm: "control", videoId: "c1" },
      { matchId: 21, arm: "variant", videoId: "v1" },
    ],
  });
  writeExperiments({ experiments: [adopt], schedule: [] });
  await evaluateExperiments({ fetch, now: () => Date.parse("2026-10-08T04:15:00Z") });
  assert.equal(config.publishHourUtc, 21, "the winning arm's setting was adopted");
  const adopted = readExperiments().experiments.find((e) => e.id === "adopt-case")!;
  assert.equal(adopted.status, "done");
  assert.ok(adopted.decision?.startsWith("adopted variant:"), adopted.decision);

  // adoptWinner: false (the default) — the control arm's setting is kept, overwriting whatever
  // the render arm left live mid-run.
  config.publishHourUtc = 99 as unknown as number; // simulate a render arm having left something else live
  const revert = baseExperiment({
    id: "revert-case",
    end: "2026-10-08",
    arms: [
      { name: "control", settings: { publishHourUtc: 19 } },
      { name: "variant", settings: { publishHourUtc: 21 } },
    ],
    videos: [
      { matchId: 22, arm: "control", videoId: "c1" },
      { matchId: 23, arm: "variant", videoId: "v1" },
    ],
  });
  writeExperiments({ experiments: [revert], schedule: [] });
  await evaluateExperiments({ fetch, now: () => Date.parse("2026-10-09T04:15:00Z") });
  assert.equal(config.publishHourUtc, 19, "kept the control arm's setting");
  const reverted = readExperiments().experiments.find((e) => e.id === "revert-case")!;
  assert.equal(reverted.status, "done");
  assert.ok(reverted.decision?.startsWith("kept control:"), reverted.decision);
}

// --- evaluateExperiments: a saveSettings failure inside settle() must not mark it "done" --------
// A typo'd key (or a value validateOverrides rejects) must not be reported as a decision that
// took effect: it has to fall into the same retry path a Reporting/Analytics read failure does.
{
  const exp = baseExperiment({
    id: "bad-key",
    end: "2026-10-08",
    arms: [{ name: "control", settings: { notARealSetting: 1 } }, { name: "variant" }],
    videos: [{ matchId: 40, arm: "control", videoId: "c40" }],
  });
  writeExperiments({ experiments: [exp], schedule: [] });
  const fetch = async (): Promise<VideoMetrics | null> => ({
    impressions: 10,
    clicks: 1,
    views: 10,
    engagedViews: 4,
    averageViewPercentage: 40,
    subscribersGained: 0,
  });
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    await evaluateExperiments({ fetch, now: () => Date.parse("2026-10-08T04:15:00Z") });
  } finally {
    console.error = realError;
  }
  const after = readExperiments().experiments.find((e) => e.id === "bad-key")!;
  assert.equal(after.status, "running", "a saveSettings failure must not be marked done");
  assert.equal(after.decision, undefined, "no decision claiming a setting that never applied");
  assert.ok(after.lastEvalFailure?.message.includes("notARealSetting"), after.lastEvalFailure?.message);
  assert.ok(
    logged.some((l) => String(l[0]).includes("bad-key evaluation failed")),
    `logged the same way any other evaluation failure is (got ${JSON.stringify(logged)})`,
  );
}

// --- evaluateExperiments: a second concurrent call is a no-op while the first is in flight ------
{
  const exp = baseExperiment({ id: "reentrant", videos: [{ matchId: 50, arm: "control", videoId: "c50" }] });
  writeExperiments({ experiments: [exp], schedule: [] });
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const slow = async (): Promise<VideoMetrics | null> => {
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return {
      impressions: 10,
      clicks: 1,
      views: 10,
      engagedViews: 4,
      averageViewPercentage: 40,
      subscribersGained: 0,
    };
  };
  const now = () => Date.parse("2026-10-08T04:15:00Z");
  const first = evaluateExperiments({ fetch: slow, now });
  const second = evaluateExperiments({ fetch: slow, now }); // fired while `first` is still awaiting `slow`
  await Promise.all([first, second]);
  assert.equal(calls, 1, "the second call returned at once rather than fetching a second time");
  assert.equal(maxInFlight, 1, "never two evaluations in flight together");
}

// --- evaluateExperiments: a slow run's final write does not clobber a concurrent appliedOn ------
// server.ts's tick calls applyScheduledRenderArm (synchronous) right before this; a long
// evaluation must merge onto whatever the file holds when it finally writes, not the snapshot it
// read at the start.
{
  const exp = baseExperiment({
    id: "merge-check",
    videos: [{ matchId: 60, arm: "control", videoId: "c60" }],
  });
  writeExperiments({ experiments: [exp], schedule: [] });
  let released: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    released = resolve;
  });
  const fetch = async (): Promise<VideoMetrics | null> => {
    await held; // holds the evaluation open while the "concurrent" write below lands
    return {
      impressions: 10,
      clicks: 1,
      views: 10,
      engagedViews: 4,
      averageViewPercentage: 40,
      subscribersGained: 0,
    };
  };
  const run = evaluateExperiments({ fetch, now: () => Date.parse("2026-10-08T04:15:00Z") });
  // Simulates applyScheduledRenderArm's own write landing while the evaluation above is still
  // mid-flight, holding only `data` (its own stale read) in memory.
  writeExperiments({ ...readExperiments(), appliedOn: "2026-10-08" });
  released();
  await run;
  const after = readExperiments();
  assert.equal(after.appliedOn, "2026-10-08", "the concurrent appliedOn write survived");
  assert.ok(
    after.experiments.find((e) => e.id === "merge-check")?.evaluatedAt,
    "and this call's own result landed too",
  );
}

// --- evaluateExperiments: once a day, and a failure two days running sets needsHuman -----------
{
  const exp = baseExperiment({
    id: "flaky",
    end: "2026-10-20",
    videos: [{ matchId: 30, arm: "control", videoId: "c30" }],
  });
  writeExperiments({ experiments: [exp], schedule: [] });
  let fetchCalls = 0;
  const failing = async (): Promise<VideoMetrics | null> => {
    fetchCalls++;
    throw new Error("Reporting API down");
  };
  const day1 = Date.parse("2026-10-08T04:15:00Z");
  const day2 = day1 + DAY_MS;

  await evaluateExperiments({ fetch: failing, now: () => day1 });
  assert.equal(fetchCalls, 1);
  let after = readExperiments().experiments.find((e) => e.id === "flaky")!;
  assert.equal(after.needsHuman, undefined, "one failure is not yet a pattern");
  assert.equal(after.lastEvalFailure?.date, "2026-10-08");

  // A second call the same UTC day is a no-op (evaluatedOn), so this proves the guard, not the
  // failure streak.
  await evaluateExperiments({ fetch: failing, now: () => day1 + 1000 });
  assert.equal(fetchCalls, 1, "same day — evaluatedOn already set, nothing re-fetched");

  await evaluateExperiments({ fetch: failing, now: () => day2 });
  assert.equal(fetchCalls, 2);
  after = readExperiments().experiments.find((e) => e.id === "flaky")!;
  assert.ok(after.needsHuman?.includes("Reporting API down"), after.needsHuman);
  assert.equal(after.lastEvalFailure?.date, "2026-10-09");

  // And recovery clears both.
  await evaluateExperiments({
    fetch: async () => ({
      impressions: 2000,
      clicks: 40,
      views: 500,
      engagedViews: 200,
      averageViewPercentage: 30,
      subscribersGained: 0,
    }),
    now: () => day2 + DAY_MS,
  });
  after = readExperiments().experiments.find((e) => e.id === "flaky")!;
  assert.equal(after.needsHuman, undefined, "a clean run clears the flag");
  assert.equal(after.lastEvalFailure, undefined);
}

// --- enrolVideos (gap #2), via evaluateExperiments: RENDER experiments -------------------------
// Nothing pre-fills `videos` here — proving the evaluator itself discovers them from disk, unlike
// every test above, which hands `videos` to it by hand.
{
  fixtureArmFile(910001, "render-enrol", "control"); // not uploaded yet — enrolled anyway, no videoId
  fixtureArmFile(910002, "render-enrol", "variant");
  await fixtureUpload(910002, { videoId: "rv2" });

  const exp = baseExperiment({ id: "render-enrol", end: "2026-10-20", videos: [] });
  writeExperiments({ experiments: [exp], schedule: [] });
  const calls: (string | undefined)[] = [];
  const fetch = async (_matchId: number, videoId?: string): Promise<VideoMetrics | null> => {
    calls.push(videoId);
    if (videoId !== "rv2") return null;
    return {
      impressions: 2000,
      clicks: 80,
      views: 500,
      engagedViews: 200,
      averageViewPercentage: 30,
      subscribersGained: 0,
    };
  };
  await evaluateExperiments({ fetch, now: () => Date.parse("2026-10-08T04:15:00Z") });

  const after = readExperiments().experiments.find((e) => e.id === "render-enrol")!;
  assert.equal(after.videos.length, 2, "both match directories were enrolled");
  const control = after.videos.find((v) => v.matchId === 910001)!;
  assert.equal(control.arm, "control");
  assert.equal(control.videoId, undefined, "not uploaded yet — enrolled with no videoId");
  const variant = after.videos.find((v) => v.matchId === 910002)!;
  assert.equal(variant.arm, "variant");
  assert.equal(variant.videoId, "rv2", "videoId came from youtube.json");
  assert.ok(after.evaluatedAt, "the enrolled videos were actually evaluated, not just listed");
  assert.ok(calls.includes(undefined), "fetch was still asked about the not-yet-uploaded match");

  // A second day's tick must not duplicate — the same two directories are still on disk.
  await evaluateExperiments({ fetch, now: () => Date.parse("2026-10-09T04:15:00Z") });
  const again = readExperiments().experiments.find((e) => e.id === "render-enrol")!;
  assert.equal(again.videos.length, 2, "idempotent — re-scanning the same directories adds nothing");
}

// --- enrolVideos: SLOT experiments ---------------------------------------------------------------
{
  await fixtureUpload(920001, { videoId: "sv1", publishAt: "2026-10-08T18:00:00Z" }); // hour 18
  await fixtureUpload(920002, { videoId: "sv2", publishAt: "2026-10-08T20:00:00Z" }); // hour 20
  await fixtureUpload(920003, { videoId: "sv3", publishAt: "2026-10-08T05:00:00Z" }); // no arm's own hour
  await fixtureUpload(920004, { videoId: "sv4", publishAt: "2026-10-09T18:00:00Z" }); // no entry this date

  const exp = baseExperiment({
    id: "slot-enrol",
    end: "2026-10-20",
    controlArm: "18utc",
    arms: [
      { name: "18utc", slot: { rankedHoursUtc: [18] } },
      { name: "20utc", slot: { rankedHoursUtc: [20] } },
    ],
    videos: [],
  });
  writeExperiments({
    experiments: [exp],
    schedule: [
      {
        date: "2026-10-08",
        experimentId: "slot-enrol",
        arm: "fallback-label",
        slot: { rankedHoursUtc: [18, 20] },
      },
    ],
  });
  const fetch = async (): Promise<VideoMetrics | null> => ({
    impressions: 10,
    clicks: 1,
    views: 10,
    engagedViews: 4,
    averageViewPercentage: 40,
    subscribersGained: 0,
  });
  await evaluateExperiments({ fetch, now: () => Date.parse("2026-10-08T04:15:00Z") });

  const after = readExperiments().experiments.find((e) => e.id === "slot-enrol")!;
  assert.equal(after.videos.length, 3, "920004 (a different, un-scheduled date) was not enrolled");
  assert.equal(after.videos.find((v) => v.matchId === 920001)?.arm, "18utc", "matched its own hour's arm");
  assert.equal(after.videos.find((v) => v.matchId === 920002)?.arm, "20utc", "matched its own hour's arm");
  assert.equal(
    after.videos.find((v) => v.matchId === 920003)?.arm,
    "fallback-label",
    "no arm claims hour 5 — falls back to the schedule entry's own arm",
  );
  assert.equal(
    after.videos.find((v) => v.matchId === 920004),
    undefined,
  );
}

// --- evaluateExperiments: a concurrent edit to a DONE experiment's own field survives -----------
// (review fix, 8 Oct 2026): before this, `touched` was seeded with *every* between experiment —
// done or planned included — regardless of whether `enrolVideos` found anything new for it, so
// the final write force-wrote a stale copy over any of them. A "done" experiment enrolVideos
// finds nothing new for this run must be left exactly as `fresh` holds it.
{
  const running = baseExperiment({
    id: "merge-done-running",
    videos: [{ matchId: 70, arm: "control", videoId: "c70" }],
  });
  const done = baseExperiment({
    id: "merge-done-finished",
    status: "done",
    videos: [{ matchId: 71, arm: "control", videoId: "c71" }],
  });
  writeExperiments({ experiments: [running, done], schedule: [] });
  let released: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    released = resolve;
  });
  const fetch = async (): Promise<VideoMetrics | null> => {
    await held; // holds the evaluation open while the "concurrent" write below lands
    return {
      impressions: 10,
      clicks: 1,
      views: 10,
      engagedViews: 4,
      averageViewPercentage: 40,
      subscribersGained: 0,
    };
  };
  const run = evaluateExperiments({ fetch, now: () => Date.parse("2026-10-08T04:15:00Z") });
  // Simulates a write to the done experiment's own field — not its `videos`, which enrolVideos
  // never touches for it since no match directory names it this run — landing mid-flight.
  const mid = readExperiments();
  writeExperiments({
    ...mid,
    experiments: mid.experiments.map((e) =>
      e.id === "merge-done-finished" ? { ...e, needsHumanAck: true } : e,
    ),
  });
  released();
  await run;
  const after = readExperiments();
  assert.equal(
    after.experiments.find((e) => e.id === "merge-done-finished")?.needsHumanAck,
    true,
    "the concurrent edit to the untouched done experiment survived",
  );
  assert.ok(
    after.experiments.find((e) => e.id === "merge-done-running")?.evaluatedAt,
    "and the running experiment's own result still landed",
  );
}

console.log("experimentsEvaluator: all checks passed");
