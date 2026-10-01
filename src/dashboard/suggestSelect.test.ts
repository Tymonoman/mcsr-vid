// Which matches reach the list. A scan gives the slots to the matches with a favourite player first, then
// to the best scores, a favourite's counted up (FAVOURITE_BONUS); the score kept on the card stays the
// bucket's own; and a cache of an older layout is rebuilt without losing what the operator dismissed.
// Run: npx tsx src/dashboard/suggestSelect.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { DEFAULT_WEIGHTS, type MatchMetrics } from "../pipeline/matchScore.js";
import {
  DEFAULT_DRAW,
  dismissSuggestion,
  drawFactorFor,
  favouriteFactorFor,
  getSuggestions,
  KNOWN_DRAW_MIN,
  knownPlayerFor,
  knownTierFor,
} from "./suggest.js";

// --- The factor: half again per favourite, whole names, any case ----------------------------------
const factor = favouriteFactorFor(["doogile", "Feinberg"]);
assert.equal(factor(["aaa", "bbb"]), 1);
assert.equal(factor(["Doogile", "bbb"]), 1.5, "the list and the API may differ in case");
assert.equal(factor(["FEINBERG", "doogile"]), 2);
assert.equal(factor(["doogile2", "Feinber"]), 1, "whole names, not prefixes");
assert.equal(favouriteFactorFor([])(["doogile", "Feinberg"]), 1, "an empty list is no bonus");

// --- known(name): favourite, else a measured draw (DEFAULT_DRAW, n>=3 rows of draw.json) if one
// exists, else Twitch followers. A measured draw is authoritative either way (1 Oct 2026).
{
  assert.equal(KNOWN_DRAW_MIN, 0.6, "named, not a bare number in knownPlayerFor");
  const noFollowers = () => null;
  const known = knownPlayerFor([], noFollowers, 1_000);
  // hackingnoises: a high measured draw (2.08) with no cached Twitch follower count at all — the
  // scenario that motivated reading draw.json before followers.
  assert.equal(DEFAULT_DRAW["hackingnoises"], 2.08);
  assert.equal(known("hackingnoises"), true, "a high measured draw is known with no follower data");
  // romuxii: 1,962 real followers, but a measured draw (0.43) under KNOWN_DRAW_MIN — the draw wins.
  assert.equal(known("romuxii"), false, "a low measured draw overrides a follower count");
  assert.equal(knownPlayerFor([], () => 50_000, 1_000)("romuxii"), false, "even a huge one");
  // Never measured (n < 3, or not in draw.json at all): falls back to followers.
  assert.equal(knownPlayerFor([], () => 1_000, 1_000)("nobody_ever_measured"), true);
  assert.equal(knownPlayerFor([], () => 999, 1_000)("nobody_ever_measured"), false);
  // A favourite is known regardless of either: it is checked first.
  assert.equal(knownPlayerFor(["romuxii"], noFollowers, 1_000)("romuxii"), true);
  // The match-level tier needs only one known player (favourite ⊂ known, mirroring favouriteTierFor).
  const tier = knownTierFor([], noFollowers, 1_000);
  assert.equal(tier(["hackingnoises", "romuxii"]), true, "one known player is enough");
  assert.equal(tier(["romuxii", "nobody_ever_measured"]), false);
  // drawFactorFor: the simple average, 1.0 (neutral) for anyone never measured.
  assert.equal(drawFactorFor(["hackingnoises", "nobody_ever_measured"]), (2.08 + 1.0) / 2);
  assert.equal(drawFactorFor(["a", "b"]), 1, "two unmeasured names average to neutral");
  console.log("OK: knownPlayerFor/knownTierFor/drawFactorFor — a measured draw overrides followers");
}

// --- The scan: no network, no Twitch; the pool is in the cache -----------------------------------
delete process.env.TWITCH_CLIENT_ID;
delete process.env.TWITCH_CLIENT_SECRET;
const media = await mkdtemp(path.join(tmpdir(), "mcsr-select-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
config.suggestCloseSlots = 2;
config.suggestChaosSlots = 0;
config.suggestWeights = { ...DEFAULT_WEIGHTS };
config.suggestFastRunTargetSec = 420;
config.suggestSlowRunCutoffSec = 600;
// The feed and every roster player's own list (getSuggestions's pool-coverage pass) are both empty,
// and nothing else may be asked: the selection is all that is under test.
globalThis.fetch = (async (url: string) => {
  const u = String(url);
  if (
    !u.startsWith("https://api.mcsrranked.com/matches") &&
    !u.startsWith("https://api.mcsrranked.com/users/")
  )
    throw new Error(`unexpected ${url}`);
  return { ok: true, json: async () => ({ status: "success", data: [] }) };
}) as unknown as typeof fetch;

const cachePath = path.join(media, ".suggest-cache.json");
const nowSec = Math.floor(Date.now() / 1000);
// A close race scored on its finish margin alone: 3 of the weights' 8.5 times (1 - margin / 15 s).
const pooled = (matchId: number, players: [string, string], finishMarginMs: number) => ({
  metrics: {
    matchId,
    players,
    winner: players[0],
    resultMs: 700_000,
    splits: [],
    finishMarginMs,
    finishEstimated: false,
    splitsWithin3s: 0,
    comparedSplits: 0,
    maxLeadMs: 60_000,
    leadChanges: 0,
    maxSwingMs: 0,
    deaths: 0,
    deathsByPlayer: {},
  } satisfies MatchMetrics,
  profiles: players.map((nickname) => ({ nickname, eloRank: null, elo: null })),
  h2h: null,
  vodUrls: ["a", "b"],
  dateSec: nowSec - 86_400,
  scoredAt: Date.now(),
});
// "hhh"/"iii" stand in for a favourite here, not doogile/Feinberg: both carry a measured draw
// (DEFAULT_DRAW, suggest.ts) that would make their matches "known" on its own, favourites list or
// not, defeating the no-favourites baseline this pool exists to set.
const pool = Object.fromEntries(
  [
    pooled(10, ["aaa", "bbb"], 0), //            0.353
    pooled(20, ["ccc", "ddd"], 1_500), //        0.318
    pooled(30, ["hhh", "eee"], 4_500), //        0.247, x1.5 = 0.371
    pooled(40, ["hhh", "iii"], 9_000), //        0.141, x2   = 0.282
    pooled(50, ["fff", "ggg"], 3_000), //        0.282
  ].map((entry) => [String(entry.metrics.matchId), entry]),
);

try {
  // A valid cache the way the app writes one, with the pool put in and a scan long overdue.
  dismissSuggestion(0);
  const fresh = JSON.parse(await readFile(cachePath, "utf8"));
  await writeFile(cachePath, JSON.stringify({ ...fresh, dismissed: [], pool, scannedAt: 0 }), "utf8");

  const listed = async (favourites: string[]) => {
    config.favouritePlayers = favourites;
    return getSuggestions({ force: true });
  };
  const ids = async (favourites: string[]) =>
    (await listed(favourites)).suggestions.map((s) => s.metrics.matchId);

  assert.deepEqual(await ids([]), [10, 20], "by score alone: the two best");
  assert.deepEqual(
    await ids(["hhh"]),
    [30, 40],
    "the matches with a favourite take both slots, though the two best scores are no-name matches",
  );
  assert.deepEqual(
    await ids(["Hhh", "III"]),
    [30, 40],
    "in any case, and a weak favourite's match (0.141) still beats a clearly better no-name one",
  );
  assert.deepEqual(
    await ids([]),
    [10, 20],
    "and with the list emptied the next scan is back to scores alone",
  );

  // The card keeps the bucket's own score: comparable, and what the TUI prints.
  const card = (await listed(["hhh"])).suggestions.find((s) => s.metrics.matchId === 30)!;
  assert.ok(
    Math.abs(card.score - (3 * (1 - 4_500 / 15_000)) / 8.5) < 1e-9,
    `the raw score, not ${card.score}`,
  );
  console.log("OK: a favourite's match reaches the list at scan time, with its own score");

  // A new selection needs no cache bump: every scan runs take() over the pool the cache keeps, and the
  // five re-selections above have not touched it.
  const saved = JSON.parse(await readFile(cachePath, "utf8"));
  assert.deepEqual(Object.keys(saved.pool).sort(), ["10", "20", "30", "40", "50"], "the pool outlives them");

  // --- A cache of an older layout: the pool is rebuilt, the operator's dismissals are not lost ---
  await writeFile(
    cachePath,
    JSON.stringify({ ...saved, version: 3, dismissed: [777], scannedAt: Date.now() }),
    "utf8",
  );
  const rebuilt = await listed([]);
  assert.deepEqual(
    rebuilt.suggestions,
    [],
    "the old pool is gone: it comes back from the feed, which is empty here",
  );
  const after = JSON.parse(await readFile(cachePath, "utf8"));
  assert.deepEqual(after.dismissed, [777], "a dismissed match does not come back");
  assert.notEqual(after.version, 3, "the cache is written in today's layout");
  console.log("OK: an older cache is rebuilt and keeps its dismissals");

  // --- The live shape: Jabo_ against sub5average has the best score, Pinne and lowk3y_ weak ones ---
  // A bonus alone left the no-name pair in the list ahead of both; the tier gives the slots to the names.
  const current = JSON.parse(await readFile(cachePath, "utf8"));
  const names = Object.fromEntries(
    [
      pooled(61, ["Jabo_", "sub5average"], 0), //     0.353
      pooled(62, ["Pinne", "someone"], 9_000), //     0.141
      pooled(63, ["lowk3y_", "another"], 11_000), //  0.094
    ].map((entry) => [String(entry.metrics.matchId), entry]),
  );
  await writeFile(
    cachePath,
    JSON.stringify({ ...current, dismissed: [], pool: names, scannedAt: 0 }),
    "utf8",
  );
  assert.deepEqual(
    await ids(["Pinne", "lowk3y_"]),
    [62, 63],
    "both slots go to the names, though the no-name pair has the best score",
  );
  assert.deepEqual(
    await ids([]),
    [63, 61],
    // lowk3y_'s own measured draw (1.38, DEFAULT_DRAW in suggest.ts) clears KNOWN_DRAW_MIN on its
    // own, roster or not — Pinne's (0.46) does not, so her match needs the roster to be known at all.
    "an empty roster does not switch the tier off entirely: lowk3y_ is still known",
  );
  config.suggestCloseSlots = 1;
  assert.deepEqual(await ids(["Pinne"]), [62], "and a single slot goes to the name");
  console.log("OK: a favourite's match is a tier above the no-name ones at the slots");
  console.log("suggestSelect: all checks passed");
} finally {
  await rm(media, { recursive: true, force: true });
}
