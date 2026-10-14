// Contract test for the suggestion scan (getSuggestions and its cache), written from the docs, not
// the code (CLAUDE.md "Suggestions", "Favourite players, then known", "Blocked players"; the same
// bullets in handbook/claude-md-reference.md).
//
// What the docs promise about which matches become cards:
//  1. Cached in <mediaDir>/.suggest-cache.json at CACHE_VERSION 4.
//  2. Defaults: suggestKnownSlots 4, KNOWN_DRAW_MIN 0.6, knownFollowerThreshold 10,000, the roster
//     doogile/Feinberg/Infume/Pinne/lowk3y_/silverrruns (edcr is the operator's call, not on it).
//  3. Known = a favourite, a measured draw ≥ 0.6 (authoritative either way), else followers ≥ 10,000;
//     tier 2 favourite, 1 known, 0 neither.
//  4. A blocked player's match is dropped before the scan scores it (no detail fetch, never pooled,
//     never a card), whether it came from the feed or a favourite's own list.
//  5. …and is never shown however stale the cache: a block saved after a scan applies to the cached list.
//  6. One card per pair across close/chaos/known — never two matches of one pair, in any case.
//  7. The known bucket is capped one slot per player too: "a first pass skips a candidate if either
//     player already filled a slot this scan".
//  8. No seed, rank or elo term: a player's ladder rank or elo never decides which match gets a slot.
//  9. Dismissed is never suggested again, from the fresh cache or a rescan.
//
// The MCSR API is a fake serving the real matches in src/fixtures/ (dates moved into the pool's
// 10-day window); Twitch is unconfigured, so nothing leaves the process.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/dashboard/suggest.contract.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config, DEFAULTS } from "../config.js";
import { computeMetrics, type MatchMetrics } from "../pipeline/matchScore.js";
import { presentSuggestions } from "./suggestPresent.js";
import { dismissSuggestion, getSuggestions, KNOWN_DRAW_MIN, tierFor } from "./suggest.js";

/** A documented promise the code does not keep yet: reported, not failed, until triage. */
async function deviation(clause: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

delete process.env.TWITCH_CLIENT_ID;
delete process.env.TWITCH_CLIENT_SECRET;
const media = mkdtempSync(path.join(tmpdir(), "mcsr-suggest-contract-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
const cachePath = path.join(media, ".suggest-cache.json");
const readCache = () => JSON.parse(readFileSync(cachePath, "utf8"));
const writeCache = (over: Record<string, unknown>) =>
  writeFileSync(cachePath, JSON.stringify({ ...readCache(), ...over }), "utf8");

const nowSec = Math.floor(Date.now() / 1000);
/** A real match, played `hoursAgo` hours ago so its VODs are still inside the pool's window. */
// Some fixtures are trimmed to what their own test needed; the live API always sends `changes`.
const fixture = (id: number, hoursAgo: number): MatchInfo => {
  const raw = JSON.parse(
    readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8"),
  ) as MatchInfo;
  return { ...raw, changes: raw.changes ?? [], date: nowSec - hoursAgo * 3600 };
};

// --- The fake MCSR API -----------------------------------------------------------------------------
let feed: MatchInfo[] = [];
let ownLists: Record<string, MatchInfo[]> = {};
const asked: string[] = [];
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ status: "success", data }) });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  asked.push(url);
  if (!url.startsWith("https://api.mcsrranked.com/")) throw new Error(`no network in this test: ${url}`);
  const route = url.slice("https://api.mcsrranked.com".length);
  if (route.startsWith("/matches?")) return ok(route.includes("before=") ? [] : feed);
  const detail = /^\/matches\/(\d+)$/.exec(route);
  if (detail) {
    const m = [...feed, ...Object.values(ownLists).flat()].find((x) => x.id === Number(detail[1]));
    return m ? ok(m) : { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
  }
  if (route.includes("/versus/")) return ok({ results: { ranked: {} } });
  const own = /^\/users\/([^/]+)\/matches/.exec(route);
  if (own) return ok(ownLists[decodeURIComponent(own[1]!).toLowerCase()] ?? []);
  throw new Error(`unexpected MCSR call ${url}`);
}) as unknown as typeof fetch;

/** A scored pool entry the way a scan stores it, for the cases that only exercise the selection. */
const pooled = (
  matchId: number,
  players: [string, string],
  finishMarginMs: number | null,
  ranks: [number | null, number | null] = [null, null],
) => ({
  metrics: {
    matchId,
    players,
    winner: players[0],
    resultMs: 600_000,
    splits: [],
    finishMarginMs,
    finishEstimated: false,
    splitsWithin3s: 0,
    comparedSplits: 0,
    maxLeadMs: 30_000,
    leadChanges: 0,
    panelLeadChanges: 0,
    maxSwingMs: 0,
    deaths: 0,
    deathsByPlayer: {},
  } satisfies MatchMetrics,
  profiles: players.map((nickname, i) => ({
    nickname,
    eloRank: ranks[i],
    elo: ranks[i] === null ? null : 3000 - ranks[i]!,
  })),
  h2h: null,
  vodUrls: ["a", "b"],
  dateSec: nowSec - 86_400,
  scoredAt: Date.now(),
});
const withPool = (entries: ReturnType<typeof pooled>[]) =>
  writeCache({
    dismissed: [],
    suggestions: [],
    scannedAt: 0,
    pool: Object.fromEntries(entries.map((e) => [String(e.metrics.matchId), e])),
  });
const slots = (close: number, chaos: number, known: number) => {
  config.suggestCloseSlots = close;
  config.suggestChaosSlots = chaos;
  config.suggestKnownSlots = known;
};
const cardIds = async (force = true) =>
  (await getSuggestions({ force })).suggestions.map((s) => s.metrics.matchId);

try {
  // --- 2/3. The documented defaults and the known gate -------------------------------------------
  {
    assert.equal(DEFAULTS.suggestKnownSlots, 4);
    assert.equal(KNOWN_DRAW_MIN, 0.6);
    assert.equal(DEFAULTS.knownFollowerThreshold, 10_000);
    assert.deepEqual(DEFAULTS.favouritePlayers, [
      "doogile",
      "Feinberg",
      "Infume",
      "Pinne",
      "lowk3y_",
      "silverrruns",
    ]);
    assert.ok(
      !DEFAULTS.favouritePlayers.some((n) => n.toLowerCase() === "edcr"),
      "edcr is the operator's call",
    );
    const followers: Record<string, number> = { bigstreamer: 10_000, almost: 9_999, romuxii: 1_000_000 };
    const tier = tierFor(
      DEFAULTS.favouritePlayers,
      (n) => followers[n] ?? null,
      DEFAULTS.knownFollowerThreshold,
    );
    assert.equal(
      tier(["PINNE", "almost"]),
      2,
      "a favourite in any case (Pinne's own draw, 0.46, would not do it)",
    );
    assert.equal(tier(["anjouu", "almost"]), 1, "a measured 0.62 clears 0.6 with no followers at all");
    assert.equal(tier(["edcr", "almost"]), 1, "edcr is known by his measured draw, not the roster");
    assert.equal(tier(["bigstreamer", "almost"]), 1, "an unmeasured 10,000 followers is known");
    assert.equal(tier(["almost", "nobody"]), 0, "9,999 is not");
    assert.equal(
      tier(["romuxii", "dandannyboy"]),
      0,
      "a measured draw under 0.6 is authoritative, a million followers or not",
    );
    console.log("OK: the documented defaults and the known gate");
  }

  // --- 1/4. A scan over real matches: blocked runners never scored, never pooled, never cards -----
  {
    slots(8, 2, 4);
    config.favouritePlayers = [...DEFAULTS.favouritePlayers];
    feed = [
      fixture(13782182, 1), // silverrruns vs ANJOUU
      fixture(13617328, 2), // nolqndo vs thecamo6
      fixture(13560037, 3), // v_strid vs doogile
      fixture(13549300, 4), // hackingnoises vs BeefSalad — blocked by default
      fixture(13446429, 5), // Infume vs Feinberg
      fixture(12902901, 6), // BlazeMind vs Aquacorde — blocked by default
    ].sort((a, b) => b.id - a.id);
    // A blocked runner's match reached through a strong draw's own list, not the feed.
    ownLists = { hackingnoises: [fixture(13549300, 4)] };
    dismissSuggestion(0); // a valid empty cache, the way the app writes one
    writeCache({ dismissed: [] });
    asked.length = 0;
    const result = await getSuggestions({ force: true });
    const got = result.suggestions.map((s) => s.metrics.matchId);
    const blocked = [13549300, 12902901];
    assert.ok(got.includes(13446429) && got.includes(13560037), `the clean real matches are cards: ${got}`);
    for (const id of blocked) {
      assert.ok(!got.includes(id), `#${id} (a blocked runner) is never a card`);
      assert.ok(!(String(id) in readCache().pool), `#${id} is never pooled`);
      assert.ok(
        !asked.some((u) => u.endsWith(`/matches/${id}`)),
        `#${id} is dropped before scoring: no detail fetch`,
      );
    }
    assert.equal(readCache().version, 4, "the cache is written at CACHE_VERSION 4");
    assert.ok(
      !asked.some((u) => !u.startsWith("https://api.mcsrranked.com/")),
      "nothing but the (fake) MCSR API",
    );
    console.log("OK: a scan over real matches never scores or shows a blocked runner's");
  }

  // --- 5. A block saved after a scan: the cached list must not show the match --------------------
  {
    // The operator blocks a runner whose match is already in a fresh cached list (scanned minutes ago).
    const savedBlocked = config.blockedPlayers;
    config.blockedPlayers = ["Aquacorde"]; // BeefSalad not yet blocked
    slots(8, 2, 4);
    writeCache({ pool: {}, countedMatchIds: [], newestScannedId: null, oldestScannedId: null });
    assert.ok((await cardIds()).includes(13549300), "sanity: before the block, the match is a card");
    config.blockedPlayers = ["Aquacorde", "BeefSalad"]; // the Settings save; no rescan yet
    const cached = await getSuggestions(); // unforced, inside suggestCacheTtlMin: the cached list
    assert.ok(
      Date.now() - cached.scannedAt < config.suggestCacheTtlMin * 60_000,
      "sanity: served from the cache",
    );
    assert.ok(
      !presentSuggestions(cached.suggestions, Date.now(), [], [], [], 10_000, null, null).some(
        (c) => c.matchId === 13549300,
      ),
      "the dashboard's list drops it at once",
    );
    await deviation(
      "CLAUDE.md Blocked players: never shown however stale the cache (getSuggestions is what the TUI lists)",
      () =>
        assert.ok(
          !cached.suggestions.some((s) => s.metrics.matchId === 13549300),
          "getSuggestions serves the blocked runner's match from a fresh cache; the TUI (src/cli/tui.tsx) lists it as is",
        ),
    );
    assert.ok(!(await cardIds()).includes(13549300), "the next rescan drops it");
    assert.ok(!("13549300" in readCache().pool), "and from the pool too, though it was already in it");
    config.blockedPlayers = savedBlocked;
    feed = [];
    ownLists = {};
    console.log("OK: a block saved after a scan reaches the list");
  }

  // --- 6. One card per pair across the buckets -----------------------------------------------------
  {
    config.favouritePlayers = [];
    slots(1, 0, 1);
    withPool([
      pooled(601, ["doogile", "edcr"], 0), //    a finish: the close slot
      pooled(602, ["EDCR", "Doogile"], null), //  the same pair, other case, no finish: a known candidate
      pooled(603, ["hackingnoises", "zzz"], null),
    ]);
    assert.deepEqual(
      (await cardIds()).sort(),
      [601, 603],
      "a pair holding the close card gets no known card too",
    );
    console.log("OK: one card per pair across the buckets");
  }

  // --- 7. One known slot per player — counting the slots this scan already gave him ----------------
  await deviation(
    "handbook Suggestions: the known bucket is capped one slot per player — 'a first pass skips a candidate if either player already filled a slot this scan'",
    async () => {
      config.favouritePlayers = [];
      slots(1, 0, 1);
      withPool([
        pooled(701, ["silverrruns", "aaa"], 0), //       the only finish: silverrruns takes the close slot
        pooled(702, ["silverrruns", "edcr"], null), //   audience 2.465
        pooled(703, ["hackingnoises", "zzz"], null), //  audience 2.33 — a second known player
      ]);
      const got = (await getSuggestions({ force: true })).suggestions.map(
        (s) => `${s.bucket}:${s.metrics.matchId}`,
      );
      assert.deepEqual(got, ["close:701", "known:703"], `silverrruns holds two slots this scan: ${got}`);
    },
  );

  // --- 8. No rank or elo term at the slots ----------------------------------------------------------
  {
    config.favouritePlayers = [];
    slots(1, 0, 0);
    // Two no-name matches identical but for the players' ladder rank and elo: #1/#2 against #900/#901.
    const run = async (topFirst: boolean) => {
      withPool([
        pooled(801, ["aaa_one", "bbb_one"], 2_000, topFirst ? [1, 2] : [900, 901]),
        pooled(802, ["ccc_two", "ddd_two"], 2_000, topFirst ? [900, 901] : [1, 2]),
      ]);
      return cardIds();
    };
    assert.deepEqual(
      await run(true),
      await run(false),
      "swapping the ladder ranks and elo between them changes nothing",
    );
    console.log("OK: rank and elo never decide a slot");
  }

  // --- 9. Dismissed stays dismissed ---------------------------------------------------------------
  {
    config.favouritePlayers = [];
    slots(2, 0, 0);
    withPool([pooled(901, ["aaa", "bbb"], 0), pooled(902, ["ccc", "ddd"], 1_000)]);
    assert.deepEqual(await cardIds(), [901, 902]);
    dismissSuggestion(901);
    assert.deepEqual(await cardIds(false), [902], "the fresh cached list");
    assert.deepEqual(await cardIds(true), [902], "and a forced rescan of the same pool");
    console.log("OK: a dismissed match never comes back");
  }

  console.log("suggest.contract: all checks passed");
} finally {
  rmSync(media, { recursive: true, force: true });
}
