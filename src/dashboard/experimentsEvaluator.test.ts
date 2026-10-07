// Self-check for experimentsEvaluator.ts. Run: npx tsx src/dashboard/experimentsEvaluator.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Experiment } from "./experiments.js";
import type { ArmTotals, VideoMetrics } from "./experimentsEvaluator.js";

// Same recipe as experiments.test.ts / settings.test.ts: CONFIG_PATH is resolved once at config.js's
// first import, so `settle()`'s `saveSettings` calls need their own cwd, and the ledger its own
// mediaDir.
const cwdDir = mkdtempSync(path.join(tmpdir(), "mcsr-evalu-cwd-"));
const media = mkdtempSync(path.join(tmpdir(), "mcsr-evalu-media-"));
process.chdir(cwdDir);
delete process.env.MCSR_CONFIG;
writeFileSync(path.join(cwdDir, "mcsr-vid.config.json"), JSON.stringify({ mediaDir: media }, null, 2));

const { config } = await import("../config.js");
const { readExperiments, writeExperiments } = await import("./experiments.js");
const { armTotalsFor, twoProportionZ, verdictFor, evaluateExperiments } = await import(
  "./experimentsEvaluator.js"
);

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
  const thin = verdictFor(metric, [arm("control", 5000, 100, [10, 90]), arm("variant", 5000, 100, [80, 85, 90])]);
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
    ["v10", { impressions: 5000, clicks: 100, views: 1000, engagedViews: 400, averageViewPercentage: 40, subscribersGained: 1 }],
    ["v11", { impressions: 5000, clicks: 250, views: 1000, engagedViews: 400, averageViewPercentage: 42, subscribersGained: 2 }],
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
    ["c1", { impressions: 5000, clicks: 100, views: 1000, engagedViews: 400, averageViewPercentage: 40, subscribersGained: 1 }],
    ["v1", { impressions: 5000, clicks: 250, views: 1000, engagedViews: 400, averageViewPercentage: 42, subscribersGained: 2 }],
  ]);
  const fetch = async (_matchId: number, videoId: string | undefined): Promise<VideoMetrics | null> =>
    videoId ? (winningMetrics.get(videoId) ?? null) : null;

  // adoptWinner: true — the winning arm's settings become the new default.
  config.publishHourUtc = 17; // whatever it was before, should be overwritten
  const adopt = baseExperiment({
    id: "adopt-case",
    end: "2026-10-08",
    adoptWinner: true,
    arms: [{ name: "control", settings: { publishHourUtc: 19 } }, { name: "variant", settings: { publishHourUtc: 21 } }],
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
    arms: [{ name: "control", settings: { publishHourUtc: 19 } }, { name: "variant", settings: { publishHourUtc: 21 } }],
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

console.log("experimentsEvaluator: all checks passed");
