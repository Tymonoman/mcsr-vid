// Self-check for the DNF predicate (`isDnf`, `metricsDnf`), from the rule as the operator gave it on
// 16 Oct 2026 ("remember not to post DNF matches also dont suggest them"): a DNF is a match nobody
// finished — a forfeit, no winner on record, or no completion. A finished match whose loser never
// killed the dragon is not one. Real fixtures only; nothing leaves the process.
// Run: npx tsx src/pipeline/matchScore.dnf.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { FeedMatch, MatchInfo } from "../api/types.js";
import { computeMetrics, isDnf, metricsDnf } from "./matchScore.js";

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;

const finished = fixture(12730175);
// The shape 13303909 has on the live API: forfeited, a winner on record, no completion.
const forfeit: MatchInfo = { ...finished, forfeited: true, completions: [] };
const noWinner: MatchInfo = { ...finished, result: { ...finished.result, uuid: null } };
const nobodyCompleted: MatchInfo = { ...finished, completions: [] };

assert.equal(isDnf(finished), false, "a finished match is not a DNF");
assert.equal(isDnf(forfeit), true, "a forfeit is");
assert.equal(isDnf(noWinner), true, "no winner on record is");
assert.equal(isDnf(nobodyCompleted), true, "no completion is");
console.log("OK: isDnf — a forfeit, no winner or no completion; a finished match is none of them");

// A feed entry carries no completions: judged on the two fields it has.
const { timelines: _t, completions: _c, ...feed } = finished;
assert.equal(isDnf(feed as FeedMatch), false, "a finished feed entry is not a DNF");
assert.equal(isDnf({ ...feed, forfeited: true } as FeedMatch), true, "a forfeited feed entry is");
console.log("OK: isDnf on a feed entry reads only what the feed carries");

// Every fixture is a finished match, and none reads as a DNF — including the ones whose loser never
// killed the dragon (finishMarginMs null), which are finished races, not DNFs.
for (const id of [12730175, 12898432, 12902901, 12929221, 13446429, 13448958, 13549300, 13560037]) {
  const m = computeMetrics(fixture(id));
  assert.equal(m.dnf, false, `#${id} scores as finished`);
  assert.equal(metricsDnf(m), false, `#${id} reads as finished from its metrics`);
}
assert.equal(computeMetrics(forfeit).dnf, true, "a forfeit is scored as one");
console.log("OK: computeMetrics records dnf; every real finished fixture reads false");

// A cache entry scored before the flag existed: no `dnf`, read off what it does carry.
const stale = (m: MatchInfo) => {
  const { dnf: _d, ...rest } = computeMetrics(m);
  return rest;
};
assert.equal(metricsDnf(stale(finished)), false, "a stale finished entry stays");
assert.equal(metricsDnf(stale(noWinner)), true, "a stale entry with no winner is dropped");
const noDragon = { ...finished, timelines: finished.timelines.filter((e) => !/dragon/.test(e.type)) };
assert.equal(metricsDnf(stale(noDragon)), true, "a stale entry where nobody reached the dragon is dropped");
// A hand-trimmed entry with no splits list is not evidence of anything.
assert.equal(metricsDnf({ winner: "edcr", splits: [] }), false, "no splits recorded is not a DNF");
assert.equal(metricsDnf({ ...stale(finished), dnf: true }), true, "the flag wins when present");
console.log("OK: metricsDnf drops a stale cached DNF and keeps a stale finished one");

console.log("matchScore.dnf: all checks passed");
