// Contract test for the morning report's "worth rendering today" and the block list (`worthCandidates`,
// src/telegram/worth.ts), from the docs alone (CLAUDE.md "Blocked players": a blocked match is "never
// 'worth rendering today'"; handbook/claude-md-reference.md, same bullet). Promises:
//
//   1. A blocked runner's match is never a candidate, however it would otherwise rank — both players
//      known, on the roster, newest, a real finished run.
//   2. Any case.
//   3. The control: the same feed with nobody blocked keeps the match.
// Real feed entries: the fixtures, re-dated to an hour ago.
// Run: MCSR_CONFIG=/nonexistent npx tsx src/telegram/worth.contract.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { FeedMatch, MatchInfo } from "../api/types.js";
import { config } from "../config.js";
import { worthCandidates } from "./worth.js";

const NOW = Date.UTC(2026, 9, 14, 7);
const feed = (id: number, hoursAgo: number): FeedMatch => {
  const m = JSON.parse(
    readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8"),
  ) as MatchInfo;
  return { ...m, date: Math.floor(NOW / 1000 - hoursAgo * 3600) };
};
// Everyone known and on the roster, nothing taken: only the block can remove a match.
const deps = {
  roster: ["BlazeMind", "Aquacorde", "hackingnoises", "BeefSalad", "edcr", "doogile"],
  isKnown: () => true,
  isTaken: () => false,
};
// The blocked runners' matches are the newest, so they would lead the list.
const today = [feed(12902901, 1), feed(13549300, 2), feed(12730175, 3)];
const ids = () => worthCandidates(today, NOW, deps).map((m) => m.id);

const saved = config.blockedPlayers;
try {
  config.blockedPlayers = [];
  assert.deepEqual(ids(), [12902901, 13549300, 12730175], "the control: all three, newest first");

  config.blockedPlayers = ["aquacorde", "BEEFSALAD"]; // any case
  assert.deepEqual(ids(), [12730175], "neither blocked runner's match is worth rendering, however it ranks");
  console.log("OK: a blocked runner's match is never 'worth rendering today'");
} finally {
  config.blockedPlayers = saved;
}

console.log("worth.contract: all checks passed");
