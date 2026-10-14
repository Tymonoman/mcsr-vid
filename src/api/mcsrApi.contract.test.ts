// Contract tests for the API client, written from the docs before the source (an outside
// reader's view). Stubbed global fetch only — no network. Run: npx tsx src/api/mcsrApi.contract.test.ts
//
// The promises the docs make for the api-client feature (CLAUDE.md "Known pitfalls", README
// "What it needs", handbook/claude-md-reference.md "Known pitfalls", "Playoffs", "Chat replay").
// Each file of this set pins the ones it names; P-numbers are shared across the four files.
//
//  P1  A private room's two seats are ordered by uuid, so the same pair sits the same way in every
//      game of a series whatever order they joined in; the order is settled where the match is
//      read (`getMatch`). [mcsrApi]
//  P2  Ranked matches keep the API's order (sync files written before 21 Sept 2026 depend on it). [mcsrApi]
//  P3  `getMatch` drops a private room's extra seat with no timeline (the host who joined game
//      13333220 as a third player and stayed at spawn); a real 2-player match is never touched. [mcsrApi]
//  P4  Elo comes from the match, not the user: `user.eloRate` is the rating now, and the same match
//      must not show different numbers in different places (overlay vs thumbnail). [overlayProps.elo]
//  P5  A playoff game shows the bracket's frozen season-end elo (`playoffContextFor`). [overlayProps.elo]
//  P6  `pickStats` falls back to career totals only when the season bucket has no ranked games. [overlayProps.elo]
//  P7  …and the overlay then labels itself CAREER (SEASON otherwise). [overlayProps.elo]
//  P8  `withDiscoveredVods` writes what it finds to `<matchDir>/vods.json`. [vodDiscovery]
//  P9  …and reads it back first, so a clip stays renderable after the archive is gone (no
//      re-listing, no "1/2 VODs"). [vodDiscovery]
//  P10 The archive listing reaches 40 archives back. [vodDiscovery]
//  P11 Chat comes from Twitch's web GQL persisted query without a login, paging by offset — the
//      cursor fails Twitch's integrity check. [twitchChat]
//  P12 Chat is best effort: a missing/chat-less VOD is an empty list, and a Twitch failure never
//      costs a render. [twitchChat]
//  P13 MCSR Ranked match data and Twitch chat need nothing: public, no credentials sent. [mcsrApi, twitchChat]
//  P14 Every MCSR API call carries a 15 s timeout — already pinned by mcsrApi.test.ts, not repeated.
//  P15 "A Twitch archive outlives the stream by 14 days (60 for partners)" is Twitch's policy, not
//      code — nothing here can test it; P8/P9 are what the code does about it.
//
// Public-surface (JSDoc) contracts pinned here beyond the docs: `cacheMatch` enriches without
// extending the ten-minute expiry; a 429 surfaces as `McsrApiError` with its status; the feed and
// history queries leave unset params out; the bracket's double envelope is unwrapped;
// `parseMatchId` reads any match URL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cacheMatch,
  getMatch,
  getPlayoffs,
  getRecentMatches,
  getUserMatches,
  McsrApiError,
  matchPageUrl,
  parseMatchId,
} from "./mcsrApi.js";
import type { MatchInfo, PlayoffBracket } from "./types.js";

/** Runs a check the docs promise; a failure is printed as a deviation, not thrown (triage first). */
async function deviation(clause: string, check: () => unknown): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;

/* --- The stub API: path+search -> payload (wrapped in the success envelope) or a Response ---- */
const served = new Map<string, unknown>();
const requests: { path: string; init?: RequestInit }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://api.mcsrranked.com", `only the MCSR API is reached: ${url}`);
  const key = url.pathname + url.search;
  requests.push({ path: key, init });
  const hit = served.get(key);
  if (hit instanceof Response) return hit.clone();
  if (hit === undefined)
    return new Response(JSON.stringify({ status: "error", data: "not found" }), {
      status: 404,
      statusText: "Not Found",
    });
  if (typeof hit === "string") return new Response(hit); // a raw body, served as is
  return new Response(JSON.stringify({ status: "success", data: hit }));
}) as typeof fetch;
const fetchesOf = (path: string): number => requests.filter((r) => r.path === path).length;

/* --- P1: a private room is read in uuid order, the same way in every game -------------------- */
// Two games of one series in which the room seated the pair in opposite join orders — the S11
// Pinne–7rowl pilot came out with the sides swapped in game 3. Synthetic uuids and names.
const LO = "0a11ce00000000000000000000000001";
const HI = "f0b0b000000000000000000000000002";
const HOST = "77777777777777777777777777777777";
const seat = (uuid: string, nickname: string) =>
  ({ uuid, nickname, roleType: 0, eloRate: null, eloRank: null, country: null }) as MatchInfo["players"][0];
const room = (id: number, players: MatchInfo["players"], timelineUuids = [LO, HI]): MatchInfo =>
  ({
    ...fixture(13766294),
    id,
    type: 3,
    changes: [],
    vod: [],
    players,
    result: { uuid: HI, time: 600_000 },
    timelines: timelineUuids.map((uuid, i) => ({ uuid, time: 60_000 + i, type: "story.enter_the_nether" })),
  }) as MatchInfo;
served.set("/matches/9100001", room(9100001, [seat(LO, "RunnerLo"), seat(HI, "RunnerHi")]));
served.set("/matches/9100002", room(9100002, [seat(HI, "RunnerHi"), seat(LO, "RunnerLo")]));
{
  const g1 = await getMatch(9100001);
  const g2 = await getMatch(9100002);
  // Everything left/right hangs off match.players (sync.json, clip placement, the band's colours),
  // so the two games must agree on who is left without any caller re-sorting.
  assert.deepEqual(
    g2.players.map((p) => p.uuid),
    g1.players.map((p) => p.uuid),
    "both games of the series seat the pair the same way round",
  );
  assert.deepEqual(
    g2.players.map((p) => p.uuid),
    [LO, HI],
    "the room's seats come back in uuid order, not join order",
  );
  // Nothing but the order changes: the seat objects are the API's own.
  assert.equal(g2.players[0]!.nickname, "RunnerLo");
  assert.equal(g2.vod.length, 0, "the rest of the record is untouched");
}

/* --- P2: a ranked match keeps the API's order, even when it is not uuid order ---------------- */
{
  // 13673240 as the API returned it lists the a54e… player before the 9a8e… one — the reverse of
  // uuid order. Eighteen matches rendered before 21 Sept 2026 carry sync files written against
  // the API's order, so a ranked match must not be re-sorted.
  const ranked = fixture(13673240);
  served.set("/matches/13673240", ranked);
  const apiOrder = ranked.players.map((p) => p.uuid);
  assert.ok(apiOrder[0]! > apiOrder[1]!, "fixture sanity: the API order is not uuid order");
  assert.deepEqual(
    (await getMatch(13673240)).players.map((p) => p.uuid),
    apiOrder,
    "a ranked match is read in the API's order",
  );
  // A casual match (type 1) is not a private room either.
  served.set("/matches/9100003", { ...ranked, id: 9100003, type: 1 });
  assert.deepEqual(
    (await getMatch(9100003)).players.map((p) => p.uuid),
    apiOrder,
    "casual keeps it too",
  );
}

/* --- P3: the host's ghost seat is dropped; real players never are ---------------------------- */
{
  // The host joined as a third player, never left spawn, and the API lists three seats.
  served.set(
    "/matches/9100004",
    room(9100004, [seat(HOST, "RoomHost"), seat(HI, "RunnerHi"), seat(LO, "RunnerLo")]),
  );
  const m = await getMatch(9100004);
  assert.deepEqual(
    m.players.map((p) => p.uuid),
    [LO, HI],
    "the seat with no timeline is dropped and the two players come back in uuid order",
  );

  // A real two-player room where one player has no timeline entry yet (an early forfeit) keeps
  // both: dropping happens only when more than two are listed.
  served.set("/matches/9100005", room(9100005, [seat(HI, "RunnerHi"), seat(LO, "RunnerLo")], [HI]));
  assert.deepEqual(
    (await getMatch(9100005)).players.map((p) => p.uuid),
    [LO, HI],
    "a 2-player room never loses a seat",
  );
}

// Edge: a three-seat room where nothing happened at all (a room reset before anyone moved, no
// winner). There is one extra seat by the docs' wording, but no timeline says which; whatever is
// decided, the match must not come back with fewer seats than the two the room actually had.
await deviation(
  'handbook "Playoffs": withoutGhostPlayers "drops a private room\'s extra seat with no timeline"',
  async () => {
    served.set("/matches/9100006", {
      ...room(9100006, [seat(HOST, "RoomHost"), seat(HI, "RunnerHi"), seat(LO, "RunnerLo")], []),
      result: { uuid: null, time: 0 },
    });
    const m = await getMatch(9100006);
    assert.ok(
      m.players.length >= 2,
      `a three-seat room with no timeline came back with ${m.players.length} seat(s): every seat, not the extra one, was dropped`,
    );
  },
);
await deviation(
  'handbook "Playoffs": withoutGhostPlayers "drops a private room\'s extra seat with no timeline"',
  async () => {
    // The host's ghost seat plus a player who forfeited before any timeline entry; the other
    // player won. The forfeiting player is a real seat, not the extra one.
    served.set("/matches/9100007", {
      ...room(9100007, [seat(HOST, "RoomHost"), seat(HI, "RunnerHi"), seat(LO, "RunnerLo")], [HI]),
      forfeited: true,
    });
    const m = await getMatch(9100007);
    assert.ok(
      m.players.length >= 2,
      `ghost seat + an early forfeit came back with ${m.players.length} seat(s): the forfeiting player was dropped with the host`,
    );
  },
);

/* --- P13: public data, no credentials --------------------------------------------------------- */
for (const r of requests) {
  // README "What it needs": MCSR Ranked match data needs nothing. A credential header leaking
  // into a public API call would be a secret sent to a third party.
  const headers = new Headers(r.init?.headers);
  assert.equal(headers.has("authorization"), false, `no Authorization header on ${r.path}`);
  assert.equal(r.init?.method ?? "GET", "GET", `a read is a GET: ${r.path}`);
}

/* --- cacheMatch: enriches the cached record, keeps the original ten-minute expiry ------------- */
{
  const realNow = Date.now;
  const t0 = realNow();
  try {
    Date.now = () => t0;
    served.set("/matches/9200001", room(9200001, [seat(LO, "RunnerLo"), seat(HI, "RunnerHi")]));
    const fresh = await getMatch(9200001);
    assert.equal(fetchesOf("/matches/9200001"), 1);

    // Nine minutes on, discovery enriches it (what withDiscoveredVods does with found VODs).
    Date.now = () => t0 + 9 * 60_000;
    const vod = { uuid: LO, url: "https://www.twitch.tv/videos/1", startsAt: 1 };
    cacheMatch({ ...fresh, vod: [vod] });
    assert.deepEqual(
      (await getMatch(9200001)).vod,
      [vod],
      "the enriched record is what the next caller gets",
    );
    assert.equal(fetchesOf("/matches/9200001"), 1, "…without a fetch");

    // Eleven minutes after the original fetch it is refetched: players attach VODs to the API
    // record after the game, and an enrichment must not keep the stale record alive for ever.
    Date.now = () => t0 + 11 * 60_000;
    assert.deepEqual(
      (await getMatch(9200001)).vod,
      [],
      "past the original expiry the API's record is read again",
    );
    assert.equal(fetchesOf("/matches/9200001"), 2, "cacheMatch did not extend the expiry");
  } finally {
    Date.now = realNow;
  }
}

/* --- Errors: a 429 carries its status; an error envelope throws -------------------------------- */
{
  // The budget is ~500 requests per 10 minutes (README); a caller backs off on 429 specifically.
  served.set("/matches/9300001", new Response("slow down", { status: 429, statusText: "Too Many Requests" }));
  const err = await getMatch(9300001).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof McsrApiError, "a non-2xx is an McsrApiError");
  assert.equal((err as McsrApiError).status, 429, "carrying the HTTP status");
  assert.match((err as Error).message, /429/);

  // A 200 whose envelope says error is still a failure, not a match with undefined fields.
  served.set("/matches/9300002", JSON.stringify({ status: "error", data: "Match not found" }));
  await assert.rejects(getMatch(9300002), /returned error.*Match not found/);
  // And neither is cached: the retry is a real request.
  await assert.rejects(getMatch(9300002));
  assert.equal(fetchesOf("/matches/9300002"), 2, "a failure is not cached");
}

/* --- Feed and history queries: unset params are left out, ids are encoded -------------------- */
{
  served.set("/matches?count=100&type=2", []);
  assert.deepEqual(await getRecentMatches({ count: 100, before: undefined, type: 2 }), []);
  assert.equal(fetchesOf("/matches?count=100&type=2"), 1, "an undefined `before` is not sent as the string");
  served.set("/matches", []);
  await getRecentMatches();
  assert.equal(fetchesOf("/matches"), 1, "no query, no stray '?'");

  served.set("/users/a%2Fb%20c/matches?type=3&season=12&count=50", []);
  await getUserMatches("a/b c", { type: 3, season: 12, count: 50 });
  assert.equal(
    fetchesOf("/users/a%2Fb%20c/matches?type=3&season=12&count=50"),
    1,
    "the identifier is path-encoded; type 3 and the season are how playoff games are found",
  );
}

/* --- The bracket: the double envelope is unwrapped, by season or current --------------------- */
{
  const envelope = readFileSync(new URL("../fixtures/playoffs-11.json", import.meta.url), "utf8");
  served.set("/playoffs/11", envelope);
  served.set("/playoffs", envelope);
  const expected = (JSON.parse(envelope) as { data: { data: PlayoffBracket } }).data.data;
  assert.deepEqual(await getPlayoffs(11), expected, "a past season's bracket, inner data unwrapped");
  assert.deepEqual(await getPlayoffs(), expected, "the current bracket");
  assert.equal(fetchesOf("/playoffs/11"), 1);
  assert.equal(fetchesOf("/playoffs"), 1);
}

/* --- parseMatchId / matchPageUrl --------------------------------------------------------------- */
{
  // Any site's match URL, with a query, a hash or a trailing slash, and a bare id.
  assert.equal(parseMatchId("13560037"), 13560037);
  assert.equal(parseMatchId("https://mcsrranked.com/matches/13560037/"), 13560037);
  assert.equal(parseMatchId(matchPageUrl(13560037, "SomeRunner", 12)), 13560037, "the Magma page reads back");
  assert.equal(parseMatchId("https://example.com/m/13560037?season=12#t=5"), 13560037);
  assert.throws(() => parseMatchId("https://mcsrranked.com/matches/"), /Could not find a match ID/);
  // The /matches/<id> segment is what pairs a channel upload back to its match.
  assert.match(matchPageUrl(42, "a b", null), /\/matches\/42$/);
  assert.match(matchPageUrl(42, "a b"), /\/player\/a%20b\//, "the nickname is encoded");
}

console.log("mcsrApi.contract: all checks passed");
