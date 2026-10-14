// Contract tests for `deathKind` and the death counts built on it (matchScore.ts), written from the
// docs (CLAUDE.md "Shorts": deathKind; handbook/claude-md-reference.md "The model is told the game")
// by someone who did not write the code. matchScore.test.ts already pins the benchmark's five
// resets and one synthetic run; this covers each phase, the player's own phase, a restart, and the
// one-reading promise across every fixture.
//
// The promises the docs make:
//  D1 `death_spawnpoint` is a hunger reset in every phase but the End — overworld, Nether (a
//     respawn anchor too), after blind, stronghold.
//  D2 In the End, where no bed sets a spawn, `death_spawnpoint` is a real death.
//  D3 A bare `death` (no spawn point set) is a real death wherever it happens.
//  D4 The phase is the dying player's own: the other runner being in the End changes nothing.
//  D5 A restart (`reset`, a new world) puts the player back in the Overworld.
//  D6 Nothing that is not a player's death is a death: the dragon's included.
//  D7 `metrics.deaths` counts real deaths only, per player in `deathsByPlayer`.
//  D8 "Not a single death" counts every death-screen entry (`onScreenDeaths`), resets included.
//  D9 One reading everywhere: on every real fixture, `metrics.deaths` is exactly the deathKind count.
//
// Run: npx tsx src/pipeline/matchScore.contract.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { MatchInfo, TimelineEntry } from "../api/types.js";
import { computeMetrics, deathKind, onScreenDeaths } from "./matchScore.js";

const fixtures = new URL("../fixtures/", import.meta.url);
const load = (name: string): MatchInfo =>
  JSON.parse(readFileSync(new URL(name, fixtures), "utf8")) as MatchInfo;
const base = load("match-13446429.json");
const [L, R] = base.players.map((p) => p.uuid) as [string, string];
const at = (uuid: string, time: number, type: string): TimelineEntry =>
  ({ uuid, time, type }) as TimelineEntry;
const SPAWN = "projectelo.timeline.death_spawnpoint";
const DEATH = "projectelo.timeline.death";

/** Left reaches each phase on a clean schedule; right stays in the Overworld until told otherwise. */
const run = (extra: TimelineEntry[]): MatchInfo => ({
  ...base,
  timelines: [
    at(L, 100_000, "story.enter_the_nether"),
    at(L, 200_000, "projectelo.timeline.blind_travel"),
    at(L, 300_000, "story.follow_ender_eye"),
    at(L, 400_000, "story.enter_the_end"),
    ...extra,
  ],
});

// --- D1, D2: the same event, read by where the player is. -----------------------------------------
{
  const cases: Array<[number, string]> = [
    [50_000, "overworld"],
    [150_000, "nether"],
    [250_000, "after blind"],
    [350_000, "stronghold"],
  ];
  for (const [time, phase] of cases) {
    const e = at(L, time, SPAWN);
    assert.equal(
      deathKind(run([e]), e),
      "hungerReset",
      `a death_spawnpoint in the ${phase} is the routine reset`,
    );
  }
  const end = at(L, 450_000, SPAWN);
  assert.equal(deathKind(run([end]), end), "bedDeath", "in the End no bed sets a spawn: a real death");
  console.log("OK D1–D2: death_spawnpoint is a reset in all four phases before the End, a death in it");
}

// --- D3: a bare death. ------------------------------------------------------------------------
{
  for (const time of [50_000, 150_000, 350_000, 450_000]) {
    const e = at(L, time, DEATH);
    assert.equal(deathKind(run([e]), e), "death", `a bare death at ${time / 1000} s is a death`);
  }
  console.log("OK D3: a bare death is a death in every phase");
}

// --- D4: the dying player's own phase. ---------------------------------------------------------
{
  // Left has been in the End since 400 s; right, still in the Overworld, dies at a spawn it set.
  const e = at(R, 450_000, SPAWN);
  assert.equal(deathKind(run([e]), e), "hungerReset", "the opponent's End is not this player's");
  // And the other way round: right in the End, left's Nether reset is still a reset.
  const m: MatchInfo = { ...base, timelines: [at(R, 100_000, "story.enter_the_end"), at(L, 150_000, SPAWN)] };
  assert.equal(deathKind(m, m.timelines[1]!), "hungerReset");
  console.log("OK D4: a death is read by the dying player's own phase");
}

// --- D5: a restart puts the player back in the Overworld. ---------------------------------------
{
  const e = at(L, 460_000, SPAWN);
  const m = run([at(L, 420_000, "projectelo.timeline.reset"), e]);
  assert.equal(deathKind(m, e), "hungerReset", "after a restart the End is behind them: a reset again");
  console.log("OK D5: after a reset, a spawn-point death reads as a hunger reset");
}

// --- D6: not deaths. --------------------------------------------------------------------------
{
  for (const type of [
    "projectelo.timeline.dragon_death",
    "end.kill_dragon",
    "story.enter_the_end",
    "projectelo.timeline.reset",
  ]) {
    const e = at(L, 450_000, type);
    assert.equal(deathKind(run([e]), e), null, `${type} is not a player's death`);
  }
  console.log("OK D6: the dragon, a split and a restart are not deaths");
}

// --- D7, D8: the counts. -------------------------------------------------------------------------
{
  const m = run([
    at(L, 150_000, SPAWN), // reset
    at(L, 350_000, SPAWN), // reset
    at(L, 450_000, SPAWN), // End: real
    at(R, 60_000, DEATH), // real
    at(R, 450_000, SPAWN), // right never reached the End: reset
  ]);
  const metrics = computeMetrics(m);
  const [left, right] = base.players.map((p) => p.nickname) as [string, string];
  assert.equal(metrics.deaths, 2, "real deaths only: the End death and the bare death");
  assert.deepEqual(metrics.deathsByPlayer, { [left]: 1, [right]: 1 });
  assert.equal(onScreenDeaths(m), 5, "every death screen, resets included");
  // A run of resets only: no death to count, five screens to see.
  const resets = run([150_000, 250_000, 260_000, 350_000, 360_000].map((t) => at(L, t, SPAWN)));
  assert.equal(computeMetrics(resets).deaths, 0);
  assert.equal(onScreenDeaths(resets), 5);
  console.log("OK D7–D8: deaths counts real deaths per player; onScreenDeaths counts every screen");
}

// --- D9: one reading on real data. -----------------------------------------------------------------
{
  const names = readdirSync(fixtures).filter((n) => /^match-\d+\.json$/.test(n));
  assert.ok(names.length >= 10, "the fixtures are there");
  for (const name of names) {
    const m = load(name);
    const uuids = new Set(m.players.slice(0, 2).map((p) => p.uuid));
    const real = m.timelines.filter(
      (e) => uuids.has(e.uuid) && (deathKind(m, e) ?? "hungerReset") !== "hungerReset",
    );
    assert.equal(computeMetrics(m).deaths, real.length, `${name}: metrics.deaths is deathKind's count`);
    assert.ok(onScreenDeaths(m) >= real.length, `${name}: every real death is also on screen`);
  }
  console.log(`OK D9: metrics.deaths matches deathKind on all ${names.length} fixtures`);
}

console.log("matchScore.contract: all checks passed");
