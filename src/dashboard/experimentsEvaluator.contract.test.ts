// Contract test for the experiment engine's evaluator, written from the docs, not the code.
// Run: npx tsx src/dashboard/experimentsEvaluator.contract.test.ts
//
// What the docs promise (CLAUDE.md "The experiment engine runs between-video A/B tests
// unattended"; handbook/claude-md-reference.md, same bullet; handbook/knowledge/experiments.md
// "How tests are run"):
//
//  1. Evaluates every RUNNING "between" experiment, once a UTC day — a planned or done one is not
//     re-read or re-settled, and "tc" entries are never touched.
//  2. One experiment's read failing does not stop the others being evaluated.
//  3. The video is the unit: any arm with fewer than 8 videos with the metric is "not enough
//     videos", whatever the impressions; then any arm under 1,000 impressions (every video of the
//     arm summed) is "inconclusive" — never a guess, regardless of metric.
//  4. The decision is a two-sided permutation test on per-video values, p < 0.05; the pooled
//     two-proportion z is reported, never decides alone; anything short is "no verdict yet".
//  5. Average view % runs the same test on per-video values, counting only videos with views, and
//     the per-arm view-weighted mean still lands in `result`; subs per 1,000 views likewise.
//     Verdicts are per the experiment's own metric; a metric with no per-video rule decides nothing.
//  6. At `end`, a winner with `adoptWinner` becomes the new default (saveSettings — the config file
//     itself, so it survives a restart), and the decision is written with its numbers.
//  7. Otherwise (no winner, inconclusive, the control winning, or adoptWinner off) the control
//     arm's settings are reapplied, in case a render arm left something else live mid-run.
//  8. Two evaluation failures on consecutive UTC days set `needsHuman` (and it reaches the "Needs
//     you" source, `needsHumanExperiments`); a success in between, or a day with no evaluation at
//     all, restarts the count.
//  9. A failure leaves the experiment as it was (still running, last verdict kept).
// 10. enrolVideos is idempotent by matchId, never duplicates, never removes — a hand-listed video
//     whose directory is gone stays.
// 11. Render experiments enrol from a match's own experiment-arm.json, with videoId from
//     youtube.json once the match has one ("filled in by the evaluator ... when absent").
// 12. Slot experiments enrol long-form uploads (youtube.json, never a Short) by publish time, into
//     the arm whose own rankedHoursUtc is exactly that publish hour, else the entry's own arm.
// 13. Only a slot experiment enrols by publish date — a long-form published on a render-only date
//     with no experiment-arm.json of its own is not a member of that render experiment.
// 14. An arm file naming a "tc" experiment never enrols into it.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Experiment, ScheduleEntry } from "./experiments.js";
import type { ArmTotals, VideoMetrics } from "./experimentsEvaluator.js";
import type { UploadRecord } from "../youtube/youtubeStore.js";

// CONFIG_PATH is resolved once, at config.js's first import, from cwd — so settle()'s saveSettings
// writes into this temp cwd's own mcsr-vid.config.json, never the lab's (same recipe as
// experimentsEvaluator.test.ts).
const cwdDir = mkdtempSync(path.join(tmpdir(), "mcsr-evalc-cwd-"));
const firstMedia = mkdtempSync(path.join(tmpdir(), "mcsr-evalc-media-"));
/** Every temp dir this test makes, removed at the end. */
const scratch: string[] = [cwdDir, firstMedia];
process.chdir(cwdDir);
delete process.env.MCSR_CONFIG;
const configFile = path.join(cwdDir, "mcsr-vid.config.json");
writeFileSync(configFile, JSON.stringify({ mediaDir: firstMedia }));

const { config, matchDir } = await import("../config.js");
const { readExperiments, writeExperiments, writeExperimentArmFile, needsHumanExperiments } =
  await import("./experiments.js");
const { evaluateExperiments, permutationP, twoProportionZ, verdictFor } =
  await import("./experimentsEvaluator.js");
const { saveSettings } = await import("./settings.js");
const { writeUpload } = await import("../youtube/youtubeStore.js");

// Real match ids (src/fixtures) as the match directories, so enrolment scans what a real mediaDir holds.
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const REAL_IDS = readdirSync(fixturesDir)
  .filter((f) => /^match-\d+\.json$/.test(f))
  .map((f) => (JSON.parse(readFileSync(path.join(fixturesDir, f), "utf8")) as { id: number }).id);
assert.ok(REAL_IDS.length >= 6, "the fixtures hold enough real matches for these checks");
const [M1, M2, M3, M4, M5, M6] = REAL_IDS as [number, number, number, number, number, number];

/** Keeps the suite green while a doc/code mismatch waits for triage — prints it instead. */
async function deviation(clause: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

/** Each block gets its own mediaDir: enrolment scans every match directory, so blocks must not see each other's. */
function freshMedia(): string {
  config.mediaDir = mkdtempSync(path.join(tmpdir(), "mcsr-evalc-media-"));
  scratch.push(config.mediaDir);
  return config.mediaDir;
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    return { value: await fn(), logged };
  } finally {
    console.error = real;
  }
}

const exp = (over: Partial<Experiment> = {}): Experiment => ({
  id: "e",
  kind: "between",
  hypothesis: "h",
  variable: "v",
  metric: "ctr",
  controlArm: "control",
  arms: [{ name: "control" }, { name: "variant" }],
  videos: [],
  start: "2026-10-01",
  end: "2026-10-30",
  status: "running",
  ...over,
});

const put = (experiments: Experiment[], schedule: ScheduleEntry[] = []): void =>
  writeExperiments({ experiments, schedule });

const m = (impressions: number, clicks: number, pct = 40, views = 1000): VideoMetrics => ({
  impressions,
  clicks,
  views,
  engagedViews: Math.round(views / 2),
  averageViewPercentage: pct,
  subscribersGained: 0,
});

/** ArmTotals the way armTotalsFor builds them, from one arm's own videos, for calling verdictFor directly. */
const totals = (arm: string, vids: VideoMetrics[]): ArmTotals => {
  const sum = (k: keyof VideoMetrics) => vids.reduce((a, v) => a + v[k], 0);
  return {
    arm,
    videos: vids.length,
    impressions: sum("impressions"),
    clicks: sum("clicks"),
    views: sum("views"),
    engagedViews: sum("engagedViews"),
    subscribersGained: sum("subscribersGained"),
    avgViewPercentage: sum("views")
      ? vids.reduce((a, v) => a + v.averageViewPercentage * v.views, 0) / sum("views")
      : 0,
    avgViewPercentages: vids.filter((v) => v.views > 0).map((v) => v.averageViewPercentage),
    perVideo: vids.map((v, matchId) => ({ matchId, ...v })),
  };
};
/** One video per CTR (%), each on `impressions`. */
const ctrs = (rates: number[], impressions = 10_000): VideoMetrics[] =>
  rates.map((r) => m(impressions, Math.round((impressions * r) / 100)));
/** One video per average view %. */
const avps = (pcts: number[]): VideoMetrics[] => pcts.map((p) => m(5000, 100, p));
/** 8 values evenly around `center`, 0.2 apart. */
const eight = (center: number): number[] => [...Array(8)].map((_, i) => center + (i - 3.5) * 0.2);

const upload = (
  videoId: string,
  publishAt: string | null,
  uploadedAt = "2026-10-01T04:00:00Z",
): UploadRecord => ({
  videoId,
  uploadedAt,
  publishAt,
  privacyStatus: publishAt ? "private" : "public",
  thumbnailVariant: null,
  title: "t",
});

const armFile = (matchId: number, experimentId: string, arm: string): void => {
  mkdirSync(matchDir(matchId), { recursive: true });
  writeFileSync(
    path.join(matchDir(matchId), "experiment-arm.json"),
    JSON.stringify({ date: "2026-10-08", experimentId, arm, settings: {} }),
  );
};

const at = (iso: string) => () => Date.parse(iso);
const one = (id: string): Experiment => readExperiments().experiments.find((e) => e.id === id)!;
const configOnDisk = (): Record<string, unknown> =>
  JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;

// --- 1. Only RUNNING between experiments are read; planned and done ones are left exactly as they are
{
  freshMedia();
  const planned = exp({
    id: "planned",
    status: "planned",
    videos: [{ matchId: 1, arm: "control", videoId: "p1" }],
  });
  // A done experiment past its end, adoptWinner on, whose numbers would now favour the variant:
  // re-settling it would push the variant's setting live again days after the operator moved on.
  const done = exp({
    id: "done",
    status: "done",
    end: "2026-10-05",
    adoptWinner: true,
    arms: [
      { name: "control", settings: { introSec: 3 } },
      { name: "variant", settings: { introSec: 5 } },
    ],
    videos: [
      { matchId: 2, arm: "control", videoId: "d2" },
      { matchId: 3, arm: "variant", videoId: "d3" },
    ],
    decision: "kept control: no difference on CTR",
  });
  const running = exp({ id: "running", videos: [{ matchId: 4, arm: "control", videoId: "r4" }] });
  put([planned, done, running]);
  const introBefore = config.introSec;
  const asked: number[] = [];
  await evaluateExperiments({
    fetch: async (matchId) => {
      asked.push(matchId);
      return matchId === 3 ? m(5000, 500) : m(5000, 100);
    },
    now: at("2026-10-08T04:15:00Z"),
  });
  // The rule: only a running experiment gets fresh numbers — the others' videos are not even read.
  assert.deepEqual(asked, [4], "only the running experiment's videos are fetched");
  assert.deepEqual(one("planned"), planned, "a planned experiment is carried through untouched");
  assert.deepEqual(one("done"), done, "a done experiment is never re-settled");
  assert.equal(config.introSec, introBefore, "and nothing it names is pushed back into the settings");
  assert.ok(one("running").evaluatedAt, "the running one was evaluated");
}

// --- 2. One experiment's read failing does not stop the others ---------------------------------------
{
  freshMedia();
  put([
    exp({ id: "broken", videos: [{ matchId: 10, arm: "control", videoId: "b10" }] }),
    exp({ id: "healthy", videos: [{ matchId: 11, arm: "control", videoId: "h11" }] }),
  ]);
  await quiet(() =>
    evaluateExperiments({
      fetch: async (matchId) => {
        if (matchId === 10) throw new Error("Analytics API 500");
        return m(2000, 40);
      },
      now: at("2026-10-08T04:15:00Z"),
    }),
  );
  // "evaluates every running experiment": a try/catch around the whole loop would starve the rest.
  assert.ok(one("broken").lastEvalFailure, "the failing one remembers its failure");
  assert.ok(one("healthy").evaluatedAt, "the healthy one still got its numbers the same tick");
}

// --- 3. The video floor, then the 1,000-impression floor: per arm, every metric ------------------
{
  const retention = exp({ metric: "average view %" });
  // Total dominance, 3 a side, 5,000 impressions each: still "not enough videos".
  const few = verdictFor(retention, [
    totals("control", avps([30, 31, 32])),
    totals("variant", avps([60, 61, 62])),
  ]);
  assert.equal(few.text, "not enough videos (3 with average view % in arm control, 8 needed)");
  assert.equal(few.winnerArm, null, "not enough videos names no winner to adopt");
  // 7 vs 8 at 100,000 impressions a video and 2% vs 9%: the impressions don't buy a verdict.
  const huge = verdictFor(exp(), [
    totals("control", ctrs(Array(7).fill(2), 100_000)),
    totals("variant", ctrs(Array(8).fill(9), 100_000)),
  ]);
  assert.ok(huge.text.startsWith("not enough videos (7 with CTR"), huge.text);

  // 8 a side, total dominance, one arm at 999 impressions: still a guess.
  const sized = (impressions: number[], p: number) => impressions.map((i, k) => m(i, 10, p + k));
  const under = verdictFor(retention, [
    totals("control", sized([125, 125, 125, 125, 125, 125, 125, 124], 30)),
    totals("variant", sized(Array(8).fill(5000), 60)),
  ]);
  assert.ok(
    under.text.startsWith("inconclusive (999 impressions"),
    `the floor applies to retention too, got "${under.text}"`,
  );
  assert.equal(under.winnerArm, null, "an inconclusive verdict names no winner to adopt");

  // Exactly 1,000 is enough ("under 1,000" is inconclusive, 1,000 is not).
  const atFloor = verdictFor(retention, [
    totals("control", sized(Array(8).fill(125), 30)),
    totals("variant", sized(Array(8).fill(125), 60)),
  ]);
  assert.equal(atFloor.winnerArm, "variant", atFloor.text);

  // Per ARM, not per video: eight 125-impression videos are a 1,000-impression arm.
  freshMedia();
  const vids = (arm: string, ids: number[]) =>
    ids.map((matchId) => ({ matchId, arm, videoId: `v${matchId}` }));
  const ids = (from: number) => [...Array(8)].map((_, i) => from + i);
  put([
    exp({ id: "pooled", videos: [...vids("control", ids(100)), ...vids("variant", ids(110))] }),
    exp({ id: "thin", videos: [...vids("control", ids(200)), ...vids("variant", ids(210))] }),
  ]);
  // A ~1% vs ~10% CTR gap — huge — on 125- and 100-impression videos.
  const fetch = async (matchId: number) => {
    const size = matchId < 200 ? 125 : 100;
    return m(size, Math.round(size * (matchId % 20 >= 10 ? 0.1 : 0.01)));
  };
  await evaluateExperiments({ fetch, now: at("2026-10-08T04:15:00Z") });
  assert.ok(one("pooled").verdict?.startsWith("variant wins on CTR"), one("pooled").verdict);
  // 8 x 100 = 800 per arm: the same gap is still "inconclusive", the 1 Oct post-mortem's lesson.
  assert.ok(one("thin").verdict?.startsWith("inconclusive (800 impressions"), one("thin").verdict);
  const result = one("pooled").result as { arms: ArmTotals[] };
  assert.deepEqual(
    result.arms.map((a) => [a.arm, a.impressions, a.clicks, a.perVideo.length]),
    [
      ["control", 1000, 8, 8],
      ["variant", 1000, 104, 8],
    ],
    "the numbers land in `result`, summed per arm, with every video's own row",
  );
}

// --- 4. A permutation test on per-video values at p < 0.05; the pooled z is only reported --------
{
  // The exact two-sided permutation p, every one of the 12,870 ways to split 16 videos 8/8 —
  // written out independently of the module's seeded sampler.
  const exactP = (a: number[], b: number[]): number => {
    const all = [...a, ...b];
    const total = all.reduce((x, y) => x + y, 0);
    const gap = (s: number) => Math.abs(s / a.length - (total - s) / b.length);
    const observed = gap(a.reduce((x, y) => x + y, 0));
    let hit = 0;
    let count = 0;
    const walk = (from: number, k: number, s: number): void => {
      if (k === a.length) {
        count++;
        if (gap(s) >= observed - 1e-9) hit++;
        return;
      }
      for (let i = from; i <= all.length - (a.length - k); i++) walk(i + 1, k + 1, s + all[i]!);
    };
    walk(0, 0, 0);
    return hit / count;
  };
  const control = [3, 4, 5, 6, 7, 8, 9, 10];
  const shifted = (d: number) => control.map((c) => c + d);
  // A 2.5-point shift is p = 0.069 exactly; 3.5 points is p = 0.016. The sampled p agrees.
  assert.ok(
    exactP(shifted(2.5), control) > 0.06 && exactP(shifted(3.5), control) < 0.02,
    "the fixture straddles 0.05",
  );
  assert.ok(Math.abs(permutationP(shifted(2.5), control) - exactP(shifted(2.5), control)) < 0.01);
  assert.ok(Math.abs(permutationP(shifted(3.5), control) - exactP(shifted(3.5), control)) < 0.01);
  assert.equal(
    permutationP(shifted(3.5), control),
    permutationP(shifted(3.5), control),
    "seeded: the same p every run",
  );

  const close = [totals("control", ctrs(control)), totals("variant", ctrs(shifted(2.5)))];
  const notYet = verdictFor(exp(), close);
  assert.ok(
    notYet.text.startsWith(
      "no verdict yet on CTR (variant 9.00% vs control 6.50% per video, 8 vs 8 videos, p=0.0",
    ),
    notYet.text,
  );
  assert.equal(notYet.winnerArm, null);
  // ...while the pooled z on the same numbers is far past 1.96: reported, not decisive.
  const z = twoProportionZ(close[1]!.clicks, close[1]!.impressions, close[0]!.clicks, close[0]!.impressions);
  assert.ok(z > 1.96, `pooled z=${z}`);
  assert.ok(notYet.text.endsWith(`pooled z=${z.toFixed(2)})`), notYet.text);
  const winner = verdictFor(exp(), [totals("control", ctrs(control)), totals("variant", ctrs(shifted(3.5)))]);
  assert.ok(
    winner.text.startsWith(
      "variant wins on CTR (variant 10.00% vs control 6.50% per video, 8 vs 8 videos, p=0.0",
    ),
    winner.text,
  );
  assert.equal(winner.winnerArm, "variant");

  // The metric name is matched case-blind: "CTR" in a hand-edited file is the same rule.
  const upper = verdictFor(exp({ metric: "CTR" }), [
    totals("control", ctrs(control)),
    totals("variant", ctrs(shifted(3.5))),
  ]);
  assert.equal(upper.winnerArm, "variant", upper.text);

  // The textbook pooled two-proportion z, written out independently of the module.
  const zRef = (c1: number, n1: number, c2: number, n2: number): number => {
    const p = (c1 + c2) / (n1 + n2);
    return (c1 / n1 - c2 / n2) / Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  };
  assert.ok(Math.abs(twoProportionZ(350, 10000, 300, 10000) - zRef(350, 10000, 300, 10000)) < 1e-12);
  assert.ok(
    Math.abs(twoProportionZ(300, 10000, 350, 10000) + twoProportionZ(350, 10000, 300, 10000)) < 1e-12,
    "antisymmetric: swapping the arms flips the sign, not the size",
  );
}

// --- 5. Average view % and subs per 1,000 views: the same per-video test -------------------------
{
  const retention = exp({ metric: "average view %" });
  // The control ahead names the control, but there is nothing to adopt.
  const controlAhead = verdictFor(retention, [
    totals("control", avps(eight(61))),
    totals("variant", avps(eight(41))),
  ]);
  assert.ok(
    controlAhead.text.startsWith("control wins on average view % (control 61.0% vs variant 41.0% per video"),
    controlAhead.text,
  );
  assert.equal(controlAhead.winnerArm, null);
  // A video with no views has no retention: 8 enrolled, one unseen, is 7 with the metric.
  const unseen = verdictFor(retention, [
    totals("control", [...avps(eight(41)).slice(0, 7), m(0, 0, 0, 0)]),
    totals("variant", avps(eight(61))),
  ]);
  assert.ok(unseen.text.startsWith("not enough videos (7 with average view %"), unseen.text);

  const subs = (k: number[]) => k.map((n) => ({ ...m(5000, 100, 40, 1000), subscribersGained: n }));
  const perView = verdictFor(exp({ metric: "subs per view" }), [
    totals("control", subs([0, 1, 0, 1, 1, 0, 2, 1])),
    totals("variant", subs([4, 5, 6, 4, 5, 7, 5, 6])),
  ]);
  assert.ok(perView.text.startsWith("variant wins on subs per 1,000 views"), perView.text);

  // The reported mean is VIEW-weighted, through the real evaluation path.
  freshMedia();
  put([
    exp({
      id: "weighted",
      metric: "average view %",
      videos: [
        { matchId: 40, arm: "control", videoId: "w40" },
        { matchId: 41, arm: "control", videoId: "w41" },
        { matchId: 42, arm: "control", videoId: "w42" },
      ],
    }),
  ]);
  const byMatch = new Map([
    [40, m(2000, 40, 40, 100)],
    [41, m(2000, 40, 60, 300)],
    [42, m(2000, 40, 50, 100)],
  ]);
  await evaluateExperiments({
    fetch: async (id) => byMatch.get(id) ?? null,
    now: at("2026-10-08T04:15:00Z"),
  });
  const control = (one("weighted").result as { arms: ArmTotals[] }).arms.find((a) => a.arm === "control")!;
  // (40*100 + 60*300 + 50*100) / 500 = 54, not the plain mean 50.
  assert.ok(
    Math.abs(control.avgViewPercentage - 54) < 1e-9,
    `view-weighted mean, got ${control.avgViewPercentage}`,
  );
}

// Verdicts follow the experiment's own metric — handbook/knowledge/experiments.md "Verdicts".
{
  // An engaged-views experiment whose videos happen to dominate on average view % and CTR.
  const v = verdictFor(exp({ metric: "engagedViews" }), [
    totals("control", avps(eight(31))),
    totals("variant", avps(eight(61))),
  ]);
  assert.equal(v.winnerArm, null, `an engaged-views experiment was decided on another metric: "${v.text}"`);
  assert.equal(v.text, 'numbers only (no per-video rule for "engagedViews")');
}

// --- 6/7. At end: adopt the winner (persisted), or reapply the control --------------------------------
{
  // 8 control videos (500–507) and 8 variant videos (510–517), each arm around its own CTR.
  const ctrMetrics = (controlCtr: number, variantCtr: number) => async (matchId: number) => {
    const rate = eight(matchId < 510 ? controlCtr : variantCtr)[matchId % 10]!;
    return m(5000, Math.round(50 * rate));
  };
  const ended = (id: string, over: Partial<Experiment> = {}) =>
    exp({
      id,
      end: "2026-10-08",
      arms: [
        { name: "control", settings: { introSec: 3 } },
        { name: "variant", settings: { introSec: 5 } },
      ],
      videos: [...Array(16)].map((_, i) => ({
        matchId: i < 8 ? 500 + i : 502 + i,
        arm: i < 8 ? "control" : "variant",
        videoId: `x${i}`,
      })),
      ...over,
    });

  // 6. A winner with adoptWinner becomes the default — in the config FILE, so a restart keeps it.
  freshMedia();
  saveSettings({ introSec: 6 }); // whatever the box had before
  put([ended("adopt", { adoptWinner: true })]);
  await evaluateExperiments({ fetch: ctrMetrics(2, 5), now: at("2026-10-08T04:15:00Z") });
  assert.equal(config.introSec, 5, "the winning arm's setting is live");
  assert.equal(configOnDisk().introSec, 5, "and written to mcsr-vid.config.json, so it is the new default");
  assert.equal(one("adopt").status, "done");
  // "the decision is written with its numbers"
  assert.ok(
    /^adopted variant: variant wins on CTR \(variant 5\.00% vs control 2\.00% per video, 8 vs 8 videos, p<0\.001; pooled z=/.test(
      one("adopt").decision ?? "",
    ),
    one("adopt").decision,
  );

  // 7a. The same winner WITHOUT adoptWinner: the control is reapplied over the render arm left live.
  freshMedia();
  saveSettings({ introSec: 5 }); // the variant's render arm was the last one applied
  put([ended("no-adopt")]);
  await evaluateExperiments({ fetch: ctrMetrics(2, 5), now: at("2026-10-08T04:15:00Z") });
  assert.equal(config.introSec, 3, "control reapplied");
  assert.equal(configOnDisk().introSec, 3);
  assert.ok(
    one("no-adopt").decision?.startsWith("kept control: variant wins on CTR"),
    one("no-adopt").decision,
  );

  // 7b. Inconclusive at end, adoptWinner on: nothing to adopt, the control comes back.
  freshMedia();
  saveSettings({ introSec: 5 });
  put([ended("inconclusive-end", { adoptWinner: true })]);
  await evaluateExperiments({
    // 8 x 100 impressions an arm, 1% vs 20%: the per-video gap is huge, the arm still under 1,000.
    fetch: async (matchId) => (matchId < 510 ? m(100, 1) : m(100, 20)),
    now: at("2026-10-08T04:15:00Z"),
  });
  assert.equal(config.introSec, 3, "an inconclusive end never adopts the variant");
  assert.ok(
    one("inconclusive-end").decision?.startsWith("kept control: inconclusive"),
    one("inconclusive-end").decision,
  );

  // 7c. The CONTROL wins on CTR with adoptWinner on: it is kept, not the losing variant.
  freshMedia();
  saveSettings({ introSec: 5 });
  put([ended("control-wins", { adoptWinner: true })]);
  await evaluateExperiments({ fetch: ctrMetrics(5, 2), now: at("2026-10-08T04:15:00Z") });
  assert.equal(config.introSec, 3, "the losing variant is never adopted");
  assert.ok(
    one("control-wins").decision?.startsWith("kept control: control wins on CTR"),
    one("control-wins").decision,
  );

  // 6b. A retention winner with adoptWinner, through the whole path, with its numbers.
  freshMedia();
  put([
    exp({
      id: "retention-adopt",
      metric: "average view %",
      end: "2026-10-08",
      adoptWinner: true,
      controlArm: "off",
      arms: [
        { name: "off", settings: { explainMovesSec: null } },
        { name: "on", settings: { explainMovesSec: 8 } },
      ],
      videos: [...Array(16)].map((_, i) => ({
        matchId: 600 + i,
        arm: i < 8 ? "off" : "on",
        videoId: `x${i}`,
      })),
    }),
  ]);
  await evaluateExperiments({
    fetch: async (matchId) => m(2000, 40, eight(matchId < 608 ? 41 : 51)[matchId % 8]!, 100),
    now: at("2026-10-08T04:15:00Z"),
  });
  assert.equal(config.explainMovesSec, 8, "'on' clearly ahead per video, 8 a side: adopted");
  assert.ok(
    /^adopted on: on wins on average view % \(on 51\.0% vs off 41\.0% per video/.test(
      one("retention-adopt").decision ?? "",
    ),
    one("retention-adopt").decision,
  );
  saveSettings({ explainMovesSec: null, introSec: 7 });
}

// --- 8/9. Failures on two consecutive days set needsHuman; a success or a gap day resets ------------
{
  const failing = async (): Promise<VideoMetrics | null> => {
    throw new Error("Reporting API 403");
  };
  const ok = async () => m(2000, 40);

  // 9. A failure leaves the experiment as it was: still running, yesterday's verdict kept.
  freshMedia();
  put([
    exp({
      id: "steady",
      verdict: "no difference on CTR",
      videos: [{ matchId: 70, arm: "control", videoId: "s70" }],
    }),
  ]);
  await quiet(() => evaluateExperiments({ fetch: failing, now: at("2026-10-08T04:15:00Z") }));
  assert.equal(one("steady").status, "running");
  assert.equal(one("steady").verdict, "no difference on CTR", "a failed read is not a new verdict");
  assert.equal(one("steady").needsHuman, undefined, "one failure is not yet a pattern");

  // 8a. Two in a row, and the flag reaches the morning report's "Needs you" source.
  await quiet(() => evaluateExperiments({ fetch: failing, now: at("2026-10-09T04:15:00Z") }));
  assert.ok(one("steady").needsHuman?.includes("Reporting API 403"), one("steady").needsHuman);
  assert.deepEqual(
    needsHumanExperiments().map((e) => e.id),
    ["steady"],
    "gatherAlerts' source lists it",
  );

  // 8b. fail, succeed, fail: not "in a row".
  freshMedia();
  put([exp({ id: "interrupted", videos: [{ matchId: 71, arm: "control", videoId: "i71" }] })]);
  await quiet(() => evaluateExperiments({ fetch: failing, now: at("2026-10-08T04:15:00Z") }));
  await evaluateExperiments({ fetch: ok, now: at("2026-10-09T04:15:00Z") });
  await quiet(() => evaluateExperiments({ fetch: failing, now: at("2026-10-10T04:15:00Z") }));
  assert.equal(one("interrupted").needsHuman, undefined, "a success in between resets the streak");

  // 8c. Two failed evaluations with no success between them, but a day the dashboard was down.
  freshMedia();
  put([exp({ id: "gap-day", videos: [{ matchId: 72, arm: "control", videoId: "g72" }] })]);
  await quiet(() => evaluateExperiments({ fetch: failing, now: at("2026-10-08T04:15:00Z") }));
  // 9 Oct: no tick at all (the dashboard was down / restarting across the evaluation hour).
  await quiet(() => evaluateExperiments({ fetch: failing, now: at("2026-10-10T04:15:00Z") }));
  // "Two evaluation failures on consecutive UTC days … a day with no evaluation at all restarts the count."
  assert.equal(one("gap-day").needsHuman, undefined, "a day with no evaluation restarts the count");
  // 11 Oct fails too: 10 and 11 Oct are consecutive, so the restarted count reaches two.
  await quiet(() => evaluateExperiments({ fetch: failing, now: at("2026-10-11T04:15:00Z") }));
  assert.ok(one("gap-day").needsHuman?.includes("Reporting API 403"), one("gap-day").needsHuman);
}

// --- 10. enrolVideos: idempotent, never removes ------------------------------------------------------
{
  freshMedia();
  armFile(M1, "keep", "variant");
  // A video the operator listed by hand whose match directory is gone (archived to the NAS).
  const handListed = { matchId: 424242, arm: "control", videoId: "hand1" };
  put([exp({ id: "keep", videos: [handListed] })]);
  await evaluateExperiments({ fetch: async () => null, now: at("2026-10-08T04:15:00Z") });
  await evaluateExperiments({ fetch: async () => null, now: at("2026-10-09T04:15:00Z") });
  const videos = one("keep").videos;
  assert.deepEqual(videos[0], handListed, "never removes a video it cannot see on disk");
  assert.deepEqual(
    videos.map((v) => v.matchId),
    [424242, M1],
    "enrolled once across two ticks — no duplicate",
  );
}

// --- 11. Render enrolment: videoId from youtube.json once the match has one --------------------------
{
  freshMedia();
  armFile(M2, "render-late", "on");
  put([exp({ id: "render-late", arms: [{ name: "off" }, { name: "on" }], controlArm: "off" })]);
  const asked: [number, string | undefined][] = [];
  const fetch = async (matchId: number, hint: string | undefined) => {
    asked.push([matchId, hint]);
    return null;
  };
  await evaluateExperiments({ fetch, now: at("2026-10-08T04:15:00Z") });
  assert.equal(
    one("render-late").videos[0]?.videoId,
    undefined,
    "not uploaded yet: enrolled with no videoId",
  );
  await writeUpload(M2, upload("late1", "2026-10-09T19:00:00Z"));
  asked.length = 0;
  await evaluateExperiments({ fetch, now: at("2026-10-10T04:15:00Z") });
  // The production fetcher reads youtube.json by matchId itself, so the metrics still flow.
  assert.deepEqual(
    asked,
    [[M2, one("render-late").videos[0]?.videoId]],
    "fetch is asked about the match again on the next day's tick",
  );
  assert.equal(one("render-late").videos[0]?.videoId, "late1", "videoId still absent after the match was uploaded");
  console.log("OK: 11 a render-arm video enrolled before its upload gets its videoId once uploaded");
}

// --- 12. Slot enrolment: long-forms only, by publish hour --------------------------------------------
{
  freshMedia();
  const hourSplit = exp({
    id: "hour-split",
    controlArm: "19utc",
    arms: [
      { name: "19utc", slot: { rankedHoursUtc: [19] } },
      { name: "23utc", slot: { rankedHoursUtc: [23] } },
    ],
  });
  put(
    [hourSplit],
    [
      {
        date: "2026-10-09",
        experimentId: "hour-split",
        arm: "two-a-day",
        slot: { rankedHoursUtc: [19, 23] },
      },
    ],
  );
  mkdirSync(matchDir(M3), { recursive: true });
  mkdirSync(matchDir(M4), { recursive: true });
  await writeUpload(M3, upload("lf3", "2026-10-09T23:00:00Z")); // the long-form, published 23:00
  await writeUpload(M4, upload("sh4", "2026-10-09T19:00:00Z"), "short"); // a Short only, same date
  await evaluateExperiments({ fetch: async () => null, now: at("2026-10-10T04:15:00Z") });
  const videos = one("hour-split").videos;
  assert.deepEqual(
    videos,
    [{ matchId: M3, arm: "23utc", videoId: "lf3" }],
    "the long-form, into its own hour's arm; never the Short",
  );
}

// --- 12b. The same hour-split experiment, with the long-form rendered by the NIGHTLY ------------------
// Every nightly render calls writeExperimentArmFile first; on a slot-only date there is no render
// arm to label, so no experiment-arm.json — the publish-hour rule decides the arm.
{
  freshMedia();
  put(
    [
      exp({
        id: "hour-split-nightly",
        controlArm: "19utc",
        arms: [
          { name: "19utc", slot: { rankedHoursUtc: [19] } },
          { name: "23utc", slot: { rankedHoursUtc: [23] } },
        ],
      }),
    ],
    [
      {
        date: "2026-10-09",
        experimentId: "hour-split-nightly",
        arm: "two-a-day",
        slot: { rankedHoursUtc: [19, 23] },
      },
    ],
  );
  writeExperimentArmFile(M5, Date.parse("2026-10-09T03:00:00Z")); // the nightly starts rendering M5
  assert.ok(
    !existsSync(path.join(matchDir(M5), "experiment-arm.json")),
    "a slot-only night labels no render arm",
  );
  mkdirSync(matchDir(M5), { recursive: true }); // the pipeline makes it moments later
  await writeUpload(M5, upload("lf5", "2026-10-09T23:00:00Z"));
  await evaluateExperiments({ fetch: async () => null, now: at("2026-10-10T04:15:00Z") });
  const enrolled = one("hour-split-nightly").videos.find((v) => v.matchId === M5);
  assert.equal(enrolled?.arm, "23utc", "published at 23:00 UTC: the arm whose own hour that is");
}

// --- 13. Only a SLOT experiment enrols by publish date ----------------------------------------------
{
  freshMedia();
  put(
    [
      exp({
        id: "render-only",
        metric: "average view %",
        controlArm: "on",
        arms: [
          { name: "on", settings: { explainMovesSec: 8 } },
          { name: "off", settings: { explainMovesSec: null } },
        ],
      }),
    ],
    [{ date: "2026-10-08", experimentId: "render-only", arm: "off", render: { explainMovesSec: null } }],
  );
  // Rendered by hand days earlier (no experiment-arm.json), published on a render-only date.
  mkdirSync(matchDir(M6), { recursive: true });
  await writeUpload(M6, upload("lf6", "2026-10-08T19:00:00Z"));
  await evaluateExperiments({ fetch: async () => null, now: at("2026-10-09T04:15:00Z") });
  const v = one("render-only").videos.find((x) => x.matchId === M6);
  assert.equal(
    v,
    undefined,
    `a hand-rendered upload joined render experiment arm "${v?.arm}" by its publish date`,
  );
}

// --- 14. An arm file naming a tc experiment never enrols into it --------------------------------------
{
  freshMedia();
  const tc: Experiment = {
    ...exp({ id: "tc-thumbnail-abc", kind: "tc", status: "running" }),
    videos: [{ matchId: 9, arm: "tc", videoId: "abc" }],
  };
  armFile(M1, "tc-thumbnail-abc", "challenger1");
  put([tc, exp({ id: "between-present" })]);
  await evaluateExperiments({ fetch: async () => null, now: at("2026-10-08T04:15:00Z") });
  assert.deepEqual(one("tc-thumbnail-abc"), tc, "a Studio Test & Compare entry is carried through untouched");
}

process.chdir(tmpdir());
for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
console.log("experimentsEvaluator.contract: all checks passed");
