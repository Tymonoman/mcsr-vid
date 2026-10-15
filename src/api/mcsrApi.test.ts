// getMatch's TTL cache, against a stubbed global fetch as playlist.test.ts does — never the
// network. Run: npx tsx src/mcsrApi.test.ts
import assert from "node:assert/strict";
import { getMatch, getVersus, withoutGhostPlayers } from "./mcsrApi.js";
import { h2hWinsBefore } from "../pipeline/overlayProps.js";
import type { MatchInfo } from "./types.js";

let calls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls++;
  const url = String(input);
  assert.match(url, /\/matches\/\d+$/, `unexpected fetch: ${url}`);
  // A call that stalls must not hang its caller forever (the publish-slot lock's review, 7 Oct
  // 2026): every request carries a timeout signal.
  assert.ok(init?.signal instanceof AbortSignal, "getJson passes a timeout signal");
  return new Response(JSON.stringify({ status: "success", data: { id: Number(url.split("/").pop()) } }));
}) as typeof fetch;

const realNow = Date.now;
try {
  assert.equal((await getMatch(1)).id, 1);
  await getMatch(1);
  assert.equal(calls, 1, "the second read within the TTL is the cached record");
  await getMatch(2);
  assert.equal(calls, 2, "a different match is its own fetch");

  // Past the TTL the record is fetched again: players attach VODs after the game, and the
  // pipeline's VOD guard must see them.
  Date.now = () => realNow() + 11 * 60_000;
  assert.equal((await getMatch(1)).id, 1);
  assert.equal(calls, 3, "an entry older than ten minutes is refetched");

  // A failed fetch caches nothing, so the retry is a real request.
  globalThis.fetch = (async () => {
    calls++;
    return new Response("nope", { status: 503, statusText: "down" });
  }) as typeof fetch;
  await assert.rejects(getMatch(3), /503/);
  await assert.rejects(getMatch(3), /503/);
  assert.equal(calls, 5, "an error is not cached");
  console.log("mcsrApi: all checks passed");
} finally {
  Date.now = realNow;
}

/* --- withoutGhostPlayers: the host seated as a player who never left spawn ------------------ */
const room = {
  type: 3,
  players: [
    { uuid: "host", nickname: "OliverSR" },
    { uuid: "a", nickname: "7rowl" },
    { uuid: "b", nickname: "Pinne" },
  ],
  result: { uuid: "b", time: 553_280 },
  timelines: [
    { uuid: "a", time: 1, type: "story.enter_the_nether" },
    { uuid: "b", time: 2, type: "story.enter_the_nether" },
  ],
} as unknown as MatchInfo;
assert.deepEqual(
  withoutGhostPlayers(room).players.map((p) => p.nickname),
  ["7rowl", "Pinne"],
  "the third seat with no timeline is dropped",
);
const twoUp = { ...room, players: room.players.slice(1) };
assert.equal(withoutGhostPlayers(twoUp), twoUp, "a two-player room already in uuid order is returned as is");
const swapped = { ...room, players: [room.players[2]!, room.players[1]!] };
assert.deepEqual(
  withoutGhostPlayers(swapped).players.map((p) => p.nickname),
  ["7rowl", "Pinne"],
  "a private room's seats are ordered by uuid, the same way in every game of a series",
);
const ranked = { ...room, type: 2 };
assert.equal(withoutGhostPlayers(ranked), ranked, "only private rooms are touched");
const winnerSilent = { ...room, result: { uuid: "host", time: 1 }, timelines: room.timelines.slice(1) };
assert.deepEqual(
  withoutGhostPlayers(winnerSilent)
    .players.map((p) => p.nickname)
    .sort(),
  ["OliverSR", "Pinne"],
  "the winner stays even with no timeline",
);
console.log("mcsrApi: ghost players ok");

/* --- getVersus: the pair's season up to this match, never the games played after it --------- */
{
  // 250 ranked games in season 12 (ids 1001..1250, "a" wins the odd ones), plus a private room;
  // the stub serves the list the way the API does: newest first, `before` exclusive, ≤`count`.
  const games = Array.from({ length: 250 }, (_, i) => ({
    id: 1001 + i,
    type: 2,
    season: 12,
    result: { uuid: i % 2 === 0 ? "a" : "b", time: 1 },
  }));
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url.pathname + url.search);
    assert.equal(url.pathname, "/users/a/versus/b/matches");
    assert.equal(url.searchParams.get("type"), "2");
    assert.equal(url.searchParams.get("season"), "12");
    const before = Number(url.searchParams.get("before"));
    const count = Number(url.searchParams.get("count"));
    const data = games
      .filter((g) => g.id < before)
      .reverse()
      .slice(0, count);
    return new Response(JSON.stringify({ status: "success", data }));
  }) as typeof fetch;

  // The pair's first meeting, "a" won it — and they have played 249 more since.
  const first = { id: 1001, season: 12, type: 2, result: { uuid: "a", time: 1 } } as MatchInfo;
  const v1 = await getVersus("a", "b", first);
  assert.deepEqual(v1.results.ranked, { total: 1, a: 1 }, "counts this match, nothing after it");
  assert.equal(h2hWinsBefore(v1, first, "a"), 0);
  assert.equal(h2hWinsBefore(v1, first, "b"), 0, "a first meeting reads 0-0 however many rematches since");
  assert.equal(asked[0], "/users/a/versus/b/matches?type=2&count=100&before=1002&season=12");

  // Game 230 ("b" won it, an even index): 115-114 going in. Three pages of 100, 100, 30.
  asked.length = 0;
  const later = { id: 1230, season: 12, type: 2, result: { uuid: "b", time: 1 } } as MatchInfo;
  const v2 = await getVersus("a", "b", later);
  assert.equal(v2.results.ranked.total, 230);
  assert.equal(h2hWinsBefore(v2, later, "a"), 115);
  assert.equal(h2hWinsBefore(v2, later, "b"), 114);
  assert.equal(asked.length, 3, "pages past the API's 100-a-request ceiling");
  assert.ok(
    asked[1]!.includes("before=1131") && asked[2]!.includes("before=1031"),
    "each page from the last one's oldest id",
  );
  console.log("OK: getVersus counts the season up to this match, paged, never the rematches after it");
}
