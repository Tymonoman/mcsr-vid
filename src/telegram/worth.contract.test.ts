// Contract test for "Worth rendering today", the suggestions' morning-report sibling, written from
// the docs, not the code (CLAUDE.md "Blocked players", "Favourite players, then known";
// handbook/claude-md-reference.md "Worth rendering today").
//
// What the docs promise:
//  1. A blocked runner's match is never "worth rendering today", however it would otherwise rank —
//     both players known, a close finish, inside the window.
//  2. The gather reads the roster's (favouritePlayers) lists: one call per roster player.
//  3. "Known" is the suggestions' own definition: a favourite; else a measured draw ≥ 0.6, which
//     is authoritative either way; else Twitch followers ≥ knownFollowerThreshold (10,000) — here
//     from the dashboard scans' cache, never a profile call.
//
// Real matches from src/fixtures/ (dates moved into the three-day window); the MCSR lists and match
// fetches are fakes, the scans' cache sits in a temp media directory.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/telegram/worth.contract.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, DEFAULTS } from "../config.js";
import { dismissSuggestion } from "../dashboard/suggest.js";
import { findWorth, liveDeps, WATCH_ROSTER, type WorthDeps } from "./worth.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-worth-contract-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;

const NOW = Date.UTC(2026, 9, 14, 7);
const fixture = (id: number, hoursAgo: number): MatchInfo => ({
  ...(JSON.parse(
    readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8"),
  ) as MatchInfo),
  date: Math.floor(NOW / 1000) - hoursAgo * 3600,
});

// What the dashboard's scans have cached about Twitch: logins and follower counts, nothing else.
dismissSuggestion(0); // a valid cache, the way the app writes one
const cachePath = path.join(media, ".suggest-cache.json");
const follow = (count: number) => ({ count, fetchedAt: NOW });
writeFileSync(
  cachePath,
  JSON.stringify({
    ...JSON.parse(readFileSync(cachePath, "utf8")),
    dismissed: [],
    twitchLogins: {
      romuxii: "romuxii",
      BeefSalad: "beefsalad",
      Aquacorde: "aquacorde",
      bigstreamer: "big",
      almost: "almost",
      hackingnoises: null,
    },
    twitchFollowers: {
      romuxii: follow(50_000),
      beefsalad: follow(50_000),
      aquacorde: follow(50_000),
      big: follow(10_000),
      almost: follow(9_999),
    },
  }),
);

try {
  // --- 3. One definition of "known" -------------------------------------------------------------
  {
    const known = liveDeps().isKnown;
    assert.equal(known("PINNE"), true, "a favourite, any case — though Pinne's own measured draw is 0.46");
    assert.equal(known("hackingnoises"), true, "a measured 2.08 with no linked Twitch at all");
    assert.equal(known("romuxii"), false, "a measured 0.43 is authoritative over 50,000 cached followers");
    assert.equal(known("bigstreamer"), true, "unmeasured, 10,000 cached followers");
    assert.equal(known("almost"), false, "unmeasured, 9,999");
    assert.equal(known("never_seen"), false, "nothing cached, nothing measured");
    console.log("OK: worth's known is the suggestions' known");
  }

  // --- 2. The roster is the Settings tab's favourites ------------------------------------------------
  {
    assert.deepEqual(liveDeps().roster, DEFAULTS.favouritePlayers, "the favourites, as set");
    const saved = config.favouritePlayers;
    try {
      config.favouritePlayers = ["Infume"];
      assert.deepEqual(liveDeps().roster, ["Infume"], "a Settings change is the next gather's roster");
      config.favouritePlayers = [];
      assert.deepEqual(liveDeps().roster, WATCH_ROSTER, "emptied, the constant stands in");
      assert.deepEqual([...WATCH_ROSTER], DEFAULTS.favouritePlayers, "…which is the default roster");
    } finally {
      config.favouritePlayers = saved;
    }
    console.log("OK: the roster follows favouritePlayers");
  }

  // --- 1/2. A blocked runner's match is never worth rendering ---------------------------------------
  {
    // Every player here is known (above), every match finished inside three days with both VODs:
    // hackingnoises vs BeefSalad (a 0.28 s finish) and BlazeMind vs Aquacorde would both qualify.
    const matches = [fixture(13549300, 3), fixture(12902901, 5), fixture(13446429, 8)];
    const lists: string[] = [];
    const deps = (): WorthDeps => ({
      ...liveDeps(),
      listMatches: async (nickname) => {
        lists.push(nickname);
        return matches;
      },
      fetchMatch: async (id) => matches.find((m) => m.id === id)!,
      discover: async () => [],
      isTaken: () => false,
    });
    const savedBlocked = config.blockedPlayers;
    try {
      config.blockedPlayers = [];
      const open = await findWorth(NOW, deps());
      assert.deepEqual(
        open.matches.map((m) => m.matchId).sort(),
        [12902901, 13446429, 13549300],
        "sanity: unblocked, all three are worth rendering",
      );
      config.blockedPlayers = [...DEFAULTS.blockedPlayers];
      lists.length = 0;
      const found = await findWorth(NOW, deps());
      assert.deepEqual(
        found.matches.map((m) => m.matchId),
        [13446429],
        "Aquacorde's and BeefSalad's matches never are",
      );
      assert.ok(!found.matches.some((m) => /aquacorde|beefsalad/i.test(m.players)), "not even by name");
      assert.equal(lists.length, DEFAULTS.favouritePlayers.length, "one list call per roster player");
    } finally {
      config.blockedPlayers = savedBlocked;
    }
    console.log("OK: a blocked runner's match is never worth rendering");
  }

  console.log("worth.contract: all checks passed");
} finally {
  rmSync(media, { recursive: true, force: true });
}
