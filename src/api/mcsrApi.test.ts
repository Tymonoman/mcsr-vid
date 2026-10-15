// getMatch's TTL cache, against a stubbed global fetch as playlist.test.ts does — never the
// network. Run: npx tsx src/mcsrApi.test.ts
import assert from "node:assert/strict";
import { getMatch, getVersus, withoutGhostPlayers } from "./mcsrApi.js";
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

/* --- getVersus(…, matchId): the record as it stood after the match, not at render time ------- */
{
  // A beat B on 1 Oct (their first meeting), B beat A on 3 Oct; rendered 5 Oct the API says 1-1.
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const data = url.includes("/users/A/versus/B/matches?")
      ? [{ id: 12, type: 2, result: { uuid: "B", time: 500_000 } }]
      : { results: { ranked: { total: 2, A: 1, B: 1 }, casual: { total: 0 } } };
    return new Response(JSON.stringify({ status: "success", data }));
  }) as typeof fetch;
  const before = await getVersus("A", "B", 12, 11);
  assert.deepEqual(
    [before.results.ranked.A, before.results.ranked.B],
    [1, 0],
    "the 3 Oct rematch is not in the 1 Oct match's record",
  );
  assert.ok(
    asked.some((u) => /\/users\/A\/versus\/B\/matches\?.*after=11/.test(u) && /season=12/.test(u)),
    asked.join(" "),
  );
  const now = await getVersus("A", "B", 12);
  assert.deepEqual(
    [now.results.ranked.A, now.results.ranked.B],
    [1, 1],
    "no match id: the record as it stands",
  );
  console.log("OK: getVersus with a match id leaves out the meetings played after it");
}
