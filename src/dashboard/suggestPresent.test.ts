import assert from "node:assert/strict";
import { config, DEFAULTS } from "../config.js";
import type { MatchMetrics } from "../pipeline/matchScore.js";
import type { DrawLearned } from "./drawLearn.js";
import { nightlyEligible, pickNightlyCandidate } from "./nightly.js";
import { refreshPairPosts, type PairPost } from "./pairPosts.js";
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
    panelLeadChanges: 4,
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

// --- Ordering: five cards of one pair, so one tier and one audience (it is the players'): a match
// that is about to stop existing first, then close before chaos, then popularity.
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
  "expiring first, then the bucket, then popularity",
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

// --- A blocked player's card is dropped outright, not just sorted last (config.blockedPlayers):
// a stale cached list scanned before the player was blocked must not show their match either.
{
  const saved = config.blockedPlayers;
  config.blockedPlayers = ["edcr"];
  const withBlocked = presentSuggestions(
    [
      suggestion({ metrics: { ...suggestion().metrics, matchId: 40 } }), // edcr vs doogile
      suggestion({ metrics: { ...suggestion().metrics, matchId: 41, players: ["aaa", "bbb"] } }),
    ],
    NOW,
  );
  assert.deepEqual(
    withBlocked.map((c) => c.matchId),
    [41],
    "edcr's match is dropped outright, not just sorted last",
  );
  config.blockedPlayers = saved;
  console.log("OK: a blocked player's card never appears on the list");
}

// --- a rival having already posted the matchup no longer demotes it (18 Oct 2026, "render and
// post anyway") — the expiring card still comes first, but the rival's own card (21) now ranks on
// its audience like any other. Three known pairs and no favourites, so all three share tier 1.
{
  const rival = [
    {
      channel: "mcsrmatches",
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
      metrics: { ...suggestion().metrics, matchId: 22, players: ["Feinberg", "b"] },
    }),
    suggestion({
      popularity: 1,
      dateSec: daysAgo(9),
      metrics: { ...suggestion().metrics, matchId: 23, players: ["Infume", "d"] },
    }),
  ];
  const cards = presentSuggestions(raw, NOW, rival, []);
  assert.deepEqual(
    cards.map((c) => c.matchId),
    [23, 21, 22],
    "expiring first; the rival's own matchup (21) ranks on audience, not demoted for being posted",
  );
  assert.deepEqual(cards[1]!.rivalPosts, [
    {
      kind: "match",
      label: "@mcsrmatches posted this match (6 Sept)",
      title: "GG!! | edcr vs doogile | MCSR Ranked",
    },
  ]);
  assert.deepEqual(cards[2]!.rivalPosts, []);
  assert.deepEqual(
    orderForDisplay(raw, NOW, rival, []).map((s) => s.metrics.matchId),
    [23, 21, 22],
    "the nightly's order matches the card's — no demotion for either",
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
  assert.equal(ordered[1], 12, "then (one pair, one bucket) the more popular");
  console.log("OK: orderForDisplay matches the cards");
}

// A match between two named players, two days old, with a given audience; every one has the same score.
const game = (
  matchId: number,
  players: [string, string],
  popularity = 10,
  over: Partial<Suggestion> = {},
): Suggestion => suggestion({ popularity, dateSec: daysAgo(2), ...over }, { matchId, players });
// The display order's match ids with the favourites, the rival's posts and the pairs the channel put
// out lately all injected: none of it reads the live config or the snapshots.
const order = (
  raw: Suggestion[],
  favourites: string[],
  rival: Parameters<typeof presentSuggestions>[2] = [],
  posted: PairPost[] = [],
) => presentSuggestions(raw, NOW, rival, favourites, posted).map((c) => c.matchId);

// --- favourite players: a recognisable name's match goes above an equal one ---------------------
// A match with a favourite is a tier above any match with none; inside the tier the cards are ordered by
// audience (expected draw, counted up half again for one favourite and twice for two), not by score, and
// popularity only breaks the last tie. Every fixture below has the same score on purpose.
{
  // (a) equal score and equal popularity: the favourite's match first, wherever it arrives.
  const tie = [game(1, ["aaa", "bbb"]), game(2, ["doogile", "ccc"])];
  assert.deepEqual(order(tie, ["doogile"]), [2, 1], "a favourite's match sorts above an equal one");
  // Neutral names here, unlike `tie`: doogile's own measured draw (DEFAULT_DRAW, suggest.ts) would
  // make match 2 "known" on its own and defeat the point of an empty list.
  const tieNeutral = [game(1, ["aaa", "bbb"]), game(2, ["ccc", "ddd"])];
  assert.deepEqual(order(tieNeutral, []), [1, 2], "without the list the tie keeps its arrival order");
  assert.deepEqual(order([...tie].reverse(), ["doogile"]), [2, 1], "arrival order is not what moved it");

  // (b) an empty list, and nobody with a measured draw either: popularity alone, exactly as before
  // the bonus existed.
  const mixed = [game(1, ["aaa", "bbb"], 30), game(2, ["ccc", "ddd"], 90), game(3, ["eee", "fff"], 50)];
  assert.deepEqual(order(mixed, []), [2, 3, 1], "no favourites: the biggest audience first");
  assert.deepEqual(
    order(mixed, ["nobody"]),
    order(mixed, []),
    "a list naming nobody in the pool is the same as none",
  );

  // (c) case is ignored, spelling is not.
  assert.deepEqual(order(tie, ["DOOGILE"]), [2, 1], "the list may be typed in any case");
  assert.deepEqual(order([tie[0]!, game(2, ["Doogile", "ccc"])], ["doogile"]), [2, 1], "so may the API's");
  // A name with no measured draw, so the prefix check is not also a draw check.
  assert.deepEqual(
    order([game(1, ["aaa", "bbb"]), game(2, ["zylo", "ccc"])], ["zyl"]),
    [1, 2],
    "a prefix is not a match",
  );
  assert.deepEqual(order([tie[0]!, game(2, ["doogile2", "ccc"])], ["doogile"]), [1, 2], "nor a longer name");

  // The tier: a match with a favourite goes above every match with none, however popular that one is.
  const passed = [game(1, ["aaa", "bbb"], 12), game(2, ["doogile", "ccc"], 10)];
  assert.deepEqual(order(passed, ["doogile"]), [2, 1], "a favourite passes a match a bit more popular");
  const ahead = [game(1, ["aaa", "bbb"], 400), game(2, ["doogile", "edcr"], 10)];
  assert.deepEqual(order(ahead, ["doogile"]), [2, 1], "and one far ahead of it");
  const pair = [game(1, ["doogile", "aaa"]), game(2, ["doogile", "edcr"])];
  assert.deepEqual(
    order(pair, ["doogile", "edcr"]),
    [2, 1],
    "two favourites outrank one at equal popularity",
  );
  // A true tie needs the "other" player on each side to draw identically too — edcr is a real,
  // measured name, so this one pairs doogile with a neutral name on both sides instead of reusing
  // `pair` (whose second match leans on edcr for the assertion above).
  const pairTie = [game(1, ["doogile", "aaa"]), game(2, ["doogile", "bbb"])];
  assert.deepEqual(
    order(pairTie, ["doogile", "doogile", "DOOGILE"]),
    [1, 2],
    "a name listed twice counts once",
  );

  // The tier comes before a match about to expire and before the rival's post (1 Oct 2026, replacing
  // 30 Sept's "never past an expiring one": an expiring no-name card sat at #1 of 443).
  const fav = game(1, ["doogile", "edcr"], 50);
  const expiring = game(2, ["aaa", "bbb"], 1, { dateSec: daysAgo(9) });
  const plain = game(3, ["ddd", "eee"], 10);
  assert.deepEqual(
    order([fav, expiring, plain], ["doogile"]),
    [1, 2, 3],
    "the favourite before an expiring no-name",
  );
  const rival = [
    {
      channel: "mcsrmatches",
      title: "GG!! | doogile vs edcr",
      publishedAtMs: NOW - 86_400_000,
      players: ["doogile", "edcr"] as [string, string],
    },
  ];
  assert.deepEqual(
    order([fav, plain], ["doogile"], rival),
    [1, 3],
    "and a rival-posted favourite before a no-name",
  );
  // The bucket does not: a favourite pair's chaos goes above a close race of no names.
  const chaos = game(4, ["doogile", "edcr"], 90, { bucket: "chaos" });
  assert.deepEqual(order([plain, chaos], ["doogile", "edcr"]), [4, 3], "the bucket is not a rank");

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
    // tieNeutral, not tie: doogile's own measured draw would otherwise still rank match 2 first,
    // emptied list or not — the favourites *bonus* is off, but "known" is not only favourites.
    presentSuggestions(tieNeutral, NOW, []).map((c) => c.matchId),
    [1, 2],
    "and emptied, it is off",
  );

  console.log("OK: favourite players are a tier above no-name matches, an expiring one included");
}

// --- score (chaos/closeness) never decides this order: Report 2 found match quality uncorrelated
// with views once players are controlled for, so a known card with a dull score still outranks an
// unknown card with an exciting one. ------------------------------------------------------------
{
  const known = game(101, ["doogile", "zzz"], 10, { score: 0.1 });
  const unknownExciting = game(102, ["qqq", "rrr"], 10, { score: 0.95 });
  assert.deepEqual(
    order([unknownExciting, known], ["doogile"]),
    [101, 102],
    "a known card's low score does not cost it the top slot over an unknown card's high one",
  );
  console.log("OK: score never enters the cross-card order, only the known tier and the audience do");
}

// --- Three tiers (1 Oct 2026): a favourite, then a known player, then neither. A known player only
// lifts a match above the no-names, and a draw nobody measured is a prior from the following, not 1.0.
{
  config.knownFollowerThreshold = DEFAULTS.knownFollowerThreshold;
  const roster = ["doogile", "Feinberg", "Infume", "Pinne", "lowk3y_", "silverrruns"];
  const fol = (nickname: string, followers: number | null) => player({ nickname, followers });

  // hackingnoises (measured 2.08) is known, not a favourite: ten times the popularity stays below Pinne.
  const fav = game(311, ["Pinne", "aaa"], 20);
  const knownOnly = game(312, ["hackingnoises", "bbb"], 200);
  assert.deepEqual(order([knownOnly, fav], roster), [311, 312], "a favourite before a known player");

  // Both known, no favourite: hackingnoises + a stranger draw (2.08 + 0.5) / 2, a 30k grinder nobody
  // measured + a stranger (0.75 + 0.5) / 2. At a neutral 1.0 the grinder's 18 would have won.
  const measured = game(313, ["hackingnoises", "xxx"], 10);
  const grinder = game(314, ["grinder30k", "yyy"], 18, {
    profiles: [fol("grinder30k", 30_000), fol("yyy", null)],
  });
  assert.deepEqual(order([grinder, measured], []), [313, 314], "the unmeasured prior, not a neutral 1.0");

  // The replay of 1 Oct: ninananina (6.6k, never measured) vs _Hypn0tic topped the list and was the
  // nightly's pick. At 10,000 it is no-name, so its 185 cannot pass a favourite pair's 60.
  const nina = game(315, ["ninaStyle", "hypnoStyle"], 185, {
    bucket: "chaos",
    profiles: [fol("ninaStyle", 6_600), fol("hypnoStyle", 495)],
  });
  const favPair = game(316, ["zzz", "Feinberg"], 60);
  const picked = await pickNightlyCandidate(
    orderForDisplay([nina, favPair], NOW, [], roster, []),
    { processedIds: [], hiddenIds: new Set<number>(), freeMatches: 9 },
    nightlyEligible([], async () => true),
  );
  assert.equal(picked?.metrics.matchId, 316, "the nightly renders the favourite card");
  // Expected views, not ladder activity: silverrruns (1.93) vs Infume (1.19) is 2.525 x 2 favourites;
  // gothy666 (no measured draw, 278 followers: 0.5) vs silverrruns is 2.18 x 1.5 — at 3x the popularity.
  const twoNames = game(317, ["silverrruns", "Infume"], 100);
  const grinderFav = game(318, ["gothy666", "silverrruns"], 300, {
    profiles: [fol("gothy666", 278), fol("silverrruns", 58_000)],
  });
  assert.deepEqual(
    order([grinderFav, twoNames], roster),
    [317, 318],
    "two favourites over a grinder and one",
  );
  // Feinberg vs cofesho (606 followers: 0.5) is 1.09 + 0.25; a 10k longtail vs Feinberg is 1.09 + 0.375.
  const feinCofesho = game(319, ["Feinberg", "cofesho"], 300, {
    profiles: [fol("Feinberg", 281_000), fol("cofesho", 606)],
  });
  // Unmeasured, 10,000 followers exactly: the same 0.75 band Aquacorde's own measured draw used to
  // give, before he was blocked and his row removed from DEFAULT_DRAW (2 Oct 2026).
  const longtailFeinberg = game(320, ["longtail10k", "Feinberg"], 100, {
    profiles: [fol("longtail10k", 10_000), fol("Feinberg", 281_000)],
  });
  assert.deepEqual(
    order([feinCofesho, longtailFeinberg], roster),
    [320, 319],
    "the order follows the expected draw",
  );
  // The prior, not a neutral 1.0: the 10k longtail + Feinberg (1.465) above a 30k grinder nobody
  // measured and a stranger (0.75 + 0.25) — at 1.0 each the grinder's pair would have drawn 1.5.
  // All known, no roster.
  assert.deepEqual(
    order([grinder, longtailFeinberg], []),
    [320, 314],
    "an unmeasured grinder below the 10k longtail + Feinberg",
  );
  console.log(
    "OK: a favourite, then a known player, then neither; expected views; the unmeasured prior; the nightly follows",
  );
}

// --- One list across both buckets: the favourites' tier, then the audience; the bucket only breaks a tie --
// The live pool of 30 Sept 2026: one close race of no names (popularity 105) and silverrruns against
// Infume in the chaos bucket (231). The close card stayed first, so the nightly rendered the one the
// operator had refused ("no name players no one will click on that").
{
  const DAY = 86_400_000;
  const roster = ["doogile", "Feinberg", "Infume", "Pinne", "lowk3y_", "silverrruns"];
  const noNames = game(1, ["Unknwonc", "mayRNG"], 105);
  const famous = game(2, ["silverrruns", "Infume"], 231, { bucket: "chaos" });

  assert.deepEqual(order([noNames, famous], roster), [2, 1], "a favourite pair's chaos goes first");
  assert.equal(
    orderForDisplay([noNames, famous], NOW, [], roster, [])[0]!.metrics.matchId,
    2,
    "and it is the card the nightly takes",
  );

  // Two favourite pairs, one of them on the channel yesterday: the fresh one goes first, and without
  // the repeat the bigger audience would have.
  const again = game(3, ["silverrruns", "Infume"], 231, { bucket: "chaos" });
  const fresh = game(4, ["doogile", "Feinberg"], 150);
  const posted: PairPost[] = [{ players: ["Infume", "silverrruns"], atMs: NOW - DAY }];
  assert.deepEqual(order([again, fresh], roster, [], posted), [4, 3], "the fresh pair first");
  assert.deepEqual(order([again, fresh], roster, [], []), [3, 4], "the bigger audience without the repeat");

  // Nothing configured: a known pair's chaos above a no-name close race, and at an equal audience the
  // bucket breaks the tie — close, then chaos — in whatever order they arrive.
  assert.deepEqual(order([noNames, famous], []), [2, 1], "a known pair, bucket or not");
  const level = [game(5, ["ccc", "ddd"], 100, { bucket: "chaos" }), game(6, ["eee", "fff"], 100)];
  assert.deepEqual(order(level, []), [6, 5], "an equal audience: close before chaos");
  assert.deepEqual(order([...level].reverse(), []), [6, 5], "wherever they arrive");
  // Both known: nahhann (1.04) and a stranger draw 1.29, v_strid (0.8) and a stranger 1.05.
  assert.deepEqual(
    order([game(7, ["v_strid", "ggg"], 100), game(8, ["nahhann", "jjj"], 10, { bucket: "chaos" })], []),
    [8, 7],
    "the tiebreaker is only that: the audience first, whatever the bucket or the popularity",
  );
  // Inside the tier, after the audience, the bucket and then the popularity: one favourite and a
  // stranger each is one audience. Across the buckets the close race goes first though the chaos card
  // is the more popular; in one bucket the raw popularity does. Synthetic favourites, not the roster: a
  // real pair's own measured draw would break the exact tie this demonstration needs.
  const localFavs = ["fav1", "fav2"];
  const oneFavourite = game(12, ["fav1", "zzz"], 150);
  assert.deepEqual(
    order([game(13, ["fav2", "yyy"], 200, { bucket: "chaos" }), oneFavourite], localFavs),
    [12, 13],
    "the bucket comes before the popularity",
  );
  assert.deepEqual(
    order([oneFavourite, game(10, ["fav2", "yyy"], 200)], localFavs),
    [10, 12],
    "the raw popularity breaks the last tie",
  );

  // Expiring and the rival's post rank inside a tier, across the buckets too.
  const expiring = game(11, ["nnn", "ooo"], 1, { bucket: "chaos", dateSec: daysAgo(9) });
  assert.deepEqual(
    order([noNames, famous, expiring], roster),
    [2, 11, 1],
    "the favourites, then the expiring no-name",
  );
  const rival = [
    // The rival's names come off its titles already normalised: lowercase.
    {
      channel: "mcsrmatches",
      title: "x",
      publishedAtMs: NOW - DAY,
      players: ["silverrruns", "infume"] as [string, string],
    },
  ];
  assert.deepEqual(
    order([famous, noNames], roster, rival),
    [2, 1],
    "a rival-posted favourite pair before no-names",
  );
  const otherFavourites = game(9, ["doogile", "Feinberg"], 10);
  assert.deepEqual(
    order([famous, otherFavourites], roster, rival),
    [2, 9],
    "and ranks on its own audience, same tier — a rival's post no longer demotes it (18 Oct 2026)",
  );

  // The offline replay of the live pool: Jabo_ against sub5average, popular from appearances alone,
  // beat a Pinne match (38) and a lowk3y_ match (26) even counted up 1.5x. The tier puts the names
  // first — lowk3y_'s own match goes above Pinne's inside it, since lowk3y_'s measured draw (1.38) is
  // the bigger audience once draw counts (`DEFAULT_DRAW`, suggest.ts; Pinne's own is 0.46, so her
  // match needs the roster to be known at all: 0.46 does not clear `KNOWN_DRAW_MIN` on its own,
  // unlike lowk3y_'s, which is known with or without a roster).
  const jabo = game(21, ["Jabo_", "sub5average"], 108);
  const pinne = game(22, ["Pinne", "someone"], 38);
  const lowkey = game(23, ["lowk3y_", "another"], 26, { bucket: "chaos" });
  assert.deepEqual(
    order([jabo, pinne, lowkey], roster),
    [23, 22, 21],
    "a favourite's match goes above any no-name one, however popular",
  );
  assert.deepEqual(
    order([jabo, pinne, lowkey], []),
    [23, 21, 22],
    "an empty roster: lowk3y_'s own draw still clears the gate; Pinne's (0.46) does not, and draws below two strangers",
  );
  assert.equal(orderForDisplay([jabo, pinne, lowkey], NOW, [], roster, [])[0]!.metrics.matchId, 23);
  // The repeat demotion stays inside the tier: a Pinne pair the channel just put out still beats Jabo_.
  const pinnePosted: PairPost[] = [{ players: ["pinne", "someone"], atMs: NOW - DAY }];
  assert.deepEqual(order([jabo, pinne], roster, [], pinnePosted), [22, 21], "a repeated favourite pair");
  // The tier comes before expiring and before the rival's post.
  const expiringJabo = game(24, ["Jabo_", "sub5average"], 1, { dateSec: daysAgo(9) });
  assert.deepEqual(
    order([pinne, expiringJabo], roster),
    [22, 24],
    "the favourite before an expiring no-name",
  );
  const rivalPinne = [
    {
      channel: "mcsrmatches",
      title: "x",
      publishedAtMs: NOW - DAY,
      players: ["pinne", "someone"] as [string, string],
    },
  ];
  assert.deepEqual(
    order([pinne, jabo], roster, rivalPinne),
    [22, 21],
    "a rival-posted favourite before a no-name",
  );

  console.log("OK: a favourite's tier, then the audience across the buckets, then the bucket");
}

// --- a pair the channel just put out: half the audience ---------------------------------------
// The same multiplicative step as the favourites, and as soft: inside its tier a repeat stays above a
// card that draws less than half as much, and above the rest of its tier when its VODs are about to expire.
{
  const DAY = 86_400_000;
  // Neutral names throughout this block, not real players: it isolates REPEAT_FACTOR from the known
  // gate, and Feinberg/Infume's own measured draw (DEFAULT_DRAW, suggest.ts) would make the "repeat"
  // pair known on its own, favourites list or not.
  const posted: PairPost[] = [{ players: ["ccc", "ddd"], atMs: NOW - 2 * DAY }];
  const repeat = (matchId: number, popularity = 10, over: Partial<Suggestion> = {}) =>
    game(matchId, ["ccc", "ddd"], popularity, over);
  const fresh = (matchId: number, popularity = 10) => game(matchId, ["aaa", "bbb"], popularity);

  // Equal popularity: the repeat goes below, wherever it arrives.
  assert.deepEqual(order([repeat(1), fresh(2)], [], [], posted), [2, 1], "a repeat sorts below an equal one");
  assert.deepEqual(
    order([repeat(1), fresh(2)], [], [], []),
    [1, 2],
    "without the list the tie keeps its order",
  );
  assert.deepEqual(
    order([fresh(2), repeat(1)], [], [], posted),
    [2, 1],
    "arrival order is not what moved it",
  );

  // The pair is order-free and case-free: it is who played, not who was listed first.
  const swapped = [{ players: ["ddd", "CCC"] as [string, string], atMs: NOW - DAY }];
  assert.deepEqual(order([repeat(1), fresh(2)], [], [], swapped), [2, 1], "either order, any case");
  assert.deepEqual(
    order([game(1, ["ddd", "ccc"]), fresh(2)], [], [], posted),
    [2, 1],
    "the card's own order does not matter either",
  );
  // One of the two, or a longer name, is another pair.
  assert.deepEqual(order([game(1, ["ccc", "aaa"]), fresh(2)], [], [], posted), [1, 2], "one of them");
  assert.deepEqual(order([game(1, ["ccc", "ddd2"]), fresh(2)], [], [], posted), [1, 2], "a longer name");

  // Soft: halved, not dropped. Popularity cannot carry a repeat any more (a repeat 60, a fresh pair
  // 25: still below); a pair that draws more than twice as much can — all three known, tier 1.
  assert.deepEqual(
    order([repeat(1, 60), fresh(2, 25)], [], [], posted),
    [2, 1],
    "popularity does not soften it",
  );
  const strongPosted: PairPost[] = [{ players: ["hackingnoises", "ccc"], atMs: NOW - DAY }];
  const strongRepeat = game(1, ["hackingnoises", "ccc"]);
  assert.deepEqual(
    order([strongRepeat, game(2, ["v_strid", "ddd"])], [], [], strongPosted),
    [1, 2],
    "2.33 -> 1.17 beats 1.05",
  );
  assert.deepEqual(
    order([strongRepeat, game(2, ["nahhann", "ddd"])], [], [], strongPosted),
    [2, 1],
    "2.33 -> 1.17 loses to 1.29",
  );

  // An empty list changes nothing; the repeat is the only card, so it is still shown.
  const mixed = [game(1, ["eee", "fff"], 30), fresh(2, 90), repeat(3, 50)];
  assert.deepEqual(order(mixed, [], [], []), [2, 3, 1], "no posted pairs: popularity alone");
  assert.deepEqual(order([repeat(1)], [], [], posted), [1], "a demotion, never a skip");

  // What still outranks it: a match about to expire.
  assert.deepEqual(
    order([fresh(2, 50), repeat(1, 1, { dateSec: daysAgo(9) })], [], [], posted),
    [1, 2],
    "an expiring repeat is still first",
  );

  // With the favourites the demotion stays inside the tier: a pair of favourites that just went up is
  // still above a match of no names.
  const pair: [string, string] = ["doogile", "Feinberg"];
  const favs = ["doogile", "Feinberg"];
  const both = [game(2, ["aaa", "bbb"], 400), game(1, pair)];
  assert.deepEqual(order(both, favs, [], []), [1, 2], "two favourites go first");
  assert.deepEqual(
    order(both, favs, [], [{ players: pair, atMs: NOW }]),
    [1, 2],
    "and a repeat of them still does, whatever the no-name match's audience",
  );

  // The nightly's order is the cards' order, repeats included.
  const raw = [repeat(1, 12), fresh(2, 10), repeat(3, 40)];
  assert.deepEqual(
    orderForDisplay(raw, NOW, [], [], posted).map((s) => s.metrics.matchId),
    order(raw, [], [], posted),
    "orderForDisplay agrees with the cards",
  );

  // Read from the snapshot by default, inside `pairRepeatDays` of now, and off at 0.
  config.pairRepeatDays = 3;
  await refreshPairPosts(NOW, {
    uploads: async () => [
      {
        matchId: 900,
        record: {
          publishAt: null,
          privacyStatus: "public",
          uploadedAt: new Date(NOW - 2 * DAY).toISOString(),
        },
      },
    ],
    rendered: () => [],
    namesOf: async () => ["ccc", "ddd"],
  });
  const live = (days: number) => {
    config.pairRepeatDays = days;
    return presentSuggestions([repeat(1), fresh(2)], NOW, [], []).map((c) => c.matchId);
  };
  assert.deepEqual(live(3), [2, 1], "the snapshot's pair is demoted");
  assert.deepEqual(live(2), [1, 2], "two days ago is not within two days");
  assert.deepEqual(live(0), [1, 2], "0 is off");
  config.pairRepeatDays = 3;

  console.log("OK: a pair the channel just put out counts for half, softly");
}

// --- learnedDraw and recordPaceBoostSec (11 Oct 2026): both off by default, so every assertion
// above already pins "undefined learned/null boost is byte for byte" by never passing them. Here,
// on: a learned draw and a near-record finish each reorder inside a tier, same as the favourites
// bonus and the repeat demotion already do, and `orderForDisplay` agrees with the cards either
// way. `favourites`/`posted` are passed explicitly as `[]` throughout, rather than left at their
// live-snapshot defaults: an earlier block above left `ccc`+`ddd` in the real pairPosts snapshot
// as a posted pair, which would otherwise halve one of these fixtures by surprise.
{
  // Two unmeasured, unfollowed pairs tie on audience (both the UNMEASURED_DRAW floor) and fall to
  // popularity: the more popular one wins without either setting.
  const quieter = suggestion(
    { popularity: 10, dateSec: daysAgo(2) },
    { matchId: 601, players: ["aaa", "bbb"] },
  );
  const louder = suggestion(
    { popularity: 50, dateSec: daysAgo(2) },
    { matchId: 602, players: ["ccc", "ddd"] },
  );
  assert.deepEqual(
    presentSuggestions([quieter, louder], NOW, [], [], []).map((c) => c.matchId),
    [602, 601],
    "off: the tie falls to popularity",
  );

  // A learned draw for "aaa" (no DEFAULT_DRAW entry, no followers) outweighs the popularity gap.
  const learned: DrawLearned = {
    computedAt: NOW,
    channelMedian: 100,
    players: { aaa: { draw: 3, n: 5 } },
    pairs: {},
    videoViews: {},
  };
  assert.deepEqual(
    presentSuggestions([quieter, louder], NOW, [], [], [], undefined, learned).map((c) => c.matchId),
    [601, 602],
    "on: the learned draw outranks the quieter pair's own popularity",
  );
  assert.deepEqual(
    orderForDisplay([quieter, louder], NOW, [], [], [], undefined, learned).map((s) => s.metrics.matchId),
    [601, 602],
    "orderForDisplay agrees",
  );

  // Same shape, for the record-pace boost: a fast finish beats a slower, more popular match once
  // the boost is on, and does nothing while it is off (null, the default).
  const fastFinish = suggestion(
    { popularity: 10, dateSec: daysAgo(2) },
    { matchId: 603, players: ["eee", "fff"], resultMs: 400_000 },
  );
  const slowerBigger = suggestion(
    { popularity: 50, dateSec: daysAgo(2) },
    { matchId: 604, players: ["ggg", "hhh"], resultMs: 700_000 },
  );
  assert.deepEqual(
    presentSuggestions([fastFinish, slowerBigger], NOW, [], [], []).map((c) => c.matchId),
    [604, 603],
    "off (null): the tie still falls to popularity",
  );
  assert.deepEqual(
    presentSuggestions([fastFinish, slowerBigger], NOW, [], [], [], undefined, null, 420).map(
      (c) => c.matchId,
    ),
    [603, 604],
    "on: the sub-7:00 finish outranks the slower, more popular match",
  );
  assert.deepEqual(
    orderForDisplay([fastFinish, slowerBigger], NOW, [], [], [], undefined, null, 420).map(
      (s) => s.metrics.matchId,
    ),
    [603, 604],
    "orderForDisplay agrees",
  );
  console.log("OK: a learned draw and a near-record finish each reorder inside a tier, off by default");
}
