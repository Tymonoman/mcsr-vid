import assert from "node:assert/strict";
import { config } from "../config.js";
import type { MatchMetrics } from "../pipeline/matchScore.js";
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
// Under a tenth of a second the margin is milliseconds: "won by 0.0s" on the closest finish of
// the week read as a tie (seen on match 13132794, 35 ms).
assert.ok(factsLine(suggestion({}, { finishMarginMs: 35 })).includes("won by 35ms"));
assert.ok(factsLine(suggestion({}, { finishMarginMs: 100 })).includes("won by 0.1s"));

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

// --- favourite players: a recognisable name's match goes above an equal one ---------------------
// Inside a bucket the cards are ordered by popularity, not by score (the score only picks the slots
// at scan time), so the bonus is a multiple of popularity: half again for one favourite, twice for
// two. Every fixture below has the same score on purpose.
{
  const game = (
    matchId: number,
    players: [string, string],
    popularity = 10,
    over: Partial<Suggestion> = {},
  ): Suggestion => suggestion({ popularity, dateSec: daysAgo(2), ...over }, { matchId, players });
  const order = (
    raw: Suggestion[],
    favourites: string[],
    rival: Parameters<typeof presentSuggestions>[2] = [],
  ) => presentSuggestions(raw, NOW, rival, favourites).map((c) => c.matchId);

  // (a) equal score and equal popularity: the favourite's match first, wherever it arrives.
  const tie = [game(1, ["aaa", "bbb"]), game(2, ["doogile", "ccc"])];
  assert.deepEqual(order(tie, ["doogile"]), [2, 1], "a favourite's match sorts above an equal one");
  assert.deepEqual(order(tie, []), [1, 2], "without the list the tie keeps its arrival order");
  assert.deepEqual(order([...tie].reverse(), ["doogile"]), [2, 1], "arrival order is not what moved it");

  // (b) an empty list changes nothing: popularity alone, exactly as before the bonus existed.
  const mixed = [
    game(1, ["edcr", "doogile"], 30),
    game(2, ["aaa", "bbb"], 90),
    game(3, ["Feinberg", "ccc"], 50),
  ];
  assert.deepEqual(order(mixed, []), [2, 3, 1], "no favourites: the biggest audience first");
  assert.deepEqual(
    order(mixed, ["nobody"]),
    order(mixed, []),
    "a list naming nobody in the pool is the same as none",
  );

  // (c) case is ignored, spelling is not.
  assert.deepEqual(order(tie, ["DOOGILE"]), [2, 1], "the list may be typed in any case");
  assert.deepEqual(order([tie[0]!, game(2, ["Doogile", "ccc"])], ["doogile"]), [2, 1], "so may the API's");
  assert.deepEqual(order(tie, ["doog"]), [1, 2], "a prefix is not a match");
  assert.deepEqual(order([tie[0]!, game(2, ["doogile2", "ccc"])], ["doogile"]), [1, 2], "nor a longer name");

  // The size of it: a match a little more popular is passed, one clearly ahead is not.
  const passed = [game(1, ["aaa", "bbb"], 12), game(2, ["doogile", "ccc"], 10)];
  assert.deepEqual(order(passed, ["doogile"]), [2, 1], "a favourite passes a match a bit more popular");
  const ahead = [game(1, ["aaa", "bbb"], 40), game(2, ["doogile", "edcr"], 10)];
  assert.deepEqual(order(ahead, ["doogile"]), [1, 2], "but not one clearly ahead of it");
  assert.deepEqual(order(ahead, ["doogile", "edcr"]), [1, 2], "not even with both of them playing");
  const pair = [game(1, ["doogile", "aaa"]), game(2, ["doogile", "edcr"])];
  assert.deepEqual(
    order(pair, ["doogile", "edcr"]),
    [2, 1],
    "two favourites outrank one at equal popularity",
  );
  assert.deepEqual(order(pair, ["doogile", "doogile", "DOOGILE"]), [1, 2], "a name listed twice counts once");

  // What still outranks the bonus: a match about to expire, the rival's post, the other bucket.
  const fav = game(1, ["doogile", "edcr"], 50);
  const expiring = game(2, ["aaa", "bbb"], 1, { dateSec: daysAgo(9) });
  const plain = game(3, ["ddd", "eee"], 10);
  assert.deepEqual(order([fav, expiring, plain], ["doogile"]), [2, 1, 3], "an expiring match is still first");
  const rival = [
    {
      title: "GG!! | doogile vs edcr",
      publishedAtMs: NOW - 86_400_000,
      players: ["doogile", "edcr"] as [string, string],
    },
  ];
  assert.deepEqual(order([fav, plain], ["doogile"], rival), [3, 1], "the rival's matchup is still last");
  const chaos = game(4, ["doogile", "edcr"], 90, { bucket: "chaos" });
  assert.deepEqual(order([plain, chaos], ["doogile", "edcr"]), [3, 4], "buckets stay separate");

  // The nightly takes the first eligible card of `orderForDisplay`, which is the cards' order.
  const raw = [game(1, ["aaa", "bbb"], 12), game(2, ["doogile", "ccc"], 10), expiring];
  assert.deepEqual(
    orderForDisplay(raw, NOW, [], ["doogile"]).map((s) => s.metrics.matchId),
    order(raw, ["doogile"]),
    "the nightly's order is the cards' order, favourites included",
  );
  assert.equal(orderForDisplay(raw, NOW, [], ["doogile"])[1]!.metrics.matchId, 2);

  // The list is read from `config` on every call, so a Settings save re-orders the next read.
  config.favouritePlayers = ["doogile"];
  assert.deepEqual(
    presentSuggestions(tie, NOW, []).map((c) => c.matchId),
    [2, 1],
    "the live list applies",
  );
  assert.deepEqual(
    orderForDisplay(tie, NOW, []).map((s) => s.metrics.matchId),
    [2, 1],
    "to the nightly too",
  );
  config.favouritePlayers = [];
  assert.deepEqual(
    presentSuggestions(tie, NOW, []).map((c) => c.matchId),
    [1, 2],
    "and emptied, it is off",
  );

  console.log("OK: favourite players lift a match within its bucket, never past an expiring one");
}
