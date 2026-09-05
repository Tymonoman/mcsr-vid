import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  distinctShortMoments,
  leadChangeTimes,
  pickShortMoment,
  rankShortMoments,
  SHORT_WINDOW_SEC,
} from "./shortMoment.js";
import type { MatchInfo } from "./types.js";

const load = (id: number): MatchInfo => {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/match-${id}.json`, import.meta.url), "utf8"));
  return (raw.data ?? raw) as MatchInfo;
};

const optsFor = (m: MatchInfo) => ({
  leftUuid: m.players[0]!.uuid,
  rightUuid: m.players[1]!.uuid,
  runMs: m.result.time || 900_000,
});

// --- 12730175: edcr vs doogile. Both players died within seconds of each other mid-race, and
// the lead changed there. That beats the dragon kill, which is the point: the finish is the
// obvious moment and often not the best one.
{
  const match = load(12730175);
  const best = pickShortMoment(match, optsFor(match))!;
  assert.ok(best, "a match with events must yield a moment");
  assert.ok(
    best.startMs >= 390_000 && best.endMs <= 440_000,
    `expected the double-death window around 6:42, got ${best.startMs / 1000}-${best.endMs / 1000}s`,
  );
  assert.match(best.reason, /lead change/);
  assert.match(best.reason, /death/);
  const dragon = rankShortMoments(match, optsFor(match)).find((m) => m.reason.includes("dragon"));
  assert.ok(dragon === undefined || best.score > dragon.score, "the double death must outrank the dragon");
}

// --- Every window is exactly the configured length and lies inside the run.
{
  const match = load(12902901);
  const opts = optsFor(match);
  for (const m of rankShortMoments(match, opts)) {
    assert.equal(m.endMs - m.startMs, SHORT_WINDOW_SEC * 1000);
    assert.ok(m.startMs >= 0, `window starts before the match: ${m.startMs}`);
    assert.ok(m.events.length > 0, "a scored window must contain at least one scored event");
    for (const e of m.events) {
      assert.ok(e.time >= m.startMs && e.time < m.endMs, "an event was counted outside its window");
    }
  }
}

// --- Distinct moments must not overlap. With a 1s stride the raw ranking is the same window
// shifted by a second, over and over; offering that as "three options" offers one.
{
  const match = load(12902901);
  const picks = distinctShortMoments(match, optsFor(match), 3);
  assert.equal(picks.length, 3);
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const a = picks[i]!;
      const b = picks[j]!;
      assert.ok(a.endMs <= b.startMs || b.endMs <= a.startMs, `moments ${i} and ${j} overlap`);
    }
  }
  assert.ok(picks[0]!.score >= picks[1]!.score, "still ordered best first");
}

// --- Lead changes are located, not just counted. matchScore reports how many there were; a
// Short needs to know when, because that is the frame the window should be built around.
{
  const match = load(12929221);
  const flips = leadChangeTimes(match, match.players[0]!.uuid, match.players[1]!.uuid);
  assert.ok(flips.length >= 1, "this match's whole story is a lead change; it must be found");
  assert.ok(
    flips.every((t) => t > 0 && t <= match.result.time + 60_000),
    `a lead change landed outside the match: ${flips}`,
  );
  assert.deepEqual(
    [...flips].sort((a, b) => a - b),
    flips,
    "lead changes must be in time order",
  );
}

// --- A match whose timeline holds nothing worth watching yields nothing, rather than a
// confident window over `mine_stone`.
{
  const match = load(12902901);
  const empty: MatchInfo = { ...match, timelines: [] };
  assert.equal(pickShortMoment(empty, optsFor(match)), null);
  const noise: MatchInfo = {
    ...match,
    timelines: [
      { uuid: match.players[0]!.uuid, time: 10_000, type: "adventure.mine_stone" },
      { uuid: match.players[0]!.uuid, time: 20_000, type: "story.smelt_iron" },
    ],
  };
  assert.equal(pickShortMoment(noise, optsFor(match)), null, "unwatchable events must score nothing");
}

console.log("shortMoment: all checks passed");
