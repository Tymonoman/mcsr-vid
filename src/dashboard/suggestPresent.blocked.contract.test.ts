// Contract test for the suggestion list and the block list (`presentSuggestions`,
// src/dashboard/suggestPresent.ts), from the docs alone (CLAUDE.md "Blocked players" and "Suggestions";
// handbook/claude-md-reference.md, same bullets). Promises:
//
//   1. A blocked match is "never shown however stale the cache": a list scanned before the runner was
//      blocked does not show his match on the next read, rescan or not.
//   2. It is dropped outright, not sorted last — a favourite opposite him does not bring it back.
//   3. Settings applies live both ways: unblocking shows the card again on the next read.
//   4. Either seat, any case.
// (The scan's own pool pruning — "dropped from the suggestion pool even if already in it" — is pinned
// by suggestSelect.test.ts through getSuggestions, which needs the whole scan harness.)
// Run: MCSR_CONFIG=/nonexistent npx tsx src/dashboard/suggestPresent.blocked.contract.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { MatchInfo } from "../api/types.js";
import { config, DEFAULTS } from "../config.js";
import { computeMetrics } from "../pipeline/matchScore.js";
import type { Suggestion } from "./suggest.js";
import { presentSuggestions } from "./suggestPresent.js";

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
const NOW = Date.UTC(2026, 9, 14);

/** A cached card for a real match, scored by the scan's own metrics, scanned yesterday. */
const card = (id: number): Suggestion => {
  const metrics = computeMetrics(fixture(id));
  return {
    metrics,
    bucket: "close",
    score: 0.5,
    popularity: 10,
    profiles: [
      { nickname: metrics.players[0], eloRank: null, elo: null, followers: null },
      { nickname: metrics.players[1], eloRank: null, elo: null, followers: null },
    ] as Suggestion["profiles"],
    h2h: null,
    vodUrls: ["a", "b"],
    dateSec: Math.floor(NOW / 1000) - 86_400,
  };
};
// The stale cache: scanned when nobody was blocked. Aquacorde's and BeefSalad's real matches, beside
// two clean ones — Aquacorde's opposite nobody special, BeefSalad's opposite a known name.
const cache = [12902901, 13549300, 12730175, 12929221].map(card);
const shown = (favourites: readonly string[] = []) =>
  presentSuggestions(cache, NOW, [], favourites, [], DEFAULTS.knownFollowerThreshold, null, null)
    .map((c) => c.matchId)
    .sort((a, b) => a - b);

const saved = config.blockedPlayers;
try {
  config.blockedPlayers = [];
  assert.deepEqual(shown(), [12730175, 12902901, 12929221, 13549300], "nobody blocked: all four cards");

  // --- 1/4. Blocked after the scan: gone on the next read, either seat, any case ---------------------
  config.blockedPlayers = ["AQUACORDE", "beefsalad"];
  assert.deepEqual(shown(), [12730175, 12929221], "the stale cache's blocked cards are not shown");
  console.log("OK: a blocked runner's card is never shown, however stale the cached list");

  // --- 2. Dropped, not demoted: a favourite on the other side does not save it -----------------------
  assert.deepEqual(
    shown(["hackingnoises", "BlazeMind"]),
    [12730175, 12929221],
    "favouriting the opponent does not bring a blocked match back",
  );
  console.log("OK: dropped outright, not just sorted last");

  // --- 3. Unblocking is live too --------------------------------------------------------------------
  config.blockedPlayers = ["Aquacorde"];
  assert.deepEqual(shown(), [12730175, 12929221, 13549300], "BeefSalad unblocked: his card returns at once");
  console.log("OK: a Settings change shows or hides the card on the very next read");
} finally {
  config.blockedPlayers = saved;
}

console.log("suggestPresent.blocked.contract: all checks passed");
