// Which matches reach the list. A scan gives the slots to the matches with a favourite player first, then
// to the best scores, a favourite's counted up (FAVOURITE_BONUS); the score kept on the card stays the
// bucket's own; and a cache of an older layout is rebuilt without losing what the operator dismissed.
// Run: npx tsx src/dashboard/suggestSelect.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, DEFAULTS } from "../config.js";
import { DEFAULT_WEIGHTS, type MatchMetrics } from "../pipeline/matchScore.js";
import type { DrawLearned } from "./drawLearn.js";
import {
  DEFAULT_DRAW,
  RECORD_PACE_BOOST,
  audienceFor,
  dismissSuggestion,
  drawOf,
  expectedDrawFor,
  favouriteFactorFor,
  getSuggestions,
  KNOWN_DRAW_MIN,
  STRONG_DRAWS,
  knownPlayerFor,
  knownTierFor,
  recordPaceFactor,
  tierFor,
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
  // expectedDrawFor: the bigger draw plus half the other; a name never measured draws by its
  // following (UNMEASURED_DRAW).
  const fol = (n: number) => () => n;
  assert.equal(expectedDrawFor(["nobody_ever_measured", "hackingnoises"], noFollowers), 2.08 + 0.5 * 0.5);
  assert.equal(expectedDrawFor(["silverrruns", "Infume"], noFollowers), 1.93 + 0.5 * 1.19);
  assert.deepEqual(
    [50_000, 49_999, 10_000, 9_999].map((n) => drawOf("nobody", fol(n))),
    [1.0, 0.75, 0.75, 0.5],
  );
  assert.equal(drawOf("nobody", noFollowers), 0.5, "no follower data is the lowest band");
  assert.equal(drawOf("hackingnoises", fol(1_000_000)), 2.08, "a measured draw keeps its value");
  // At the default threshold a 6.6k following never measured is not known (ninananina, 1 Oct 2026).
  assert.equal(DEFAULTS.knownFollowerThreshold, 10_000);
  assert.equal(knownPlayerFor([], fol(6_600), DEFAULTS.knownFollowerThreshold)("ninananina"), false);
  // tierFor: 2 with a favourite, 1 with a known player and no favourite, 0 with neither.
  const tiers = tierFor(["Pinne"], noFollowers, DEFAULTS.knownFollowerThreshold);
  assert.deepEqual(
    [
      ["Pinne", "aaa"],
      ["hackingnoises", "aaa"],
      ["aaa", "bbb"],
    ].map(tiers),
    [2, 1, 0],
  );
  console.log("OK: knownPlayerFor/knownTierFor/tierFor/drawOf — a measured draw overrides followers");
}

// --- The learned draw (config.learnedDraw, 11 Oct 2026): undefined/null is today's fallback
// untouched; present, it replaces DEFAULT_DRAW for a taught name, and a proven pair skips the
// repeat halving. -----------------------------------------------------------------------------
{
  const noFollowers = () => null;
  const learned: DrawLearned["players"] = { freshname: { draw: 2.5, n: 5 } };
  // A name DEFAULT_DRAW also knows: the learned value wins, not the hand-seeded one.
  assert.equal(drawOf("hackingnoises", noFollowers, { hackingnoises: { draw: 0.9, n: 4 } }), 0.9);
  // A name nobody hand-seeded: the learned value stands in for the UNMEASURED_DRAW band.
  assert.equal(drawOf("freshname", noFollowers, learned), 2.5);
  assert.equal(drawOf("freshname", noFollowers, null), 0.5, "no learned table: the old fallback");
  assert.equal(drawOf("freshname", noFollowers, undefined), 0.5, "undefined is the same as absent");
  assert.equal(
    expectedDrawFor(["freshname", "hackingnoises"], noFollowers, learned),
    2.5 + 0.5 * 2.08,
    "a learned draw and a measured one combine the same way two measured ones do",
  );

  // audienceFor: a proven pair (its last measured meeting beat the channel median, lastRatio > 1)
  // is not halved for being a repeat; an unproven one still is.
  const posted = [{ players: ["aaa", "bbb"] as [string, string], atMs: Date.now() }];
  const learnedFile: DrawLearned = {
    computedAt: Date.now(),
    channelMedian: 100,
    players: {},
    pairs: { "aaa|bbb": { lastRatio: 1.4, lastVideoId: "v1" } },
    videoViews: {},
  };
  const withLearned = audienceFor([], noFollowers, posted, learnedFile);
  const withoutLearned = audienceFor([], noFollowers, posted, null);
  assert.ok(withLearned(["aaa", "bbb"]) > withoutLearned(["aaa", "bbb"]), "a proven pair skips the halving");
  assert.equal(
    withLearned(["aaa", "bbb"]),
    expectedDrawFor(["aaa", "bbb"], noFollowers, undefined),
    "proven: the repeat factor is 1, not REPEAT_FACTOR",
  );
  // A pair whose last measured ratio did not beat the median (<=1) is not proven: still halved.
  const notProven: DrawLearned = {
    ...learnedFile,
    pairs: { "aaa|bbb": { lastRatio: 0.9, lastVideoId: "v1" } },
  };
  assert.equal(
    audienceFor([], noFollowers, posted, notProven)(["aaa", "bbb"]),
    withoutLearned(["aaa", "bbb"]),
    "lastRatio <= 1 is not proven",
  );
  // Undefined/null `learned` throughout: byte for byte the no-argument call.
  assert.equal(
    audienceFor([], noFollowers, posted)(["aaa", "bbb"]),
    withoutLearned(["aaa", "bbb"]),
    "the fourth argument defaults to off",
  );
  console.log("OK: a learned draw replaces the hand-seeded one; a proven pair skips the repeat halving");
}

// --- recordPaceBoostSec's own factor: null is off, at/under the threshold boosts by exactly
// RECORD_PACE_BOOST, over it does nothing. ------------------------------------------------------
{
  assert.equal(RECORD_PACE_BOOST, 1.5);
  assert.equal(recordPaceFactor(500_000, null), 1, "off");
  assert.equal(recordPaceFactor(500_000, 420), 1, "8:20 is slower than the 7:00 threshold");
  assert.equal(recordPaceFactor(420_000, 420), RECORD_PACE_BOOST, "exactly at the threshold boosts");
  assert.equal(recordPaceFactor(419_999, 420), RECORD_PACE_BOOST, "under it too");
  console.log("OK: recordPaceFactor — null is off, at or under the threshold boosts, never past it");
}

// --- The scan: no network, no Twitch; the pool is in the cache -----------------------------------
delete process.env.TWITCH_CLIENT_ID;
delete process.env.TWITCH_CLIENT_SECRET;
const media = await mkdtemp(path.join(tmpdir(), "mcsr-select-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
config.suggestCloseSlots = 2;
config.suggestChaosSlots = 0;
// Off until its own test below turns it on: every close/chaos check here predates the known
// bucket and asserts an exact result list, which a nonzero default would otherwise pad out with
// whatever known-tier matches the pool happens to hold.
config.suggestKnownSlots = 0;
config.suggestWeights = { ...DEFAULT_WEIGHTS };
config.suggestFastRunTargetSec = 420;
config.suggestSlowRunCutoffSec = 600;
// The feed and every roster player's own list (getSuggestions's pool-coverage pass) are both empty,
// and nothing else may be asked: the selection is all that is under test.
const asked: string[] = [];
globalThis.fetch = (async (url: string) => {
  const u = String(url);
  if (u.includes("/users/"))
    asked.push(decodeURIComponent(u.split("/users/")[1]!.split("/")[0]!).toLowerCase());
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
// null is a DNF — the loser never killed the dragon, so there is no margin and no close slot.
const pooled = (matchId: number, players: [string, string], finishMarginMs: number | null) => ({
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
    panelLeadChanges: 0,
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

  // No favourite, no measured draw, no followers: every pair here is tier 0 (18 Oct 2026, "two
  // unknown runners = never") — the pool keeps them (queued resolution still finds them), but
  // the list never does.
  assert.deepEqual(await ids([]), [], "no known player anywhere: no card for anyone");
  assert.deepEqual(
    await ids(["hhh"]),
    [30, 40],
    "the matches with a favourite take both slots, though the two best scores are no-name matches",
  );
  // Both are tier 2 (a favourite present), so without a close finish the bigger audience (two
  // favourites, 30's one) would win — but 30's margin (4_500ms) clears `CLOSE_FINISH_MS` and 40's
  // (9_000ms) does not, and a close finish now outranks audience inside a tier (18 Oct 2026).
  assert.deepEqual(
    await ids(["Hhh", "III"]),
    [30, 40],
    "a close finish outranks the bigger audience, though both beat the no-names",
  );
  assert.deepEqual(
    await ids([]),
    [],
    "and with the list emptied, no known player is left either — no card for anyone",
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
    [63, 62],
    "both slots go to the names, though the no-name pair has the best score — lowk3y_'s draw first",
  );
  assert.deepEqual(
    await ids([]),
    [63],
    // lowk3y_'s own measured draw (1.38, DEFAULT_DRAW in suggest.ts) clears KNOWN_DRAW_MIN on its
    // own, roster or not — Pinne's (0.46) does not, and Jabo_/sub5average (61) are no-names: with
    // no known player at all, 61 never reaches the list (18 Oct 2026), unfilled slot and all.
    "an empty roster does not switch the tier off entirely: lowk3y_ is still known",
  );
  config.suggestCloseSlots = 1;
  assert.deepEqual(await ids(["Pinne"]), [62], "and a single slot goes to the name");
  // A favourite's match also takes the slot from a known player's with the better score
  // (hackingnoises: measured 2.08, known, not a favourite).
  const known = Object.fromEntries(
    [pooled(62, ["Pinne", "someone"], 9_000), pooled(64, ["hackingnoises", "zzz"], 0)].map((entry) => [
      String(entry.metrics.matchId),
      entry,
    ]),
  );
  await writeFile(
    cachePath,
    JSON.stringify({
      ...JSON.parse(await readFile(cachePath, "utf8")),
      dismissed: [],
      pool: known,
      scannedAt: 0,
    }),
    "utf8",
  );
  assert.deepEqual(await ids(["Pinne"]), [62], "a favourite before a known player with a better score");

  // One card per pair, across both buckets: the better of dandannyboy vs silverrruns's two matches
  // (by score — the audience is the pair's), then the next pair.
  config.suggestCloseSlots = 2;
  const twice = Object.fromEntries(
    [
      pooled(71, ["dandannyboy", "silverrruns"], 3_000),
      pooled(72, ["silverrruns", "dandannyboy"], 0),
      pooled(73, ["Pinne", "someone"], 9_000),
    ].map((entry) => [String(entry.metrics.matchId), entry]),
  );
  await writeFile(
    cachePath,
    JSON.stringify({
      ...JSON.parse(await readFile(cachePath, "utf8")),
      dismissed: [],
      pool: twice,
      scannedAt: 0,
    }),
    "utf8",
  );
  asked.length = 0;
  assert.deepEqual(await ids([...DEFAULTS.favouritePlayers]), [72, 73], "never two matches of one pair");

  // The scan reads each favourite's own list and each strong draw's (STRONG_DRAWS: measured >= 1.0)
  // once: the default roster's 7 (edcr included since 18 Oct 2026) and hackingnoises, nahhann —
  // 9 calls. BeefSalad was one of these too, until he was blocked (config.blockedPlayers, 4 Oct 2026).
  assert.deepEqual(
    [...asked].sort(),
    [...DEFAULTS.favouritePlayers.map((n) => n.toLowerCase()), "hackingnoises", "nahhann"].sort(),
  );
  assert.equal(STRONG_DRAWS.length, 8, "the 8 measured at 1.0 or more, 6 of them on the default roster");
  console.log("OK: a favourite's match is a tier above the no-name ones at the slots");

  // --- A blocked player's match never reaches the list, however it scores, and does not even stay
  // in the pool once a scan has dropped it — the Aquacorde case: a match pooled before a player was
  // blocked must not go on being carried forward just because it was already scored.
  {
    const blocked = Object.fromEntries(
      [
        pooled(81, ["blockedguy", "clean"], 0), //   0.353 — would win outright
        // "hackingnoises" so this pair is known (18 Oct 2026) and isolates the block as the
        // reason 81 never appears, rather than both losing their slot for different reasons.
        pooled(82, ["hackingnoises", "pair"], 5_000), //   0.235
      ].map((entry) => [String(entry.metrics.matchId), entry]),
    );
    await writeFile(
      cachePath,
      JSON.stringify({
        ...JSON.parse(await readFile(cachePath, "utf8")),
        dismissed: [],
        pool: blocked,
        scannedAt: 0,
      }),
      "utf8",
    );
    const savedBlocked = config.blockedPlayers;
    config.blockedPlayers = ["blockedGuy"]; // any case
    assert.deepEqual(await ids([]), [82], "the blocked pair's match never fills a slot, however it scores");
    const afterScan = JSON.parse(await readFile(cachePath, "utf8"));
    assert.deepEqual(
      Object.keys(afterScan.pool).sort(),
      ["82"],
      "and it leaves the pool entirely, not just the list",
    );
    config.blockedPlayers = savedBlocked;
    console.log("OK: a blocked player's match never reaches the list, and leaves the pool entirely");
  }

  // --- The known bucket: no closeness or chaos score needed, just the tier (4 Oct 2026) -----------
  {
    config.suggestCloseSlots = 1;
    config.suggestChaosSlots = 0;
    config.suggestKnownSlots = 2;
    const closeKnown = pooled(301, ["hackingnoises", "aaa"], 0); // a finish: wins the one close slot
    const dnfKnown = pooled(302, ["silverrruns", "bbb"], null); // no finish — ineligible for close
    const nonameFinish = pooled(303, ["ccc", "ddd"], 100); // a finish, but no known player
    await writeFile(
      cachePath,
      JSON.stringify({
        ...JSON.parse(await readFile(cachePath, "utf8")),
        dismissed: [],
        pool: Object.fromEntries(
          [closeKnown, dnfKnown, nonameFinish].map((e) => [String(e.metrics.matchId), e]),
        ),
        scannedAt: 0,
      }),
      "utf8",
    );
    config.favouritePlayers = [];
    const result = await getSuggestions({ force: true });
    const byId = new Map(result.suggestions.map((s) => [s.metrics.matchId, s.bucket]));
    assert.equal(byId.get(301), "close", "the known player with a finish takes the one close slot");
    assert.equal(byId.get(302), "known", "the DNF known player still gets a card, via the known bucket");
    assert.equal(byId.get(303), undefined, "the no-name match with a finish loses the close slot to tier");
    assert.equal(
      result.suggestions.filter((s) => s.metrics.matchId === 301).length,
      1,
      "a match the close bucket already claimed is not also given a known slot",
    );
    console.log("OK: a known player's match is a card whether or not it is close or chaotic, never twice");
  }

  // --- The known bucket is a diversity slot, not a repeat-the-same-name slot (7 Oct 2026) ---------
  // silverrruns' matches (paired with measured-but-lesser-draw opponents, so each outscores
  // hackingnoises' own on audience alone) would take every "known" slot under plain audience
  // sorting, though hackingnoises is known too and never gets a card — the coverage.md finding.
  {
    config.suggestCloseSlots = 0;
    config.suggestChaosSlots = 0;
    config.suggestKnownSlots = 2;
    config.favouritePlayers = [];
    const monopoly = Object.fromEntries(
      [
        pooled(401, ["silverrruns", "feinberg"], null), // audience 2.475 — highest
        pooled(402, ["silverrruns", "edcr"], null), //    audience 2.465
        pooled(403, ["silverrruns", "nahhann"], null), //  audience 2.450
        pooled(404, ["hackingnoises", "zzz"], null), //    audience 2.330 — known, never picked before
      ].map((e) => [String(e.metrics.matchId), e]),
    );
    await writeFile(
      cachePath,
      JSON.stringify({
        ...JSON.parse(await readFile(cachePath, "utf8")),
        dismissed: [],
        pool: monopoly,
        scannedAt: 0,
      }),
      "utf8",
    );
    const result = await getSuggestions({ force: true });
    const ids = result.suggestions.map((s) => s.metrics.matchId).sort((a, b) => a - b);
    assert.deepEqual(
      ids,
      [401, 404],
      "silverrruns' best match plus hackingnoises', not silverrruns' best two — one slot per player",
    );
    console.log("OK: the known bucket caps one slot per player, so a second name is never crowded out");
  }

  // --- ...and a second pass backfills a slot the per-player cap would otherwise leave empty -------
  {
    config.suggestKnownSlots = 3;
    const onePlayer = Object.fromEntries(
      [
        pooled(411, ["silverrruns", "feinberg"], null),
        pooled(412, ["silverrruns", "edcr"], null),
        pooled(413, ["silverrruns", "nahhann"], null),
      ].map((e) => [String(e.metrics.matchId), e]),
    );
    await writeFile(
      cachePath,
      JSON.stringify({
        ...JSON.parse(await readFile(cachePath, "utf8")),
        dismissed: [],
        pool: onePlayer,
        scannedAt: 0,
      }),
      "utf8",
    );
    const result = await getSuggestions({ force: true });
    const ids = result.suggestions.map((s) => s.metrics.matchId).sort((a, b) => a - b);
    assert.deepEqual(
      ids,
      [411, 412, 413],
      "no other known player exists here, so the backfill still fills every slot — never emptier than before",
    );
    console.log("OK: the known bucket's backfill pass still fills every slot when no other name is around");
  }

  // --- The per-player cap is case-insensitive, like the pair-level one (7 Oct 2026) ---------------
  // A regression that dropped `.toLowerCase()` in the usedPlayers check would not recognise
  // "SILVERRRUNS" as the same player as "Silverrruns" and would hand both of them a slot.
  {
    config.suggestCloseSlots = 0;
    config.suggestChaosSlots = 0;
    config.suggestKnownSlots = 2;
    config.favouritePlayers = [];
    const mixedCase = Object.fromEntries(
      [
        pooled(421, ["Silverrruns", "feinberg"], null), //    audience 2.475 — highest
        pooled(422, ["SILVERRRUNS", "edcr"], null), //        audience 2.465 — same player, other case
        pooled(423, ["hackingnoises", "zzz"], null), //       audience 2.330 — known, the right backfill
      ].map((e) => [String(e.metrics.matchId), e]),
    );
    await writeFile(
      cachePath,
      JSON.stringify({
        ...JSON.parse(await readFile(cachePath, "utf8")),
        dismissed: [],
        pool: mixedCase,
        scannedAt: 0,
      }),
      "utf8",
    );
    const result = await getSuggestions({ force: true });
    const ids = result.suggestions.map((s) => s.metrics.matchId).sort((a, b) => a - b);
    assert.deepEqual(
      ids,
      [421, 423],
      "SILVERRRUNS is capped as the same player as Silverrruns, so hackingnoises' match backfills the second slot",
    );
    console.log("OK: the known bucket's per-player cap catches a player written in a different case");
  }

  // --- Pool pruning keeps a known player's match over newer no-names once the pool is full --------
  {
    const bulk: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      const entry = pooled(100_000 + i, [`nn${i}a`, `nn${i}b`], 0);
      entry.dateSec = nowSec - i; // every one newer than the known player's match below
      bulk[String(entry.metrics.matchId)] = entry;
    }
    const knownOld = pooled(99, ["hackingnoises", "zzz"], 0);
    knownOld.dateSec = nowSec - 9 * 86_400; // the oldest entry in the pool, by far, but inside 10 days
    bulk["99"] = knownOld;
    await writeFile(
      cachePath,
      JSON.stringify({
        ...JSON.parse(await readFile(cachePath, "utf8")),
        dismissed: [],
        pool: bulk,
        scannedAt: 0,
      }),
      "utf8",
    );
    config.favouritePlayers = [];
    await getSuggestions({ force: true });
    const afterPrune = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(Object.keys(afterPrune.pool).length, 500, "still capped at POOL_MAX_ENTRIES");
    assert.ok("99" in afterPrune.pool, "the known player's match survives although it is by far the oldest");
    console.log("OK: pool pruning keeps a known match over a newer no-name one once the pool is full");
  }

  // --- `countedMatchIds` alone must not stop a favourite's match reaching the pool (4 Oct 2026) ----
  // Simulates a match that crossed into "counted" on an earlier scan (its VODs were seen) but never
  // got scored — a shortlist cut, or scored once and later pruned. The favourite-list pull used to
  // skip it forever once counted; it must get another look as long as it is not already in the pool.
  {
    config.favouritePlayers = ["doogile"];
    const fresh = JSON.parse(await readFile(cachePath, "utf8"));
    await writeFile(
      cachePath,
      JSON.stringify({ ...fresh, dismissed: [], pool: {}, countedMatchIds: [555], scannedAt: 0 }),
      "utf8",
    );
    const feedMatch = {
      id: 555,
      type: 2,
      season: 9,
      date: nowSec - 3_600,
      players: [
        { nickname: "doogile", uuid: "u1", eloRank: null, eloRate: null },
        { nickname: "opp", uuid: "u2", eloRank: null, eloRate: null },
      ],
      forfeited: false,
      vod: [
        { uuid: "u1", url: "a", startsAt: 0 },
        { uuid: "u2", url: "b", startsAt: 0 },
      ],
      changes: [],
      result: { time: 600_000, uuid: "u1" },
    };
    const versusUrls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.startsWith("https://api.mcsrranked.com/matches/555")) {
        return {
          ok: true,
          json: async () => ({
            status: "success",
            // Finished: the winner's completion is on record, as on every real finished match (isDnf).
            data: { ...feedMatch, timelines: [], completions: [{ uuid: "u1", time: 600_000 }] },
          }),
        };
      }
      if (u.includes("/users/") && u.includes("/versus/")) {
        versusUrls.push(u);
        // The pair's list up to and including this match: their first meeting, u1 won it.
        return {
          ok: true,
          json: async () => ({
            status: "success",
            data: [{ id: 555, type: 2, season: 9, result: { uuid: "u1", time: 1 } }],
          }),
        };
      }
      if (u.includes("/users/doogile/matches")) {
        return { ok: true, json: async () => ({ status: "success", data: [feedMatch] }) };
      }
      if (u.includes("/users/") || u.startsWith("https://api.mcsrranked.com/matches")) {
        return { ok: true, json: async () => ({ status: "success", data: [] }) };
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const r = await getSuggestions({ force: true });
    assert.ok(
      r.suggestions.some((s) => s.metrics.matchId === 555),
      "the match reaches the list",
    );
    const savedAfter = JSON.parse(await readFile(cachePath, "utf8"));
    assert.ok("555" in savedAfter.pool, "and the pool, though it was already in countedMatchIds");
    console.log("OK: a match already in countedMatchIds still gets offered to the pool");
    // The card's h2h is the record before this match, in its own season: a first meeting is 0-0
    // (no "rematch 0–1" line naming the winner), not the current season's record.
    assert.ok(
      versusUrls.length > 0 && versusUrls.every((u) => u.endsWith("before=556&season=9")),
      versusUrls.join(),
    );
    assert.deepEqual(savedAfter.pool["555"].h2h, { leftWins: 0, rightWins: 0 });
    console.log("OK: a pooled h2h is the match's own season, before the match");
  }

  console.log("suggestSelect: all checks passed");
} finally {
  await rm(media, { recursive: true, force: true });
}
