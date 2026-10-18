// Pure-logic self-check for src/youtube/abReport.ts (the readout `npm run ab-report` prints).
// No filesystem, no network. Run: npx tsx src/youtube/abReport.test.ts
import assert from "node:assert/strict";
import { aggregateByStyle, finishedTitleTests } from "./abReport.js";
import type { Experiment } from "./studioExperiments.js";

const SINCE = "2026-10-18T00:00:00.000Z";

const base: Omit<Experiment, "id" | "end" | "status" | "result" | "arms"> = {
  kind: "tc",
  variable: "title",
  videos: [{ matchId: 1, arm: "tc" }],
};

// --- finishedTitleTests: filters by kind/variable/status/date -----------------------------------
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
  const rows = finishedTitleTests(experiments, SINCE);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["a"],
    "only the qualifying tc/title/done/on-or-after-cutoff row",
  );
  assert.equal(rows[0]!.videoId, undefined, "no videoId on this fixture's video ref");
  assert.deepEqual(rows[0]!.arms, [
    { name: "control", style: undefined, share: 40, winner: false },
    { name: "challenger1", style: "meme", share: 60, winner: true },
  ]);
  assert.equal(rows[0]!.tie, false);
  console.log("OK: finishedTitleTests keeps only done title tc experiments on or after the cutoff");
}

// --- finishedTitleTests: tie detection, newest first ---------------------------------------------
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
  const rows = finishedTitleTests(experiments, SINCE);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["later", "early"],
    "newest first",
  );
  assert.equal(rows.find((r) => r.id === "early")?.tie, true, `Studio's own "They all performed well"`);
  assert.equal(rows.find((r) => r.id === "later")?.tie, false);
  console.log('OK: finishedTitleTests marks a "They all performed well" headline as a tie, newest first');
}

// --- aggregateByStyle: wins, ties, mean share; a styleless (pre-18 Oct) arm never counted -------
{
  const rows = finishedTitleTests(
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
  const meme = agg.find((a) => a.style === "meme")!;
  const tech = agg.find((a) => a.style === "tech")!;
  assert.equal(meme.wins, 1, "challenger1 won the first experiment");
  assert.equal(meme.ties, 1, "challenger1 was also in the tied experiment");
  assert.equal(meme.n, 2);
  assert.equal(meme.meanShare, (65 + 33) / 2);
  assert.equal(tech.wins, 0);
  assert.equal(tech.ties, 1);
  assert.equal(tech.meanShare, 33);
  assert.ok(
    !agg.some((a) => a.wins + a.ties + a.n > 0 && a.style === undefined),
    "a styleless arm (these fixtures' control) is never aggregated under any key",
  );
  console.log("OK: aggregateByStyle counts wins/ties/mean share per style, skipping a styleless arm");
}

// --- aggregateByStyle: a "picked" control (18 Oct 2026) gets its own bucket too ------------------
{
  const rows = finishedTitleTests(
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
  const picked = agg.find((a) => a.style === "picked")!;
  const tease = agg.find((a) => a.style === "tease")!;
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

console.log("abReport: all checks passed");
