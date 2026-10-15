// Self-check for experimentsEvaluator.ts. Run: npx tsx src/dashboard/experimentsEvaluator.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const { ALPHA, MIN_VIDEOS_PER_ARM, armTotalsFor, twoProportionZ, verdictFor, evaluateExperiments } =
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
/** One video: a CTR (%) on `impressions`, an average view % and subscribers on 1,000 views. */
const video = (ctr: number, avp = 40, impressions = 5000, subs = 0): VideoMetrics => ({
  impressions,
  clicks: Math.round((impressions * ctr) / 100),
  views: 1000,
  engagedViews: 0,
  averageViewPercentage: avp,
  subscribersGained: subs,
});
/** `n` values evenly around `center`, 0.2 apart: a per-video spread, not one pooled rate. */
const around = (center: number, n = 8): number[] =>
  [...Array(n)].map((_, i) => center + (i - (n - 1) / 2) * 0.2);
/** Real ArmTotals, through armTotalsFor itself, for each arm's own list of videos. */
async function armsOf(byArm: Record<string, VideoMetrics[]>): Promise<ArmTotals[]> {
  const all = Object.entries(byArm).flatMap(([arm, vids]) => vids.map((m) => ({ arm, m })));
  const exp = baseExperiment({
    arms: Object.keys(byArm).map((name) => ({ name })),
    videos: all.map(({ arm }, matchId) => ({ matchId, arm })),
  });
  return armTotalsFor(exp, async (matchId) => all[matchId]?.m ?? null);
}
/** 8 control videos ("c0".."c7") near 2% CTR and 8 variant videos ("v0".."v7") near 5%. */
const clearWin = (firstMatch: number) =>
  [...Array(16)].map((_, i) => ({
    matchId: firstMatch + i,
    arm: i < 8 ? "control" : "variant",
    videoId: `${i < 8 ? "c" : "v"}${i % 8}`,
  }));
const clearWinFetch = async (_matchId: number, videoId?: string): Promise<VideoMetrics | null> =>
  videoId ? video((videoId[0] === "c" ? 2 : 5) + Number(videoId.slice(1)) * 0.1) : null;

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

// --- verdictFor: the video floor first — under 8 a side is "not enough videos", whatever the
// impressions. 7 videos at 100,000 impressions each, 2% vs 9%: a pooled z in the hundreds.
{
  assert.equal(MIN_VIDEOS_PER_ARM, 8);
  const arms = await armsOf({
    control: Array(7).fill(video(2, 40, 100_000)),
    variant: Array(8).fill(video(9, 40, 100_000)),
  });
  assert.ok(
    twoProportionZ(arms[1]!.clicks, arms[1]!.impressions, arms[0]!.clicks, arms[0]!.impressions) > 100,
  );
  const v = verdictFor(baseExperiment(), arms);
  assert.equal(v.text, "not enough videos (7 with CTR in arm control, 8 needed)");
  assert.equal(v.winnerArm, null);
}

// --- verdictFor: then the 1,000-impression floor, regardless of metric ---------------------------
{
  const arms = await armsOf({
    control: around(2).map((c) => video(c, 40, 100)),
    variant: around(5).map((c) => video(c)),
  });
  const v = verdictFor(baseExperiment(), arms);
  assert.equal(v.text, "inconclusive (800 impressions in arm control)");
  assert.equal(v.winnerArm, null);
}

// --- verdictFor: CTR per video, both directions -------------------------------------------------
{
  // The variant clearly wins: every one of its 8 videos is ahead.
  const up = verdictFor(
    baseExperiment(),
    await armsOf({ control: around(4).map((c) => video(c)), variant: around(6).map((c) => video(c)) }),
  );
  assert.ok(
    up.text.startsWith(
      "variant wins on CTR (variant 6.00% vs control 4.00% per video, 8 vs 8 videos, p<0.001; pooled z=",
    ),
    up.text,
  );
  assert.equal(up.winnerArm, "variant");

  // The control clearly wins — nothing for `settle` to adopt even with adoptWinner on.
  const down = verdictFor(
    baseExperiment(),
    await armsOf({ control: around(6).map((c) => video(c)), variant: around(4).map((c) => video(c)) }),
  );
  assert.ok(down.text.startsWith("control wins on CTR (control 6.00% vs variant 4.00% per video"), down.text);
  assert.equal(down.winnerArm, null);

  // Interleaved values: the honest default.
  const flat = verdictFor(
    baseExperiment(),
    await armsOf({ control: around(5).map((c) => video(c)), variant: around(5.1).map((c) => video(c)) }),
  );
  assert.ok(
    flat.text.startsWith(
      "no verdict yet on CTR (variant 5.10% vs control 5.00% per video, 8 vs 8 videos, p=",
    ),
    flat.text,
  );
  assert.equal(flat.winnerArm, null);
}

// --- (a) Two arms from the same distribution: no verdict, and the false-winner rate stays under
// alpha over many seeded runs — where the pooled z-test the engine used before 15 Oct 2026 names a
// "winner" most of the time. Per-video CTR 5% ± 1.6 points (x1's own spread), impressions
// lognormal around 6,000, 8–12 videos a side.
{
  let seed = 1;
  const rand = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const normal = (): number => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
  const draw = (n: number): VideoMetrics[] =>
    [...Array(n)].map(() =>
      video(Math.max(0.5, 5 + 1.6 * normal()), 40, Math.round(6000 * Math.exp(0.8 * normal()))),
    );
  const RUNS = 400;
  let falseWinners = 0;
  let pooledWinners = 0;
  for (let r = 0; r < RUNS; r++) {
    const arms = await armsOf({ control: draw(8 + (r % 5)), variant: draw(8 + ((r * 3) % 5)) });
    const v = verdictFor(baseExperiment(), arms);
    if (r === 0) {
      assert.ok(v.text.startsWith("no verdict yet on CTR"), v.text);
      assert.equal(v.winnerArm, null);
    }
    if (/ wins on /.test(v.text)) falseWinners++;
    const z = twoProportionZ(arms[1]!.clicks, arms[1]!.impressions, arms[0]!.clicks, arms[0]!.impressions);
    if (Math.abs(z) >= 1.96) pooledWinners++;
  }
  assert.ok(falseWinners / RUNS <= ALPHA, `false-winner rate ${falseWinners / RUNS} over ${RUNS} runs`);
  assert.ok(pooledWinners / RUNS > 0.5, `the pooled z alone would have named ${pooledWinners} of ${RUNS}`);
}

// --- x1's own shape: a pooled z past 1.96 that the per-video values don't back ------------------
// 19utc's and 23utc's real per-video CTRs (the "why" report), twice over to clear the floor.
{
  const x1 = (ctrs: number[], imps: number[]) => [...ctrs, ...ctrs].map((c, i) => video(c, 40, imps[i % 4]!));
  const arms = await armsOf({
    control: x1([4.1, 7.3, 4.52, 8.01], [6947, 4301, 10202, 3395]),
    variant: x1([3.59, 6.84, 5.23, 5.01], [14382, 6886, 10289, 5366]),
  });
  const z = twoProportionZ(arms[1]!.clicks, arms[1]!.impressions, arms[0]!.clicks, arms[0]!.impressions);
  assert.ok(z < -1.96, `the pooled z alone would call it (z=${z})`);
  const v = verdictFor(baseExperiment(), arms);
  assert.ok(v.text.startsWith("no verdict yet on CTR"), v.text);
  assert.ok(v.text.includes(`pooled z=${z.toFixed(2)}`), "the pooled z is still reported");
}

// --- verdictFor: average view % per video, the same test ----------------------------------------
{
  const metric = baseExperiment({ metric: "average view %" });
  const avp = (pcts: number[]) => pcts.map((p) => video(5, p));
  // Fewer than 8 videos on one side: not enough, however far apart the means are.
  const thin = verdictFor(metric, await armsOf({ control: avp([10, 90]), variant: avp(around(85)) }));
  assert.equal(thin.text, "not enough videos (2 with average view % in arm control, 8 needed)");
  assert.equal(thin.winnerArm, null);

  const clear = verdictFor(metric, await armsOf({ control: avp(around(42)), variant: avp(around(52)) }));
  assert.ok(
    clear.text.startsWith("variant wins on average view % (variant 52.0% vs control 42.0% per video"),
    clear.text,
  );
  assert.equal(clear.winnerArm, "variant");

  // Wide, overlapping ranges: no verdict yet.
  const overlap = verdictFor(
    metric,
    await armsOf({
      control: avp([20, 30, 40, 50, 60, 70, 45, 35]),
      variant: avp([25, 35, 45, 55, 65, 75, 40, 30]),
    }),
  );
  assert.ok(overlap.text.startsWith("no verdict yet on average view %"), overlap.text);
  assert.equal(overlap.winnerArm, null);
  assert.ok(!overlap.text.includes("pooled z"), "the pooled z is a CTR number only");
}

// --- verdictFor: subscribers per 1,000 views, per video; an unknown metric decides nothing -------
{
  const subs = (n: number[]) => n.map((k) => video(5, 40, 5000, k));
  const v = verdictFor(
    baseExperiment({ metric: "subscribers per 1,000 views" }),
    await armsOf({ control: subs([0, 1, 0, 1, 1, 0, 2, 1]), variant: subs([4, 5, 6, 4, 5, 7, 5, 6]) }),
  );
  assert.ok(
    v.text.startsWith("variant wins on subs per 1,000 views (variant 5.25 vs control 0.75 per video"),
    v.text,
  );
  assert.equal(v.winnerArm, "variant");

  const unknown = verdictFor(
    baseExperiment({ metric: "engagedViews" }),
    await armsOf({
      control: around(2).map((c) => video(c, 30)),
      variant: around(9).map((c) => video(c, 60)),
    }),
  );
  assert.equal(unknown.text, 'numbers only (no per-video rule for "engagedViews")');
  assert.equal(unknown.winnerArm, null);
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
  assert.deepEqual(
    control.perVideo.map((v) => [v.matchId, v.clicks]),
    [
      [1, 50],
      [2, 60],
    ],
    "each video's own metrics are kept, one row a video",
  );
  assert.equal(control.impressions, 2000);
  assert.equal(control.clicks, 110);
  // View-weighted mean: (40*100 + 60*200) / 300 = 53.33...
  assert.ok(Math.abs(control.avgViewPercentage - (40 * 100 + 60 * 200) / 300) < 1e-9);
  assert.equal(totals.find((a) => a.arm === "variant")!.videos, 0);
}

// --- armTotalsFor: a video with no views yet has no retention to count ------------------------
// (scheduled, or inside Analytics' lag) — its 0% neither drags its arm down nor meets the floor.
{
  const m = (pct: number, views: number): VideoMetrics => ({
    impressions: 1000,
    clicks: 30,
    views,
    engagedViews: 0,
    averageViewPercentage: pct,
    subscribersGained: 0,
  });
  // Control: matches 0–6 and 99 near 40%, 7 and 8 at zero views; variant: 100–107, every one ahead.
  const pct = (matchId: number) => (matchId >= 100 ? 50 + matchId - 100 : 40 + matchId * 0.1);
  const fetch = async (matchId: number) => (matchId === 7 || matchId === 8 ? m(0, 0) : m(pct(matchId), 100));
  const metric = { metric: "average view %" };
  const vids = (ids: number[], arm: string) => ids.map((matchId) => ({ matchId, arm }));
  const variant = vids([100, 101, 102, 103, 104, 105, 106, 107], "variant");

  const thin = baseExperiment({
    ...metric,
    videos: [...vids([0, 1, 2, 3, 4, 5, 6, 7, 8], "control"), ...variant],
  });
  const thinTotals = await armTotalsFor(thin, fetch);
  assert.equal(thinTotals.find((a) => a.arm === "control")!.avgViewPercentages.length, 7);
  assert.equal(thinTotals.find((a) => a.arm === "control")!.videos, 9, "`videos` still counts every one");
  assert.equal(
    verdictFor(thin, thinTotals).text,
    "not enough videos (7 with average view % in arm control, 8 needed)",
  );

  // 8 real a side, plus a zero-view video in the leading arm: it still wins.
  const lead = baseExperiment({
    ...metric,
    videos: [
      ...vids([0, 1, 2, 3, 4, 5, 6], "control"),
      { matchId: 99, arm: "control" },
      ...variant,
      { matchId: 7, arm: "variant" },
    ],
  });
  const v = verdictFor(lead, await armTotalsFor(lead, fetch));
  assert.equal(v.winnerArm, "variant", v.text);
}

// --- evaluateExperiments: a corrupt .experiments.json is never overwritten ----------------------
// — not with an empty file, not with an `evaluatedOn` stamp; the first tick after the fix runs.
{
  const file = path.join(media, ".experiments.json");
  const exp = baseExperiment({ id: "corrupt-file", videos: [{ matchId: 1, arm: "control" }] });
  const corrupt = JSON.stringify({ experiments: [exp], schedule: [] }).replace(/}$/, ",}");
  writeFileSync(file, corrupt);
  const realError = console.error;
  console.error = () => {};
  try {
    await evaluateExperiments({ fetch: async () => null, now: () => Date.parse("2026-10-09T04:15:00Z") });
    assert.equal(readFileSync(file, "utf8"), corrupt, "corrupt at the first read: left byte-for-byte");

    // Valid at the first read, corrupted while the metrics were being fetched: the write is skipped.
    writeExperiments({ experiments: [exp], schedule: [] });
    await evaluateExperiments({
      fetch: async () => {
        writeFileSync(file, corrupt);
        return null;
      },
      now: () => Date.parse("2026-10-09T04:15:00Z"),
    });
    assert.equal(readFileSync(file, "utf8"), corrupt, "corrupt at the final read: left byte-for-byte");
  } finally {
    console.error = realError;
  }
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
  assert.equal(after.verdict, "not enough videos (1 with CTR in arm control, 8 needed)");
  assert.equal(after.decision, undefined);
  assert.ok(after.evaluatedAt);
}

// --- evaluateExperiments: adoption and revert decisions at `end` -------------------------------
{
  const fetch = clearWinFetch;

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
    videos: clearWin(200),
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
    videos: clearWin(300),
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

  // The next day fails the same way: two in a row reaches needsHuman, the same as any other
  // failure (the try used to clear yesterday's failure before settle() threw).
  console.error = () => {};
  try {
    await evaluateExperiments({ fetch, now: () => Date.parse("2026-10-09T04:15:00Z") });
  } finally {
    console.error = realError;
  }
  const day2 = readExperiments().experiments.find((e) => e.id === "bad-key")!;
  assert.ok(day2.needsHuman?.includes("notARealSetting"), `needsHuman on day two (got ${day2.needsHuman})`);
  assert.equal(day2.status, "running");
  assert.equal(day2.lastEvalFailure?.date, "2026-10-09");
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

// --- twoProportionZ: zero clicks on both sides is a zero pooled variance, not a divide-by-zero --
// (nA, nB > 0 here, unlike the "nothing to divide by" case above, which is nA<=0/nB<=0).
assert.equal(twoProportionZ(0, 1000, 0, 1000), 0, "pooled proportion 0 — se is 0, returns 0 not NaN");

// --- verdictFor: MIN_IMPRESSIONS's own edge is "enough", not "under" -----------------------------
{
  const eight = around(2).map((c) => video(c, 40, 125)); // 8 x 125 = 1,000 a side
  const v = verdictFor(baseExperiment(), await armsOf({ control: eight, variant: eight }));
  assert.ok(v.text.startsWith("no verdict yet"), `exactly 1,000 is enough, got "${v.text}"`);
}

// --- ctrVerdict: three arms — the most significant non-control arm wins, not just the first -----
{
  const arms = await armsOf({
    control: around(2).map((c) => video(c)),
    a: around(2.5).map((c) => video(c)), // overlaps the control — no verdict on its own
    b: around(5).map((c) => video(c)), // clearly the biggest gap
  });
  const three = baseExperiment({ arms: [{ name: "control" }, { name: "a" }, { name: "b" }] });
  const v = verdictFor(three, arms);
  assert.ok(v.text.startsWith("b wins on CTR"), `expected b to win, got "${v.text}"`);
  assert.equal(v.winnerArm, "b");
  // Two comparisons against one control: each needs p < ALPHA / 2 (Bonferroni), not ALPHA.
  const lone = verdictFor(three, [arms[0]!, arms[1]!, { ...arms[0]!, arm: "b" }]);
  assert.ok(lone.text.startsWith("no verdict yet"), lone.text);
}

// --- settle(): a winning arm whose lever is `slot`, not `settings`, is still a decision ----------
// with nothing for saveSettings to apply — the doc comment's own "nothing to apply" case.
{
  const exp = baseExperiment({
    id: "slot-only-winner",
    end: "2026-10-08",
    adoptWinner: true,
    arms: [
      { name: "control", slot: { rankedHoursUtc: [19] } },
      { name: "variant", slot: { rankedHoursUtc: [21] } },
    ],
    videos: clearWin(400),
  });
  writeExperiments({ experiments: [exp], schedule: [] });
  const sentinel = config.introSec;
  await evaluateExperiments({ fetch: clearWinFetch, now: () => Date.parse("2026-10-08T04:15:00Z") });
  assert.equal(config.introSec, sentinel, "a slot-only arm has no settings — saveSettings is never called");
  const after = readExperiments().experiments.find((e) => e.id === "slot-only-winner")!;
  assert.equal(after.status, "done");
  assert.ok(after.decision?.startsWith("adopted variant:"), after.decision);
}

// --- enrolVideos: a corrupt experiment-arm.json is logged and skipped, not a crash --------------
// — other match directories, including ones after it in the scan, are still enrolled.
{
  mkdirSync(matchDir(930001), { recursive: true });
  writeFileSync(path.join(matchDir(930001), "experiment-arm.json"), "{ not json");
  fixtureArmFile(930002, "corrupt-skip", "control");

  const exp = baseExperiment({ id: "corrupt-skip", end: "2026-10-20", videos: [] });
  writeExperiments({ experiments: [exp], schedule: [] });
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    await evaluateExperiments({
      fetch: async () => null,
      now: () => Date.parse("2026-10-08T04:15:00Z"),
    });
  } finally {
    console.error = realError;
  }
  const after = readExperiments().experiments.find((e) => e.id === "corrupt-skip")!;
  assert.deepEqual(
    after.videos.map((v) => v.matchId),
    [930002],
    "the corrupt directory contributed nothing, the next one was still enrolled",
  );
  assert.ok(
    logged.some((l) => String(l[0]).includes("experiment-arm.json") && String(l[0]).includes("unreadable")),
    `the corrupt file was logged (got ${JSON.stringify(logged)})`,
  );
}

// --- enrolVideos: a slot experiment falls back to uploadedAt when publishAt is null -------------
{
  await fixtureUpload(940001, { videoId: "sv5", publishAt: null, uploadedAt: "2026-10-08T19:30:00Z" });
  const exp = baseExperiment({
    id: "slot-no-publishat",
    end: "2026-10-20",
    controlArm: "only-arm",
    arms: [{ name: "only-arm" }],
    videos: [],
  });
  writeExperiments({
    experiments: [exp],
    schedule: [{ date: "2026-10-08", experimentId: "slot-no-publishat", arm: "only-arm" }],
  });
  await evaluateExperiments({
    fetch: async () => ({
      impressions: 10,
      clicks: 1,
      views: 10,
      engagedViews: 4,
      averageViewPercentage: 40,
      subscribersGained: 0,
    }),
    now: () => Date.parse("2026-10-08T04:15:00Z"),
  });
  const after = readExperiments().experiments.find((e) => e.id === "slot-no-publishat")!;
  assert.equal(
    after.videos.find((v) => v.matchId === 940001)?.arm,
    "only-arm",
    "uploadedAt's own date was used since publishAt was null",
  );
}

// --- The live CTR read sums every daily report since publish, not the newest day alone ---------
// channel_reach_basic_a1 writes one CSV a day; the newest (13 Oct) reverses the two days before it.
// A row dated before the publish day (10 Oct) is dropped — "20261010" vs "2026-10-11" used to
// compare as strings and pass. Token and every Google host faked: nothing leaves the process.
{
  const realFetch = globalThis.fetch;
  const tokenFile = path.join(media, "fake-token.json");
  writeFileSync(tokenFile, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }));
  process.env.YOUTUBE_TOKEN_FILE = tokenFile;
  config.youtubeReportingJobId = "fake-job";
  const days: Record<string, string> = {
    "20261010": "vA,5000,0.00\nvB,5000,0.50",
    "20261011": "vA,1000,0.10\nvB,1000,0.02",
    "20261012": "vA,1000,0.10\nvB,1000,0.02",
    "20261013": "vA,1000,0.02\nvB,1000,0.10",
  };
  const json = (b: unknown): Response => new Response(JSON.stringify(b));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/"))
      return json({ access_token: "tok", expires_in: 3600 });
    if (url.startsWith("https://youtubereporting.googleapis.com/v1/jobs/fake-job/reports?"))
      return json({
        reports: Object.keys(days).map((d) => ({
          id: d,
          downloadUrl: `https://fake.invalid/csv/${d}`,
          endTime: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T23:59:59Z`,
          createTime: "2026-10-14T00:00:00Z",
        })),
      });
    if (url.startsWith("https://fake.invalid/csv/")) {
      const d = url.split("/").pop()!;
      const body = days[d]!.split("\n").map((l) => `${d},UC,${l}`);
      return new Response(
        [
          "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr",
          ...body,
        ].join("\n"),
      );
    }
    if (url.startsWith("https://youtubeanalytics.googleapis.com/")) return json({ rows: [[100, 50, 40, 1]] });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    for (const [id, videoId] of [
      [960001, "vA"],
      [960002, "vB"],
    ] as const)
      await fixtureUpload(id, {
        videoId,
        uploadedAt: "2026-10-10T12:00:00Z",
        publishAt: "2026-10-11T00:00:00Z",
      });
    writeExperiments({
      experiments: [
        baseExperiment({
          id: "ctr-days",
          start: "2026-10-11",
          end: "2026-10-30",
          videos: [
            { matchId: 960001, arm: "control", videoId: "vA" },
            { matchId: 960002, arm: "variant", videoId: "vB" },
          ],
        }),
      ],
      schedule: [],
    });
    await evaluateExperiments({ now: () => Date.parse("2026-10-15T04:15:00Z") });
    const e = readExperiments().experiments.find((x) => x.id === "ctr-days")!;
    const arms = (e.result as { arms: ArmTotals[] }).arms;
    assert.deepEqual(
      arms.map((a) => [a.arm, a.clicks, a.impressions]),
      [
        ["control", 220, 3000],
        ["variant", 140, 3000],
      ],
      "11–13 Oct summed; 10 Oct, before publish, dropped",
    );
    assert.equal(e.verdict, "not enough videos (1 with CTR in arm control, 8 needed)");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.YOUTUBE_TOKEN_FILE;
  }
}

console.log("experimentsEvaluator: all checks passed");
