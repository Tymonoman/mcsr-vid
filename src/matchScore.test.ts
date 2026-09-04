import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  chaosScore,
  closenessScore,
  computeMetrics,
  DEFAULT_WEIGHTS,
  formatMetrics,
  speedBonus,
  TOTAL_SPLITS,
} from "./matchScore.js";
import type { MatchInfo } from "./types.js";

/** Real API responses, trimmed to the fields the scorer reads. */
const load = (matchId: number): MatchInfo =>
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", `match-${matchId}.json`), "utf8"),
  ) as MatchInfo;

const FAST_SEC = 420;
const SLOW_SEC = 600;

// --- 12730175: edcr vs doogile, the benchmark video. A 0.221s photo finish at the
// killing blow, 1.033s once both dragon animations land. Both players have
// `dragon_death`, so nothing is estimated here.
const benchmark = computeMetrics(load(12730175));
assert.deepEqual(benchmark.players, ["edcr", "doogile"]);
assert.equal(benchmark.winner, "edcr");
assert.equal(benchmark.finishMarginMs, 1033, "gap between the two dragon_death events");
assert.equal(benchmark.finishEstimated, false, "both players have a real dragon_death event");
assert.equal(benchmark.deaths, 5);
assert.deepEqual(benchmark.deathsByPlayer, { edcr: 3, doogile: 2 });
// The bastion is scored twice, because arrival and loot say different things: these two arrived
// 8.185s apart and finished looting 1.705s apart, so the convergence inside the bastion is real
// and only the loot half is close. The overlay displays arrival alone.
assert.equal(benchmark.splitsWithin3s, 4, "Bastion loot, Blind travel, End enter and Dragon are <3s");
assert.equal(benchmark.comparedSplits, 9, "8 milestones plus the dragon, all reached by both");
assert.equal(benchmark.maxLeadMs, 10086, "widest gap was at the stronghold");
assert.equal(benchmark.leadChanges, 0, "edcr led every scored split");

// --- 12898432: bbiddd vs BadGamer. THE REGRESSION GUARD. BadGamer has no
// `end.kill_dragon` event at all, only `dragon_death`. An implementation that keys on
// `kill_dragon` sees bbiddd's 8:15.277 against nothing and reports the End-enter gap of
// 10.357s, making a 3.5s finish look like a blowout.
const missingKillEvent = computeMetrics(load(12898432));
assert.deepEqual(missingKillEvent.players, ["bbiddd", "BadGamer"]);
assert.equal(missingKillEvent.finishMarginMs, 3498, "must come from dragon_death, not kill_dragon");
assert.notEqual(missingKillEvent.finishMarginMs, 10357, "10.357s is the End-enter gap, not the finish");
assert.equal(missingKillEvent.finishEstimated, false);
assert.equal(missingKillEvent.splitsWithin3s, 0, "BadGamer led by 10s+ at every split but the dragon");
assert.equal(missingKillEvent.maxLeadMs, 45344);
assert.equal(missingKillEvent.deaths, 1);

// --- 12902901: BlazeMind vs Aquacorde. The mirror-image gap: BlazeMind has
// `end.kill_dragon` but no `dragon_death`, so his finish is estimated at kill + 10.3s
// and the margin is flagged as approximate.
const estimatedFinish = computeMetrics(load(12902901));
assert.deepEqual(estimatedFinish.players, ["BlazeMind", "Aquacorde"]);
assert.equal(estimatedFinish.winner, "Aquacorde");
assert.equal(estimatedFinish.finishEstimated, true, "BlazeMind's dragon time is derived from kill_dragon");
assert.equal(estimatedFinish.finishMarginMs, 14394);
assert.equal(estimatedFinish.deaths, 0);

// --- 12929221: Feinberg vs silverrruns. Feinberg never killed the dragon, so there is
// no comparable finish; the match must survive scoring rather than throw, and keeps its
// huge mid-race collapse (a 130.6s lead becoming a 4.5s deficit).
const dnf = computeMetrics(load(12929221));
assert.equal(dnf.finishMarginMs, null, "a DNF finish has no margin");
assert.equal(dnf.comparedSplits, 8, "the dragon split is dropped, the other eight remain");
assert.equal(dnf.maxLeadMs, 130585);
assert.equal(dnf.maxSwingMs, 135085, "130.585s lead flipping to a 4.5s deficit");
assert.equal(dnf.leadChanges, 2);
// This match records its death as a bare `projectelo.timeline.death`, not the
// `death_spawnpoint` spelling every other fixture uses. Only the latter was counted, so this
// reported zero deaths — silently zeroing `chaosDeaths`, the heaviest term of the chaos score,
// for every match that uses the short spelling.
assert.equal(dnf.deaths, 1, "a bare projectelo.timeline.death must count as a death");
assert.deepEqual(dnf.deathsByPlayer, { Feinberg: 1, silverrruns: 0 });

// --- Scoring behaviour.
const score = (m: Parameters<typeof closenessScore>[0]) =>
  closenessScore(m, DEFAULT_WEIGHTS, FAST_SEC, SLOW_SEC);

assert.ok(
  score(benchmark) > score(missingKillEvent),
  "the benchmark's sustained closeness must outrank a match that was only close at the dragon",
);
assert.ok(score(missingKillEvent) > score(dnf), "a real 3.5s finish must outrank a DNF finish");
assert.ok(
  chaosScore(dnf, DEFAULT_WEIGHTS, FAST_SEC, SLOW_SEC) >
    chaosScore(estimatedFinish, DEFAULT_WEIGHTS, FAST_SEC, SLOW_SEC),
  "a 135s collapse with 2 lead changes is more chaotic than a clean deathless run",
);
for (const metrics of [benchmark, missingKillEvent, estimatedFinish, dnf]) {
  const value = score(metrics);
  assert.ok(value >= 0 && value <= 1, `closeness score must stay in 0..1, got ${value}`);
}

// A DNF scores zero on margin but is not excluded outright - it can still win a chaos slot.
// (suggest.ts additionally bars it from the close bucket, where a missing finish is
// disqualifying rather than merely unscored.)
assert.ok(score(dnf) > 0, "a DNF still earns score from its other terms");

// A patchy timeline must not look as close as a complete one. Dividing the close-split
// count by however many splits happened to be comparable would score 3-of-6 the same as
// 3-of-8, quietly promoting matches with missing data.
assert.equal(TOTAL_SPLITS, 9, "eight milestones plus the dragon");
const sparse = { ...dnf, splitsWithin3s: 3, comparedSplits: 6 };
const complete = { ...dnf, splitsWithin3s: 3, comparedSplits: 9 };
assert.equal(
  score(sparse),
  score(complete),
  "the split term must depend on the count of close splits, not on how many were comparable",
);
assert.ok(
  score({ ...dnf, splitsWithin3s: 4, comparedSplits: 9 }) > score(sparse),
  "more close splits must still outrank fewer",
);

// speedBonus: full credit at or under the fast target, none at or past the slow cutoff.
assert.equal(speedBonus(400_000, FAST_SEC, SLOW_SEC), 1);
assert.equal(speedBonus(420_000, FAST_SEC, SLOW_SEC), 1);
assert.equal(speedBonus(600_000, FAST_SEC, SLOW_SEC), 0);
assert.equal(speedBonus(900_000, FAST_SEC, SLOW_SEC), 0);
assert.equal(speedBonus(510_000, FAST_SEC, SLOW_SEC), 0.5, "midway between the two thresholds");

// --- formatMetrics renders every split plus the summary block.
const text = formatMetrics(benchmark);
assert.match(text, /Match 12730175 - edcr vs doogile/);
// Distinct labels, so the table can never again read as one ambiguous "Bastion".
assert.match(text, /Bastion enter {7}2:03\.676/);
assert.match(text, /Bastion loot {8}2:17\.182/);
assert.match(text, /Finish margin : 1\.033s/);
assert.match(text, /Splits <3s {4}: 4\/9/);
assert.match(text, /Deaths {8}: 5 \(edcr 3, doogile 2\)/);
assert.match(formatMetrics(dnf), /Finish margin : DNF/);
assert.match(formatMetrics(estimatedFinish), /Finish margin : 14\.394s \(estimated\)/);

console.log("matchScore: ok");
