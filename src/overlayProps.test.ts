import assert from "node:assert/strict";
import { pickStats, eloAtMatchStart, computeSplits } from "./overlayProps.js";
import type { MatchInfo, UserDetails } from "./types.js";

const bucket = (played: number, wins: number, best: number) => ({
  playedMatches: { ranked: played, casual: 0 },
  wins: { ranked: wins, casual: 0 },
  loses: { ranked: played - wins, casual: 0 },
  forfeits: { ranked: 0, casual: 0 },
  completions: { ranked: played, casual: 0 },
  completionTime: { ranked: played * 600_000, casual: 0 },
  bestTime: { ranked: best, casual: 0 },
});

const user = (season: ReturnType<typeof bucket>) =>
  ({ statistics: { season, total: bucket(5247, 3352, 353_371) } }) as unknown as UserDetails;

// Mid-season: the live season bucket wins, and the overlay labels it SEASON.
{
  const { stats, scope } = pickStats(user(bucket(180, 130, 361_000)));
  assert.equal(scope, "SEASON");
  assert.equal(stats.playedMatches.ranked, 180);
}

// Just after a rollover the season bucket is empty (real API behaviour once season 11 closed).
// Falling back to career beats rendering "0 GAMES · 0.0% WR", but it must say CAREER.
{
  const { stats, scope } = pickStats(user(bucket(0, 0, 0)));
  assert.equal(scope, "CAREER");
  assert.equal(stats.playedMatches.ranked, 5247);
}

// A season bucket missing keys entirely must not throw — it's an untrusted API shape.
{
  const { scope } = pickStats({ statistics: { season: {}, total: bucket(10, 5, 1) } } as unknown as UserDetails);
  assert.equal(scope, "CAREER");
}

// Real numbers from match 12730175 (edcr vs doogile, 2026-08-24). The API reports each player's
// POST-match rating plus the delta, so the rating carried into the match is eloRate - change.
// This is the bug viewers saw: the render two days later showed edcr at 2615, not 2546.
const match = {
  changes: [
    { uuid: "edcr", change: 15, eloRate: 2561 },
    { uuid: "doogile", change: -15, eloRate: 2425 },
  ],
} as unknown as MatchInfo;

assert.equal(eloAtMatchStart(match, "edcr", 2615), 2546);
assert.equal(eloAtMatchStart(match, "doogile", 2370), 2440);
// The gap the overlay shows must be the real one (106), not the render-time one (245).
assert.equal(eloAtMatchStart(match, "edcr", 2615) - eloAtMatchStart(match, "doogile", 2370), 106);

// Unknown player, or a match with no rating attached, falls back to the live value...
assert.equal(eloAtMatchStart(match, "nobody", 1234), 1234);
assert.equal(
  eloAtMatchStart({ changes: [{ uuid: "edcr", change: null, eloRate: null }] } as unknown as MatchInfo, "edcr", 1234),
  1234,
);
// ...and a null live value degrades to 0 rather than rendering "null ELO".
assert.equal(eloAtMatchStart(match, "nobody", null), 0);

// computeSplits feeds both the on-screen splits panel and the Kdenlive marker positions, so a
// wrong key or a wrong occurrence ships a misaligned video with nothing failing loudly.
const splitTimeline = [
  // The API returns timelines newest-first, and a type can repeat: this run blind-travelled twice.
  { uuid: "L", type: "projectelo.timeline.blind_travel", time: 400_000 },
  { uuid: "L", type: "projectelo.timeline.blind_travel", time: 300_000 },
  { uuid: "L", type: "story.enter_the_nether", time: 100_000 },
  { uuid: "R", type: "story.enter_the_nether", time: 110_000 },
  { uuid: "R", type: "nether.find_bastion", time: 150_000 },
  { uuid: "OTHER", type: "story.enter_the_nether", time: 1 },
];

{
  const splits = computeSplits({ timelines: splitTimeline } as unknown as MatchInfo, "L", "R");

  // The label set and its order are what the overlay renders top-to-bottom.
  assert.deepEqual(
    splits.map((s) => s.label),
    ["Nether Enter", "Bastion", "Fortress", "Blind", "End Enter"],
  );

  const by = (label: string) => splits.find((s) => s.label === label)!;
  assert.deepEqual(by("Nether Enter"), { label: "Nether Enter", leftMs: 100_000, rightMs: 110_000 });
  // A milestone the player never reached is null, not 0 — 0 would render as "0:00.000".
  assert.deepEqual(by("Bastion"), { label: "Bastion", leftMs: null, rightMs: 150_000 });
  assert.deepEqual(by("Fortress"), { label: "Fortress", leftMs: null, rightMs: null });
  // The repeated blind travel resolves to the FIRST time the milestone was reached.
  assert.equal(by("Blind").leftMs, 300_000);
}

// Same events, ascending order: the answer must not depend on how the API happens to sort.
{
  const ascending = [...splitTimeline].reverse();
  const splits = computeSplits({ timelines: ascending } as unknown as MatchInfo, "L", "R");
  const blind = splits.find((s) => s.label === "Blind")!;
  assert.equal(blind.leftMs, 300_000);
  assert.equal(splits.find((s) => s.label === "Nether Enter")!.leftMs, 100_000);
}

console.log("overlayProps: all checks passed");
