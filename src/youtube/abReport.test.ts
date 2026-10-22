// Pure-logic self-check for src/youtube/abReport.ts (the readout `npm run ab-report` prints).
// No filesystem, no network. Run: npx tsx src/youtube/abReport.test.ts
import assert from "node:assert/strict";
import {
  aggregateByConcept,
  aggregateByStyle,
  engagedRates,
  finishedTests,
  readyToAdopt,
  shareDelta,
} from "./abReport.js";
import type { Experiment } from "./studioExperiments.js";

const SINCE = "2026-10-18T00:00:00.000Z";

const base: Omit<Experiment, "id" | "end" | "status" | "result" | "arms"> = {
  kind: "tc",
  variable: "title",
  videos: [{ matchId: 1, arm: "tc" }],
};

// --- finishedTests: filters by kind/variable/status/date -----------------------------------
{
  const experiments: Experiment[] = [
    // Qualifies: tc, title, done, on the cutoff date.
    {
      ...base,
      id: "a",
      end: "2026-10-18T05:00:00.000Z",
      status: "done",
      arms: [
        { name: "control", settings: { title: "LIVE" } },
        { name: "challenger1", settings: { title: "NEW" }, style: "meme" },
      ],
      result: { watchTimeShare: { control: 40, challenger1: 60 }, winner: "challenger1" },
    },
    // Before the cutoff — excluded.
    { ...base, id: "old", end: "2026-10-17T23:59:59.000Z", status: "done", arms: [], result: {} },
    // Still running — excluded.
    { ...base, id: "running", end: undefined, status: "running", arms: [], result: {} },
    // A thumbnail test, not a title one — excluded.
    {
      ...base,
      id: "thumb",
      variable: "thumbnail",
      end: "2026-10-19T00:00:00.000Z",
      status: "done",
      arms: [],
      result: {},
    },
    // A "between" experiment sharing the same file — excluded (not kind "tc").
    {
      ...base,
      id: "between",
      kind: "between",
      end: "2026-10-19T00:00:00.000Z",
      status: "done",
      arms: [],
      result: {},
    },
  ];
  const rows = finishedTests(experiments, SINCE);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["a"],
    "only the qualifying tc/title/done/on-or-after-cutoff row",
  );
  assert.equal(rows[0]!.videoId, undefined, "no videoId on this fixture's video ref");
  assert.deepEqual(rows[0]!.arms, [
    { name: "control", style: undefined, concept: undefined, share: 40, winner: false },
    { name: "challenger1", style: "meme", concept: undefined, share: 60, winner: true },
  ]);
  assert.equal(rows[0]!.tie, false);
  console.log("OK: finishedTests keeps only done title tc experiments on or after the cutoff");
}

// --- finishedTests: tie detection, newest first ---------------------------------------------
{
  const experiments: Experiment[] = [
    {
      ...base,
      id: "early",
      end: "2026-10-18T01:00:00.000Z",
      status: "done",
      arms: [{ name: "control" }, { name: "challenger1", style: "tease" }],
      result: { headline: "They all performed well", watchTimeShare: { control: 50.1, challenger1: 49.9 } },
    },
    {
      ...base,
      id: "later",
      end: "2026-10-19T01:00:00.000Z",
      status: "done",
      arms: [{ name: "control" }, { name: "challenger1", style: "tech" }],
      result: { winner: "challenger1", watchTimeShare: { control: 30, challenger1: 70 } },
    },
  ];
  const rows = finishedTests(experiments, SINCE);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["later", "early"],
    "newest first",
  );
  assert.equal(rows.find((r) => r.id === "early")?.tie, true, `Studio's own "They all performed well"`);
  assert.equal(rows.find((r) => r.id === "later")?.tie, false);
  console.log('OK: finishedTests marks a "They all performed well" headline as a tie, newest first');
}

// --- aggregateByStyle: wins, ties, mean share; a styleless (pre-18 Oct) arm never counted -------
{
  const rows = finishedTests(
    [
      {
        ...base,
        id: "win",
        end: "2026-10-19T00:00:00.000Z",
        status: "done",
        arms: [
          { name: "control", settings: { title: "LIVE" } },
          { name: "challenger1", settings: {}, style: "meme" },
        ],
        result: { winner: "challenger1", watchTimeShare: { control: 35, challenger1: 65 } },
      },
      {
        ...base,
        id: "tie",
        end: "2026-10-20T00:00:00.000Z",
        status: "done",
        arms: [
          { name: "control", settings: { title: "LIVE" } },
          { name: "challenger1", settings: {}, style: "meme" },
          { name: "challenger2", settings: {}, style: "tech" },
        ],
        result: {
          headline: "They all performed well",
          watchTimeShare: { control: 34, challenger1: 33, challenger2: 33 },
        },
      },
    ],
    SINCE,
  );
  const agg = aggregateByStyle(rows);
  const meme = agg.find((a) => a.key === "meme")!;
  const tech = agg.find((a) => a.key === "tech")!;
  assert.equal(meme.wins, 1, "challenger1 won the first experiment");
  assert.equal(meme.ties, 1, "challenger1 was also in the tied experiment");
  assert.equal(meme.n, 2);
  assert.equal(meme.meanShare, (65 + 33) / 2);
  assert.equal(tech.wins, 0);
  assert.equal(tech.ties, 1);
  assert.equal(tech.meanShare, 33);
  assert.ok(
    !agg.some((a) => a.wins + a.ties + a.n > 0 && a.key === undefined),
    "a styleless arm (these fixtures' control) is never aggregated under any key",
  );
  console.log("OK: aggregateByStyle counts wins/ties/mean share per style, skipping a styleless arm");
}

// --- aggregateByStyle: a "picked" control (18 Oct 2026) gets its own bucket too ------------------
{
  const rows = finishedTests(
    [
      {
        ...base,
        id: "control-wins",
        end: "2026-10-19T00:00:00.000Z",
        status: "done",
        arms: [
          { name: "control", settings: { title: "LIVE" }, style: "picked" },
          { name: "challenger1", settings: {}, style: "meme" },
        ],
        result: { winner: "control", watchTimeShare: { control: 70, challenger1: 30 } },
      },
      {
        ...base,
        id: "control-real-style",
        end: "2026-10-20T00:00:00.000Z",
        status: "done",
        arms: [
          { name: "control", settings: { title: "LIVE" }, style: "tease" },
          { name: "challenger1", settings: {}, style: "meme" },
        ],
        result: { winner: "challenger1", watchTimeShare: { control: 40, challenger1: 60 } },
      },
    ],
    SINCE,
  );
  const agg = aggregateByStyle(rows);
  const picked = agg.find((a) => a.key === "picked")!;
  const tease = agg.find((a) => a.key === "tease")!;
  assert.equal(picked.wins, 1, "the operator's hand-typed pick beat the meme challenger");
  assert.equal(picked.meanShare, 70);
  assert.equal(tease.wins, 0, "this pick's own cache style lost to the meme challenger");
  assert.equal(tease.meanShare, 40);
  console.log('OK: aggregateByStyle gives a "picked" control its own bucket, same as any real style');
}

// --- aggregateByStyle: an empty input aggregates to nothing --------------------------------------
{
  assert.deepEqual(aggregateByStyle([]), []);
  console.log("OK: aggregateByStyle([]) is []");
}

// --- losses and mean delta vs control per style: a control's own style has no delta ------------
{
  const rows = finishedTests(
    [
      {
        ...base,
        id: "control-wins",
        end: "2026-10-19T00:00:00.000Z",
        status: "done",
        arms: [
          { name: "control", style: "picked" },
          { name: "challenger1", style: "meme" },
        ],
        result: { winner: "control", watchTimeShare: { control: 70, challenger1: 30 } },
      },
      {
        ...base,
        id: "meme-wins",
        end: "2026-10-20T00:00:00.000Z",
        status: "done",
        arms: [
          { name: "control", style: "tease" },
          { name: "challenger1", style: "meme" },
        ],
        result: { winner: "challenger1", watchTimeShare: { control: 40, challenger1: 60 } },
      },
    ],
    SINCE,
  );
  const agg = aggregateByStyle(rows);
  const meme = agg.find((a) => a.key === "meme")!;
  assert.deepEqual([meme.tests, meme.wins, meme.losses, meme.ties], [2, 1, 1, 0]);
  assert.equal(meme.meanDelta, (-40 + 20) / 2, "30−70 and 60−40, in points");
  const picked = agg.find((a) => a.key === "picked")!;
  assert.deepEqual([picked.wins, picked.losses, picked.meanDelta], [1, 0, null], "a control has no delta");
  assert.equal(agg.find((a) => a.key === "tease")!.losses, 1);
  assert.equal(shareDelta(rows[0]!, rows[0]!.arms[0]!), undefined, "the control itself");
  assert.equal(shareDelta(rows[0]!, { name: "challenger1", winner: false }), undefined, "no share read");
  console.log("OK: aggregateByStyle counts losses and the mean share delta vs each test's own control");
}

// --- thumbnail concept tests (22 Oct 2026 shape): concept from settings, adoption rule ----------
{
  const concept = (
    id: string,
    end: string,
    shares: [number, number, number],
    result: Record<string, unknown>,
    status: Experiment["status"] = "done",
  ): Experiment => ({
    ...base,
    id,
    variable: "thumbnail",
    controlArm: "control",
    start: "2026-10-22T14:23:08.714Z",
    end,
    status,
    arms: [
      { name: "control", settings: { file: "/m/1/tc-concepts/control.png", concept: "live" } },
      { name: "challenger1", settings: { file: "/m/1/tc-concepts/big-heads.png", concept: "big-heads" } },
      { name: "challenger2", settings: { file: "/m/1/tc-concepts/scenery.png", concept: "seed-scenery" } },
    ],
    result: {
      ...result,
      watchTimeShare: { control: shares[0], challenger1: shares[1], challenger2: shares[2] },
    },
  });
  const won = { headline: "We have a winner!", winner: "challenger1" };
  const tie = { headline: "They all performed well" };
  const experiments: Experiment[] = [
    concept("t1", "2026-10-26T00:00:00.000Z", [30, 36, 34], won),
    concept("t2", "2026-10-27T00:00:00.000Z", [31, 38, 31], won),
    concept("t3", "2026-10-28T00:00:00.000Z", [33, 35, 32], tie),
    concept("live-one", "2026-10-29T00:00:00.000Z", [10, 80, 10], won, "running"),
    // An older pose/caption thumbnail test: no concept on any arm, so in no concept bucket.
    {
      ...base,
      id: "pose",
      variable: "thumbnail",
      end: "2026-10-20T00:00:00.000Z",
      status: "done",
      arms: [
        { name: "control", settings: { file: "c.png" } },
        { name: "challenger1", settings: { file: "p.png" } },
      ],
      result: { headline: "They all performed well", watchTimeShare: { control: 50, challenger1: 50 } },
    },
  ];
  const rows = finishedTests(experiments, SINCE, "thumbnail");
  assert.deepEqual(
    rows.map((r) => r.id),
    ["t3", "t2", "t1", "pose"],
    "done thumbnail tests only, newest first",
  );
  assert.equal(rows[0]!.start, "2026-10-22T14:23:08.714Z", "the test window's start rides along");
  assert.deepEqual(
    rows[0]!.arms.map((a) => a.concept),
    ["live", "big-heads", "seed-scenery"],
  );
  assert.deepEqual(
    finishedTests(experiments, SINCE).length,
    0,
    "a title readout never sees a thumbnail test",
  );

  const agg = aggregateByConcept(rows);
  assert.deepEqual(
    agg.map((a) => a.key).sort(),
    ["big-heads", "live", "seed-scenery"],
    "the pose test has no concept",
  );
  const big = agg.find((a) => a.key === "big-heads")!;
  assert.deepEqual([big.tests, big.wins, big.losses, big.ties], [3, 2, 0, 1]);
  assert.equal(big.meanDelta, (6 + 7 + 2) / 3);
  assert.equal(big.ready, true, "3 tests, 2 wins, +5.0 points: ready to adopt (reported only)");
  const scenery = agg.find((a) => a.key === "seed-scenery")!;
  assert.deepEqual([scenery.tests, scenery.wins, scenery.losses, scenery.ties], [3, 0, 2, 1]);
  assert.equal(scenery.meanDelta, (4 + 0 - 1) / 3);
  assert.equal(scenery.ready, false);
  const live = agg.find((a) => a.key === "live")!;
  assert.deepEqual(
    [live.losses, live.meanDelta, live.ready],
    [2, null, false],
    "the control concept is never 'ready'",
  );

  const twoTests = aggregateByConcept(rows.filter((r) => r.id !== "t3")).find((a) => a.key === "big-heads")!;
  assert.equal(twoTests.ready, false, "2 wins at +6.5 points, but only 2 finished tests");

  const edge = { key: "k", tests: 3, wins: 2, losses: 0, ties: 1, meanShare: 40, n: 3, meanDelta: 3 };
  assert.equal(readyToAdopt(edge), true, "exactly the bar: ready");
  assert.equal(readyToAdopt({ ...edge, meanDelta: 2.99 }), false, "under +3 points");
  assert.equal(readyToAdopt({ ...edge, wins: 1 }), false, "one win");
  assert.equal(readyToAdopt({ ...edge, meanDelta: null }), false, "no delta");
  console.log(
    "OK: concept tests aggregate by settings.concept; the adoption rule is ≥3 tests, ≥2 wins, ≥ +3 points",
  );
}

// --- engagedRates: the subscriber-side numbers, zero-guarded --------------------------------------
{
  assert.deepEqual(engagedRates({ views: 1000, engagedViews: 400, subscribersGained: 2 }), {
    engagedRatio: 0.4,
    subsPer1kEngaged: 5,
  });
  assert.deepEqual(engagedRates({ views: 0, engagedViews: 0, subscribersGained: 0 }), {
    engagedRatio: null,
    subsPer1kEngaged: null,
  });
  assert.deepEqual(engagedRates({ views: 10, engagedViews: 0, subscribersGained: 1 }), {
    engagedRatio: 0,
    subsPer1kEngaged: null,
  });
  console.log("OK: engagedRates is engaged/views and subs per 1,000 engaged, null over a zero");
}

console.log("abReport: all checks passed");
