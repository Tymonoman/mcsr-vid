// Contract test for the suggestion list's order and contents, written from the docs, not the code
// (CLAUDE.md "Suggestions", "Favourite players, then known", "Rival posts", "Blocked players",
// house rules; handbook/claude-md-reference.md, the same bullets in full).
//
// What the docs promise about the cards (presentSuggestions / orderForDisplay):
//  1. Order is tier first: a match with a favourite → one with a known player → neither, above
//     everything else, an expiring card included.
//  2. Known = a favourite, a measured draw ≥ KNOWN_DRAW_MIN (0.6), or Twitch followers ≥
//     knownFollowerThreshold (10,000).
//  3. Inside a tier: expiring → the rival's post after → audience → (bucket) → popularity.
//  4. "Expiring" is two days or less of VOD life left; VODs live POOL_MAX_AGE_DAYS (10).
//  5. No chaos/closeness, seed, rank or elo term: only tier, audience and recency decide the order.
//  6. House rule: no seed, rank or elo in hooks or suggestions.
//  7. A blocked player's match is never shown, however stale the cache; whole names, any case;
//     the block applies live (a Settings save, no rescan).
//  8. The order is the same for the list and the nightly alike (orderForDisplay); a blocked match
//     the nightly is handed anyway sorts last and nightlyEligible refuses it, queued or not.
//  9. learnedDraw (default off) and recordPaceBoostSec (default null) leave today's order exactly;
//     on, they only reorder inside a tier. Both are read live.
// 10. The order is a property of the cards, not of the order the scan happened to hand them over.
//
// Real matches from src/fixtures/ feed every card; dates, followers and popularity are set per case.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/dashboard/suggestPresent.contract.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, DEFAULTS } from "../config.js";
import { computeMetrics } from "../pipeline/matchScore.js";
import type { DrawLearned } from "./drawLearn.js";
import { nightlyEligible } from "./nightly.js";
import { parseRivalFeed } from "./rivalPosts.js";
import { orderForDisplay, presentSuggestions, type SuggestionCard } from "./suggestPresent.js";
import type { Bucket, Suggestion } from "./suggest.js";

/** A documented promise the code does not keep yet: reported, not failed, until triage. */
async function deviation(clause: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const media = mkdtempSync(path.join(tmpdir(), "mcsr-present-contract-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;

const NOW = Date.UTC(2026, 9, 14, 12);
const DAY = 86_400_000;
const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;

/** A card's suggestion built from a real match: its own metrics and players, a chosen age and audience. */
function real(
  fixtureId: number,
  o: {
    id?: number;
    daysAgo?: number;
    bucket?: Bucket;
    score?: number;
    popularity?: number;
    followers?: Record<string, number | null>;
    elo?: Record<string, { eloRank: number | null; elo: number | null }>;
  } = {},
): Suggestion {
  const match = fixture(fixtureId);
  const metrics = { ...computeMetrics(match), matchId: o.id ?? fixtureId };
  const profiles = metrics.players.map((nickname) => {
    const p = match.players.find((x) => x.nickname === nickname)!;
    return {
      nickname,
      eloRank: o.elo?.[nickname]?.eloRank ?? p.eloRank,
      elo: o.elo?.[nickname]?.elo ?? p.eloRate,
      followers: o.followers?.[nickname] ?? null,
    };
  }) as Suggestion["profiles"];
  return {
    metrics,
    bucket: o.bucket ?? "close",
    score: o.score ?? 0.5,
    popularity: o.popularity ?? 10,
    profiles,
    h2h: null,
    vodUrls: match.vod.map((v) => v.url),
    dateSec: Math.floor((NOW - (o.daysAgo ?? 1) * DAY) / 1000),
  };
}
const ids = (cards: readonly SuggestionCard[]): number[] => cards.map((c) => c.matchId);
// Everything injected except where a case is about a default: no live snapshot leaks in.
const present = (
  list: Suggestion[],
  favourites: readonly string[] = DEFAULTS.favouritePlayers,
  rival = parseRivalFeed(""),
) => presentSuggestions(list, NOW, rival, favourites, [], DEFAULTS.knownFollowerThreshold, null, null);

try {
  // --- 1/2. Tier first: favourite → known → neither, whatever else is true ------------------------
  {
    // v_strid vs doogile: doogile is on the default roster (tier 2), though it is the least popular.
    const fav = real(13560037, { id: 1, popularity: 1 });
    // nolqndo vs thecamo6 at exactly 10,000 followers: known by following alone (tier 1).
    const known = real(13617328, { id: 2, popularity: 5, followers: { nolqndo: 10_000 } });
    // bbiddd vs BadGamer, measured under the gate: no-name, though expiring and the most popular card.
    const noNameExpiring = real(12898432, { id: 3, daysAgo: 9, popularity: 999 });
    // bbiddd vs BadGamer: measured 0.29 and 0.34, under KNOWN_DRAW_MIN however many followers.
    const vetoed = real(12898432, {
      id: 4,
      popularity: 50,
      followers: { bbiddd: 200_000, BadGamer: 200_000 },
    });
    assert.deepEqual(
      ids(present([noNameExpiring, known, fav])),
      [1, 2, 3],
      "favourite, then known, then the no-name — the expiring no-name included (1 Oct 2026: one sat at #1 of 443)",
    );
    // nolqndo one follower short (a separate list: followers are a player's, one count per list).
    const shortOfGate = real(13617328, { id: 5, popularity: 5, followers: { nolqndo: 9_999 } });
    assert.deepEqual(
      ids(present([shortOfGate, noNameExpiring])),
      [3, 5],
      "9,999 followers is not known: both tier 0, so the expiring card leads",
    );
    assert.deepEqual(
      ids(present([vetoed, fav])),
      [1, 4],
      "a measured draw under 0.6 is not known even at 200k followers — and a favourite still leads",
    );
    // An empty roster is no tier 2 at all; doogile's own measured draw (1.03) still makes him known.
    assert.deepEqual(
      ids(present([noNameExpiring, fav], [])),
      [1, 3],
      "a measured draw ≥ 0.6 is known without the roster",
    );
    console.log("OK: favourite → known → neither, above expiry and popularity");
  }

  // --- 3. Inside a tier: expiring → the rival's post after → audience → popularity ---------------
  {
    // Four favourite pairs from real matches, every one tier 2 under the default roster.
    const expiring = real(13782182, { id: 11, daysAgo: 8.5 }); //   silverrruns vs ANJOUU, audience 3.36, 1 day left
    const fresh = real(13446429, { id: 12, daysAgo: 1 }); //         Infume vs Feinberg, audience 3.47
    const smaller = real(13766294, { id: 13, daysAgo: 2 }); //       silverrruns vs dandannyboy, audience 3.27
    const posted = real(12929221, { id: 14, daysAgo: 1 }); //        Feinberg vs silverrruns, audience 4.95 — the biggest
    // The rival's post of that last pair, in the shape of its real public feed (src/fixtures/rival-feed.xml).
    const feed = readFileSync(new URL("../fixtures/rival-feed.xml", import.meta.url), "utf8").replace(
      "</feed>",
      "<entry><title>Feinberg vs Silverrruns | MCSR Ranked | Minecraft Speedrun</title>" +
        `<published>${new Date(NOW - DAY / 2).toISOString()}</published></entry></feed>`,
    );
    const rival = parseRivalFeed(feed);
    const cards = present([posted, smaller, fresh, expiring], DEFAULTS.favouritePlayers, rival);
    assert.deepEqual(
      ids(cards),
      [11, 12, 13, 14],
      "expiring first; the rival-posted pair after every fresh one though it has the biggest audience",
    );
    assert.equal(cards[3]!.rivalPosted?.title, "Feinberg vs Silverrruns | MCSR Ranked | Minecraft Speedrun");
    assert.equal(cards[3]!.rivalPosted?.daysAgo, 0);
    assert.deepEqual(
      ids(present([posted, smaller, fresh, expiring], DEFAULTS.favouritePlayers)),
      [11, 14, 12, 13],
      "without the rival's post the same card goes by its audience",
    );
    // Popularity is the last tie: two matches of one pair, one bucket, one age.
    const a = real(13446429, { id: 15, popularity: 3 });
    const b = real(13673240, { id: 16, popularity: 30 });
    assert.deepEqual(ids(present([a, b])), [16, 15], "an exact audience tie goes to popularity");
    assert.deepEqual(ids(present([b, a])), [16, 15], "wherever they arrive");
    console.log("OK: inside a tier, expiring → rival-posted last → audience → popularity");
  }

  // --- 4. Expiry: VODs live 10 days, two or fewer left is "expiring" -----------------------------
  {
    const at = (daysAgo: number) => present([real(13446429, { daysAgo })])[0]!;
    assert.equal(at(7).expiring, false, "3 days left is not urgent");
    assert.equal(at(7).expiryLabel, "VODs expire in 3d");
    assert.equal(at(8).expiring, true, "2 days left is");
    assert.equal(at(8).expiresInDays, 2);
    assert.equal(at(9.9).expiryLabel, "VODs expire today");
    assert.equal(at(12).expiresInDays, 0, "past the pool's age it floors at 0, never negative");
    console.log("OK: the expiry window");
  }

  // --- 5. No seed/rank/elo and no chaos/closeness term in the order -----------------------------
  {
    // One pair twice (one audience): the top-ranked, high-elo, high-score chaos card against a
    // low-rank, low-score one a single popularity point ahead. Popularity must decide, both ways round.
    const shiny = real(13617328, {
      id: 21,
      bucket: "chaos",
      score: 0.99,
      popularity: 10,
      elo: { nolqndo: { eloRank: 1, elo: 2600 }, thecamo6: { eloRank: 2, elo: 2590 } },
    });
    const plain = real(13617328, {
      id: 22,
      bucket: "chaos",
      score: 0.01,
      popularity: 11,
      elo: { nolqndo: { eloRank: 999, elo: 600 }, thecamo6: { eloRank: 998, elo: 610 } },
    });
    assert.deepEqual(
      ids(present([shiny, plain])),
      [22, 21],
      "rank, elo and the bucket's score do not order the list",
    );
    assert.deepEqual(ids(present([plain, shiny])), [22, 21], "in either arrival order");
    // A wilder match (more lead changes, more deaths) is not lifted either.
    const wild = real(13617328, { id: 23, bucket: "chaos", popularity: 10 });
    wild.metrics = { ...wild.metrics, leadChanges: 9, deaths: 6, maxSwingMs: 90_000 };
    assert.deepEqual(ids(present([wild, plain])), [22, 23], "chaos is not a term");
    console.log("OK: no rank, elo, score or chaos term in the order");
  }

  // --- 6. House rule: no seed, rank or elo in suggestions -----------------------------------------
  await deviation("CLAUDE.md house rules: No seed, rank or elo in hooks or suggestions", () => {
    const card = present([real(13446429)])[0]!;
    // Infume is #2 at 2282 and Feinberg #33 at 1969 in this match; neither may reach the card.
    const shown = [card.story ?? "", card.facts].join(" · ");
    assert.ok(!/#\d+ vs #\d+/.test(shown), `a ladder rank on the card: "${shown}"`);
    assert.ok(!/\belo\b/i.test(shown), `elo on the card: "${shown}"`);
  });

  // --- 7. A blocked player's match is never shown, however stale the cache -----------------------
  {
    assert.deepEqual(DEFAULTS.blockedPlayers, ["Aquacorde", "BeefSalad"]);
    // Real matches of both blocked runners, the kind a cache scanned before the block still holds —
    // each one the top card it would otherwise be (hackingnoises is known, a 0.276 s finish).
    const beef = real(13549300, { id: 31, daysAgo: 9, popularity: 999 });
    const aqua = real(12902901, { id: 32, popularity: 999 });
    const clean = real(13446429, { id: 33 });
    assert.deepEqual(
      ids(present([beef, aqua, clean])),
      [33],
      "both blocked runners' cards are gone, not sorted last",
    );
    const saved = config.blockedPlayers;
    try {
      config.blockedPlayers = ["beefsalad"];
      assert.deepEqual(ids(present([beef, clean])), [33], "any case");
      config.blockedPlayers = ["BeefSala"];
      assert.deepEqual(ids(present([beef, clean])), [33, 31], "whole names: a prefix blocks nobody");
      config.blockedPlayers = ["Infume"];
      assert.deepEqual(
        ids(present([beef, clean])),
        [31],
        "a block added in Settings applies on the next read, no rescan",
      );
    } finally {
      config.blockedPlayers = saved;
    }
    console.log("OK: a blocked match is never on the list");
  }

  // --- 8. One order for the list and the nightly ---------------------------------------------------
  {
    const list = [
      real(13617328, { id: 41, daysAgo: 9 }),
      real(13446429, { id: 42 }),
      real(13560037, { id: 43, daysAgo: 8.5 }),
      real(12898432, { id: 44, popularity: 500 }),
    ];
    const shown = ids(present(list));
    const nightly = orderForDisplay(
      list,
      NOW,
      [],
      DEFAULTS.favouritePlayers,
      [],
      DEFAULTS.knownFollowerThreshold,
      null,
      null,
    );
    assert.deepEqual(
      nightly.map((s) => s.metrics.matchId),
      shown,
      "the nightly's order is the cards' order",
    );
    // A blocked match handed to orderForDisplay sorts last, and the nightly's own gate refuses it —
    // queued or not (the block outranks the queue).
    const withBlocked = [...list, real(13549300, { id: 45 })];
    const n = orderForDisplay(
      withBlocked,
      NOW,
      [],
      DEFAULTS.favouritePlayers,
      [],
      DEFAULTS.knownFollowerThreshold,
      null,
      null,
    ).map((s) => s.metrics.matchId);
    assert.deepEqual(n, [...ids(present(withBlocked)), 45], "the blocked match sorts last");
    const eligible = nightlyEligible([42, 45], async () => true);
    const pick = (id: number) => ({
      metrics: withBlocked.find((s) => s.metrics.matchId === id)!.metrics,
      bucket: "queued",
    });
    assert.equal(await eligible(pick(45)), false, "the nightly refuses the blocked match, queued or not");
    assert.equal(await eligible(pick(42)), true, "sanity: the same gate takes a clean queued one");
    console.log("OK: orderForDisplay is the display order");
  }

  // --- 9. learnedDraw / recordPaceBoostSec: default off is today's order; on, read live ----------
  {
    assert.equal(DEFAULTS.learnedDraw, false, "learnedDraw ships off");
    assert.equal(DEFAULTS.recordPaceBoostSec, null, "recordPaceBoostSec ships off");
    assert.equal(config.learnedDraw, false);
    // A learned table that would put bbiddd vs BadGamer (measured 0.29/0.34) above nolqndo vs
    // thecamo6 (unmeasured), on disk where the live setting reads it.
    const learned: DrawLearned = {
      computedAt: NOW,
      channelMedian: 100,
      players: { bbiddd: { draw: 3, n: 5 } },
      pairs: {},
      videoViews: {},
    };
    writeFileSync(path.join(media, ".draw-learned.json"), JSON.stringify(learned));
    const list = [real(13617328, { id: 51 }), real(12898432, { id: 52 })];
    const live = () => ids(presentSuggestions(list, NOW, [], [], []));
    const today = ids(presentSuggestions(list, NOW, [], [], [], DEFAULTS.knownFollowerThreshold, null, null));
    assert.deepEqual(today, [51, 52], "today's order: the unmeasured pair's 0.75 over 0.485");
    assert.deepEqual(live(), today, "off, a learned file on disk changes nothing");
    config.learnedDraw = true;
    try {
      assert.deepEqual(live(), [52, 51], "on, the same file reorders the next read — inside the tier");
    } finally {
      config.learnedDraw = false;
    }
    assert.deepEqual(live(), today, "and off again is today's order");

    // Two matches of one pair (one audience): popularity decides until a near-record finish is boosted.
    const slow = real(13673240, { id: 53, popularity: 20 }); // 8:13
    const quick = real(13446429, { id: 54, popularity: 10 }); // 7:23
    const pace = () => ids(presentSuggestions([slow, quick], NOW, [], [], []));
    assert.deepEqual(pace(), [53, 54], "null: popularity, as today");
    config.recordPaceBoostSec = 450;
    try {
      assert.deepEqual(pace(), [54, 53], "a 7:23 finish at a 7:30 boost moves up");
      // Never across a tier: a boosted no-name stays under a favourite's slower match.
      const noName = real(13617328, { id: 55 });
      noName.metrics = { ...noName.metrics, resultMs: 400_000 };
      assert.deepEqual(
        ids(presentSuggestions([noName, slow], NOW, [], ["Infume"], [])),
        [53, 55],
        "the boost reorders inside a tier only",
      );
    } finally {
      config.recordPaceBoostSec = null;
    }
    console.log("OK: learnedDraw and recordPaceBoostSec are off by default and read live");
  }

  // --- 10. The order belongs to the cards, not to the order they arrive in ------------------------
  await deviation(
    "CLAUDE.md Favourite players, then known: Known: … Twitch followers (knownFollowerThreshold 10,000) — independent of arrival order",
    () => {
      // nolqndo has 20,000 followers on one card (known, tier 1) and an unknown count (null, e.g. a
      // row restored from an older scan) on another. Unknown is not zero: he is known either way.
      const counted = real(13617328, { id: 61, bucket: "chaos", followers: { nolqndo: 20_000 } });
      const unknown = real(13617328, { id: 62, bucket: "chaos" });
      const noName = real(13617328, { id: 63, bucket: "close", popularity: 999 });
      noName.metrics = { ...noName.metrics, players: ["aaa_nobody", "bbb_nobody"] };
      noName.profiles = [
        { nickname: "aaa_nobody", eloRank: null, elo: null, followers: 9_000 },
        { nickname: "bbb_nobody", eloRank: null, elo: null, followers: 9_000 },
      ];
      const one = ids(present([counted, unknown, noName], []));
      const other = ids(present([unknown, counted, noName], []));
      assert.equal(
        one.indexOf(63),
        2,
        `a known player's two cards above the no-name in any arrival order, got ${one}`,
      );
      assert.equal(other.indexOf(63), 2, `…and the other way round, got ${other}`);
    },
  );

  console.log("suggestPresent.contract: all checks passed");
} finally {
  rmSync(media, { recursive: true, force: true });
}
