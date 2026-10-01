// Which matches reach the list. A scan gives the slots to the best scores, a favourite player's match
// counted up (FAVOURITE_BONUS) so it gets in; the score kept on the card stays the bucket's own; and a
// cache of an older layout is rebuilt without losing what the operator dismissed.
// Run: npx tsx src/dashboard/suggestSelect.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { DEFAULT_WEIGHTS, type MatchMetrics } from "../pipeline/matchScore.js";
import { dismissSuggestion, favouriteFactorFor, getSuggestions } from "./suggest.js";

// --- The factor: half again per favourite, whole names, any case ----------------------------------
const factor = favouriteFactorFor(["doogile", "Feinberg"]);
assert.equal(factor(["aaa", "bbb"]), 1);
assert.equal(factor(["Doogile", "bbb"]), 1.5, "the list and the API may differ in case");
assert.equal(factor(["FEINBERG", "doogile"]), 2);
assert.equal(factor(["doogile2", "Feinber"]), 1, "whole names, not prefixes");
assert.equal(favouriteFactorFor([])(["doogile", "Feinberg"]), 1, "an empty list is no bonus");

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
// The feed is empty and nothing else may be asked: the selection is all that is under test.
globalThis.fetch = (async (url: string) => {
  if (!String(url).startsWith("https://api.mcsrranked.com/matches")) throw new Error(`unexpected ${url}`);
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
const pool = Object.fromEntries(
  [
    pooled(10, ["aaa", "bbb"], 0), //                0.353
    pooled(20, ["ccc", "ddd"], 1_500), //            0.318
    pooled(30, ["doogile", "eee"], 4_500), //        0.247, x1.5 = 0.371
    pooled(40, ["doogile", "Feinberg"], 9_000), //   0.141, x2   = 0.282
    pooled(50, ["fff", "ggg"], 3_000), //            0.282
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
    await ids(["doogile"]),
    [30, 10],
    "a favourite's match, 0.247 counted up 1.5x, takes the second slot and leads",
  );
  assert.deepEqual(
    await ids(["Doogile", "FEINBERG"]),
    [30, 10],
    "two favourites in a weak match (0.141 x2) still do not pass a clearly better one",
  );
  assert.deepEqual(
    await ids([]),
    [10, 20],
    "and with the list emptied the next scan is back to scores alone",
  );

  // The card keeps the bucket's own score: comparable, and what the TUI prints.
  const card = (await listed(["doogile"])).suggestions.find((s) => s.metrics.matchId === 30)!;
  assert.ok(
    Math.abs(card.score - (3 * (1 - 4_500 / 15_000)) / 8.5) < 1e-9,
    `the raw score, not ${card.score}`,
  );
  console.log("OK: a favourite's match reaches the list at scan time, with its own score");

  // --- A cache of an older layout: the pool is rebuilt, the operator's dismissals are not lost ---
  const saved = JSON.parse(await readFile(cachePath, "utf8"));
  await writeFile(
    cachePath,
    JSON.stringify({ ...saved, version: 4, dismissed: [777], scannedAt: Date.now() }),
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
  assert.notEqual(after.version, 4, "the cache is written in today's layout");
  console.log("OK: an older cache is rebuilt and keeps its dismissals");
  console.log("suggestSelect: all checks passed");
} finally {
  await rm(media, { recursive: true, force: true });
}
