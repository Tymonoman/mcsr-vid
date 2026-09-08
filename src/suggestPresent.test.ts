import assert from "node:assert/strict";
import type { MatchMetrics } from "./matchScore.js";
import { factsLine, orderForDisplay, presentSuggestions, storyLine } from "./suggestPresent.js";
import type { Bucket, Suggestion, SuggestionPlayer } from "./suggest.js";

const NOW = Date.UTC(2026, 8, 7);
const daysAgo = (n: number): number => Math.floor((NOW - n * 86_400_000) / 1000);

const player = (over: Partial<SuggestionPlayer> = {}): SuggestionPlayer => ({
  nickname: "edcr",
  eloRank: 4,
  elo: 2130,
  followers: 8143,
  ...over,
});

function suggestion(over: Partial<Suggestion> = {}, metricsOver: Partial<MatchMetrics> = {}): Suggestion {
  const metrics: MatchMetrics = {
    matchId: 12730175,
    players: ["edcr", "doogile"],
    winner: "edcr",
    resultMs: 496_000,
    splits: [],
    finishMarginMs: 221,
    finishEstimated: false,
    splitsWithin3s: 4,
    comparedSplits: 9,
    maxLeadMs: 10_086,
    leadChanges: 4,
    maxSwingMs: 0,
    deaths: 3,
    deathsByPlayer: { edcr: 3 },
    ...metricsOver,
  };
  return {
    metrics,
    bucket: "close" as Bucket,
    score: 0.64,
    popularity: 10,
    profiles: [player(), player({ nickname: "doogile", eloRank: 11, elo: 1980, followers: 2300 })],
    h2h: { leftWins: 2, rightWins: 1 },
    vodUrls: ["a", "b"],
    dateSec: daysAgo(1),
    ...over,
  };
}

// --- The story line: everything known, in the order the operator reads it.
const full = suggestion();
assert.equal(
  storyLine(full.profiles, full.h2h),
  "#4 vs #11 · 2130 v 1980 elo · rematch 2–1 · 8.1k + 2.3k followers",
);

// A pairwise part needs both sides, or it says nothing: "#4 vs #null" is worse than silence.
assert.equal(
  storyLine(
    [player({ eloRank: null }), player({ nickname: "doogile", eloRank: 11, elo: 1980, followers: 2300 })],
    null,
  ),
  "2130 v 1980 elo · 8.1k + 2.3k followers",
);
assert.equal(
  storyLine(
    [
      player({ elo: null, followers: null }),
      player({ nickname: "doogile", eloRank: 11, elo: 1980, followers: null }),
    ],
    null,
  ),
  "#4 vs #11",
);
// One known follower count is still worth showing, but it has to say whose.
assert.equal(
  storyLine(
    [
      player({ eloRank: null, elo: null }),
      player({ nickname: "doogile", eloRank: null, elo: null, followers: null }),
    ],
    null,
  ),
  "edcr 8.1k followers",
);
// Nothing known at all -> no line, rather than an empty separator run.
assert.equal(
  storyLine(
    [
      player({ eloRank: null, elo: null, followers: null }),
      player({ nickname: "doogile", eloRank: null, elo: null, followers: null }),
    ],
    { leftWins: 0, rightWins: 0 },
  ),
  null,
);
// A pair that has never met in ranked is not a rivalry.
assert.ok(!storyLine(full.profiles, { leftWins: 0, rightWins: 0 })!.includes("rematch"));

// --- Facts: words, not glyphs.
assert.equal(factsLine(full), "8:16 · won by 0.2s · 4 lead changes · 3 deaths");
assert.equal(
  factsLine(suggestion({}, { finishMarginMs: null, leadChanges: 1, deaths: 1 })),
  "8:16 · DNF · 1 lead change · 1 death",
);
// An estimated margin came from the killing blow, not the death animation; say so.
assert.ok(factsLine(suggestion({}, { finishEstimated: true })).includes("won by ~0.2s"));

// --- Ordering: popularity within a bucket, except a match that is about to stop existing.
const cards = presentSuggestions(
  [
    suggestion({ popularity: 30, metrics: { ...suggestion().metrics, matchId: 1 } }),
    suggestion({ popularity: 90, metrics: { ...suggestion().metrics, matchId: 2 } }),
    // Nine days old: one day of VOD life left, so it outranks a far more popular match.
    suggestion({ popularity: 1, dateSec: daysAgo(9), metrics: { ...suggestion().metrics, matchId: 3 } }),
    suggestion({ bucket: "chaos", popularity: 50, metrics: { ...suggestion().metrics, matchId: 4 } }),
    suggestion({ bucket: "chaos", popularity: 70, metrics: { ...suggestion().metrics, matchId: 5 } }),
  ],
  NOW,
);
assert.deepEqual(
  cards.map((c) => c.matchId),
  [3, 2, 1, 5, 4],
  "expiring first inside its own bucket, then popularity; buckets stay separate",
);
assert.equal(cards[0]!.expiresInDays, 1);
assert.equal(cards[0]!.expiryLabel, "VODs expire in 1d");
assert.equal(cards[0]!.expiring, true);
assert.equal(cards[1]!.expiring, false, "9 days of VOD life left is not urgent");
assert.equal(cards[1]!.expiryLabel, "VODs expire in 9d");
// Past the pool's own age limit the label must not go negative.
assert.equal(
  presentSuggestions([suggestion({ dateSec: daysAgo(20) })], NOW)[0]!.expiryLabel,
  "VODs expire today",
);

console.log("suggestPresent: ok");

// --- a matchup the rival already posted goes after the fresh ones, but never above an expiring one
{
  const rival = [
    {
      title: "GG!! | edcr vs doogile | MCSR Ranked",
      publishedAtMs: NOW - 86_400_000,
      players: ["edcr", "doogile"] as [string, string],
    },
  ];
  const raw = [
    suggestion({
      popularity: 90,
      dateSec: daysAgo(2),
      metrics: { ...suggestion().metrics, matchId: 21, players: ["edcr", "doogile"] },
    }),
    suggestion({
      popularity: 10,
      dateSec: daysAgo(2),
      metrics: { ...suggestion().metrics, matchId: 22, players: ["a", "b"] },
    }),
    suggestion({
      popularity: 1,
      dateSec: daysAgo(9),
      metrics: { ...suggestion().metrics, matchId: 23, players: ["c", "d"] },
    }),
  ];
  const cards = presentSuggestions(raw, NOW, rival);
  assert.deepEqual(
    cards.map((c) => c.matchId),
    [23, 22, 21],
    "expiring, then fresh, then the rival's matchup last despite its audience",
  );
  assert.deepEqual(cards[2]!.rivalPosted, { daysAgo: 1, title: "GG!! | edcr vs doogile | MCSR Ranked" });
  assert.equal(cards[1]!.rivalPosted, null);
  assert.deepEqual(
    orderForDisplay(raw, NOW, rival).map((s) => s.metrics.matchId),
    [23, 22, 21],
    "the nightly demotes it too",
  );
}

// --- the nightly must pick what the operator sees first --------------------------------------
// orderForDisplay is the presenter's order applied back to the suggestions themselves, so the
// nightly's "will render X" and card #1 cannot disagree the way they did on the live channel.
{
  const raw = [
    suggestion({ popularity: 1, dateSec: daysAgo(1), metrics: { ...suggestion().metrics, matchId: 11 } }),
    suggestion({ popularity: 9, dateSec: daysAgo(1), metrics: { ...suggestion().metrics, matchId: 12 } }),
    suggestion({ popularity: 5, dateSec: daysAgo(9), metrics: { ...suggestion().metrics, matchId: 13 } }),
  ];
  const ordered = orderForDisplay(raw, NOW).map((s) => s.metrics.matchId);
  const shown = presentSuggestions(raw, NOW).map((c) => c.matchId);
  assert.deepEqual(ordered, shown, "the nightly's order must be the display order");
  assert.equal(ordered[0], 13, "an expiring match still comes first, as on the cards");
  assert.equal(ordered[1], 12, "then the biggest audience");
  console.log("OK: orderForDisplay matches the cards");
}
