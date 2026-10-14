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
//  3. Any arm under 1,000 impressions is "inconclusive", never a guess — regardless of metric, and
//     counted per arm (every video of the arm summed), not per video.
//  4. CTR is a two-proportion z-test; |z| >= 1.96 names a winner, anything under is no difference.
//  5. A retention metric (average view %) reports the per-arm view-weighted mean; a winner only when
//     every video of one arm beats every video of the other (strictly), 3+ a side, counting only
//     videos with views. Verdicts are per the experiment's own metric.
//  6. At `end`, a winner with `adoptWinner` becomes the new default (saveSettings — the config file
//     itself, so it survives a restart), and the decision is written with its numbers.
//  7. Otherwise (no winner, inconclusive, the control winning, or adoptWinner off) the control
//     arm's settings are reapplied, in case a render arm left something else live mid-run.
//  8. Two evaluation failures in a row set `needsHuman` (and it reaches the "Needs you" source,
//     `needsHumanExperiments`); a success in between resets the streak.
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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
process.chdir(cwdDir);
delete process.env.MCSR_CONFIG;
const configFile = path.join(cwdDir, "mcsr-vid.config.json");
writeFileSync(
  configFile,
  JSON.stringify({ mediaDir: mkdtempSync(path.join(tmpdir(), "mcsr-evalc-media-")) }),
);

const { config, matchDir } = await import("../config.js");
const { readExperiments, writeExperiments, writeExperimentArmFile, needsHumanExperiments } =
  await import("./experiments.js");
const { evaluateExperiments, twoProportionZ, verdictFor } = await import("./experimentsEvaluator.js");
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

/** ArmTotals the way armTotalsFor builds them, for calling verdictFor directly. */
const totals = (arm: string, impressions: number, clicks: number, pcts: number[] = []): ArmTotals => ({
  arm,
  videos: pcts.length,
  impressions,
  clicks,
  views: 1000 * pcts.length,
  engagedViews: 0,
  subscribersGained: 0,
  avgViewPercentage: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0,
  avgViewPercentages: pcts,
});

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

// --- 3. The 1,000-impression floor: per arm, every metric ----------------------------------------
{
  // A retention experiment with total dominance, but one arm at 999 impressions: still a guess.
  const retention = exp({ metric: "average view %" });
  const under = verdictFor(retention, [
    totals("control", 999, 10, [30, 31, 32]),
    totals("variant", 5000, 50, [60, 61, 62]),
  ]);
  assert.ok(under.text.startsWith("inconclusive"), `the floor applies to retention too, got "${under.text}"`);
  assert.equal(under.winnerArm, null, "an inconclusive verdict names no winner to adopt");

  // Exactly 1,000 is enough ("under 1,000" is inconclusive, 1,000 is not).
  const atFloor = verdictFor(retention, [
    totals("control", 1000, 10, [30, 31, 32]),
    totals("variant", 1000, 10, [60, 61, 62]),
  ]);
  assert.equal(atFloor.winnerArm, "variant", atFloor.text);

  // Per ARM, not per video: three 400-impression videos are a 1,200-impression arm.
  freshMedia();
  const vids = (arm: string, ids: number[]) =>
    ids.map((matchId) => ({ matchId, arm, videoId: `v${matchId}` }));
  put([
    exp({ id: "pooled", videos: [...vids("control", [20, 21, 22]), ...vids("variant", [23, 24, 25])] }),
    exp({ id: "thin", videos: [...vids("control", [30, 31]), ...vids("variant", [33, 34])] }),
  ]);
  // A 1% vs 10% CTR gap — huge — on 400-impression videos.
  const fetch = async (matchId: number) => (matchId % 10 >= 3 ? m(400, 40) : m(400, 4));
  await evaluateExperiments({ fetch, now: at("2026-10-08T04:15:00Z") });
  assert.ok(one("pooled").verdict?.startsWith("variant wins on CTR"), one("pooled").verdict);
  // 2 x 400 = 800 per arm: the same gap is still "inconclusive", the 1 Oct post-mortem's lesson.
  assert.ok(one("thin").verdict?.startsWith("inconclusive (800 impressions"), one("thin").verdict);
  const result = one("pooled").result as { arms: ArmTotals[] };
  assert.deepEqual(
    result.arms.map((a) => [a.arm, a.impressions, a.clicks]),
    [
      ["control", 1200, 12],
      ["variant", 1200, 120],
    ],
    "the numbers land in `result`, summed per arm",
  );
}

// --- 4. CTR: a two-proportion z-test at |z| >= 1.96 -------------------------------------------------
{
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

  // 3.49% vs 3.00% on 10,000 each is z = 1.955 — just under the bar; 3.50% is z = 1.994, just over.
  assert.ok(
    zRef(349, 10000, 300, 10000) < 1.96 && zRef(350, 10000, 300, 10000) > 1.96,
    "the fixture straddles 1.96",
  );
  const justUnder = verdictFor(exp(), [totals("control", 10000, 300), totals("variant", 10000, 349)]);
  assert.equal(justUnder.text, "no difference on CTR", "1.955 is not significant");
  assert.equal(justUnder.winnerArm, null);
  const justOver = verdictFor(exp(), [totals("control", 10000, 300), totals("variant", 10000, 350)]);
  assert.ok(justOver.text.startsWith("variant wins on CTR (3.50% vs 3.00%"), justOver.text);
  assert.equal(justOver.winnerArm, "variant");

  // The metric name is matched case-blind: "CTR" in a hand-edited file is still the z-test.
  const upper = verdictFor(exp({ metric: "CTR" }), [
    totals("control", 10000, 300),
    totals("variant", 10000, 350),
  ]);
  assert.equal(upper.winnerArm, "variant", upper.text);
}

// --- 5. Retention: strict dominance, 3+ a side, view-weighted mean -----------------------------------
{
  const retention = exp({ metric: "average view %" });
  // The variant's worst equals the control's best: "beats" is strict, so no winner.
  const tie = verdictFor(retention, [
    totals("control", 5000, 100, [40, 42, 45]),
    totals("variant", 5000, 100, [45, 50, 55]),
  ]);
  assert.equal(tie.text, "numbers only", "a tie at the edge is not every video beating every video");

  // The control dominating names the control, but there is nothing to adopt.
  const controlAhead = verdictFor(retention, [
    totals("control", 5000, 100, [60, 61, 62]),
    totals("variant", 5000, 100, [40, 41, 42]),
  ]);
  assert.ok(controlAhead.text.startsWith("control wins on average view %"), controlAhead.text);
  assert.equal(controlAhead.winnerArm, null);

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

await deviation(
  "verdicts follow the experiment's own metric (CTR: z-test; retention/average view %: dominance) — handbook/knowledge/experiments.md 'Verdicts'",
  () => {
    // An engaged-views experiment whose videos happen to dominate on average view %.
    const v = verdictFor(exp({ metric: "engagedViews" }), [
      totals("control", 5000, 100, [30, 31, 32]),
      totals("variant", 5000, 100, [60, 61, 62]),
    ]);
    assert.equal(v.winnerArm, null, `an engaged-views experiment was decided on another metric: "${v.text}"`);
  },
);

// --- 6/7. At end: adopt the winner (persisted), or reapply the control --------------------------------
{
  const ctrMetrics = (controlClicks: number, variantClicks: number) => async (matchId: number) =>
    matchId === 50 ? m(5000, controlClicks) : matchId === 51 ? m(5000, variantClicks) : null;
  const ended = (id: string, over: Partial<Experiment> = {}) =>
    exp({
      id,
      end: "2026-10-08",
      arms: [
        { name: "control", settings: { introSec: 3 } },
        { name: "variant", settings: { introSec: 5 } },
      ],
      videos: [
        { matchId: 50, arm: "control", videoId: "c50" },
        { matchId: 51, arm: "variant", videoId: "v51" },
      ],
      ...over,
    });

  // 6. A winner with adoptWinner becomes the default — in the config FILE, so a restart keeps it.
  freshMedia();
  saveSettings({ introSec: 6 }); // whatever the box had before
  put([ended("adopt", { adoptWinner: true })]);
  await evaluateExperiments({ fetch: ctrMetrics(100, 250), now: at("2026-10-08T04:15:00Z") });
  assert.equal(config.introSec, 5, "the winning arm's setting is live");
  assert.equal(configOnDisk().introSec, 5, "and written to mcsr-vid.config.json, so it is the new default");
  assert.equal(one("adopt").status, "done");
  // "the decision is written with its numbers"
  assert.ok(/^adopted variant: .*5\.00% vs 2\.00%/.test(one("adopt").decision ?? ""), one("adopt").decision);

  // 7a. The same winner WITHOUT adoptWinner: the control is reapplied over the render arm left live.
  freshMedia();
  saveSettings({ introSec: 5 }); // the variant's render arm was the last one applied
  put([ended("no-adopt")]);
  await evaluateExperiments({ fetch: ctrMetrics(100, 250), now: at("2026-10-08T04:15:00Z") });
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
    fetch: async (matchId) => (matchId === 50 ? m(500, 5) : m(500, 100)),
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
  await evaluateExperiments({ fetch: ctrMetrics(250, 100), now: at("2026-10-08T04:15:00Z") });
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
      videos: [60, 61, 62, 63, 64, 65].map((matchId, i) => ({
        matchId,
        arm: i < 3 ? "off" : "on",
        videoId: `x${matchId}`,
      })),
    }),
  ]);
  const pct = new Map([
    [60, 40],
    [61, 41],
    [62, 42],
    [63, 50],
    [64, 51],
    [65, 52],
  ]);
  await evaluateExperiments({
    fetch: async (matchId) => m(2000, 40, pct.get(matchId)!, 100),
    now: at("2026-10-08T04:15:00Z"),
  });
  assert.equal(config.explainMovesSec, 8, "every 'on' video beat every 'off' one, 3 a side: adopted");
  assert.ok(
    /^adopted on: .*51\.0% vs 41\.0%/.test(one("retention-adopt").decision ?? ""),
    one("retention-adopt").decision,
  );
  saveSettings({ explainMovesSec: null, introSec: 7 });
}

// --- 8/9. Two failures in a row set needsHuman; a success resets the streak ---------------------------
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
  await deviation(
    "Two evaluation failures in a row (a Reporting or Analytics API error) sets needsHuman — CLAUDE.md experiment engine bullet",
    () => {
      assert.ok(
        one("gap-day").needsHuman,
        "failed 8 Oct and 10 Oct with no evaluation between (no tick 9 Oct): still no needsHuman",
      );
    },
  );
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
  await evaluateExperiments({ fetch, now: at("2026-10-10T04:15:00Z") });
  // The production fetcher reads youtube.json by matchId itself, so the metrics still flow.
  assert.deepEqual(
    asked.at(-1),
    [M2, one("render-late").videos[0]?.videoId],
    "fetch is still asked about the match",
  );
  await deviation(
    "ExperimentVideo.videoId 'Filled in by the evaluator from the match's youtube.json when absent' — src/dashboard/experiments.ts",
    () => {
      assert.equal(
        one("render-late").videos[0]?.videoId,
        "late1",
        "videoId still absent after the match was uploaded",
      );
    },
  );
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
// Every nightly render writes experiment-arm.json first (writeExperimentArmFile); on a slot-only
// date that file falls back to the date's slot entry. The publish-hour rule must still decide the arm.
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
  await writeUpload(M5, upload("lf5", "2026-10-09T23:00:00Z"));
  await evaluateExperiments({ fetch: async () => null, now: at("2026-10-10T04:15:00Z") });
  const enrolled = one("hour-split-nightly").videos.find((v) => v.matchId === M5);
  assert.ok(enrolled, "the nightly's long-form is enrolled one way or another");
  await deviation(
    "slot experiments enrol 'into the arm whose own slot.rankedHoursUtc is exactly that one publish hour' — handbook/claude-md-reference.md enrolVideos",
    () => {
      assert.equal(enrolled.arm, "23utc", `published at 23:00 UTC but enrolled as "${enrolled.arm}" (the render-night entry's label, not one of the arms)`);
    },
  );
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
  await deviation(
    "uploads enrol by publish date only where 'the date's slot entry names a slot experiment' — handbook/claude-md-reference.md enrolVideos",
    () => {
      const v = one("render-only").videos.find((x) => x.matchId === M6);
      assert.equal(
        v,
        undefined,
        `a hand-rendered upload joined render experiment arm "${v?.arm}" by its publish date`,
      );
    },
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

console.log("experimentsEvaluator.contract: all checks passed");
