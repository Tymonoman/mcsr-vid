// Self-check for playoffs.ts on the saved Season 11 bracket (src/fixtures/playoffs-11.json), with
// games synthesised around its Round of 16 slots: the API is stubbed at global fetch, so nothing
// here touches the network. What is pinned is what would embarrass the channel if it slipped —
// a game numbered out of order or short by one, a series score anywhere at all, a practice
// reset counted as a game, the wrong season's bracket.
// Run: npx tsx src/playoffs.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { FeedMatch, PlayoffBracket } from "../api/types.js";

const envelope = JSON.parse(readFileSync(new URL("../fixtures/playoffs-11.json", import.meta.url), "utf8"));
const bracket: PlayoffBracket = envelope.data.data;

// Slot 9: edcr (#1 seed, players[0]) vs lauveer (LCQ, players[15]), Sat 12 Sept 15:00 UTC.
const slot = bracket.matches.find((m) => m.id === 9)!;
const edcr = bracket.players[0]!;
const lauveer = bracket.players[15]!;
const feinberg = bracket.players[7]!;
const start = slot.startTime!;

let nextId = 13_100_000;
const game = (
  a: { uuid: string; nickname: string },
  b: { uuid: string; nickname: string },
  date: number,
  winner: string | null,
  over: Partial<FeedMatch> = {},
): FeedMatch =>
  ({
    id: nextId++,
    type: 3,
    season: 12,
    date,
    players: [
      { uuid: a.uuid, nickname: a.nickname },
      { uuid: b.uuid, nickname: b.nickname },
    ],
    spectators: [],
    result: { uuid: winner, time: 480_000 },
    forfeited: false,
    changes: [],
    vod: [],
    rank: { season: null, allTime: null },
    tag: null,
    ...over,
  }) as FeedMatch;

const g1 = game(edcr, lauveer, start + 300, edcr.uuid);
const seat = (uuid: string, nickname: string) => ({ uuid, nickname }) as FeedMatch["players"][number];
const g2 = game(lauveer, edcr, start + 900, lauveer.uuid); // seated the other way round
const g3 = game(edcr, lauveer, start + 1500, edcr.uuid);
const reset = game(edcr, lauveer, start - 600, null, {
  forfeited: true,
  result: { uuid: null, time: 30_000 },
});
const otherPair = game(edcr, feinberg, start + 600, edcr.uuid);
const tooLate = game(edcr, lauveer, start + 7 * 3600, edcr.uuid);
const tooEarly = game(edcr, lauveer, start - 3600, edcr.uuid);
const edcrHistory = [tooLate, g3, otherPair, g2, g1, reset, tooEarly];
const lauveerHistory = [tooLate, g3, g2, g1, reset];

const {
  _resetPlayoffsForTest,
  bracketActive,
  gameBelongs,
  loadHistory,
  playoffBoard,
  playoffContextFor,
  playoffEloFor,
  playoffLabel,
  playoffParagraph,
  playoffTitleTail,
  seedLabel,
  seedOrdinal,
  slotFor,
  slotGames,
  slotSeeds,
  scoreBefore,
  contextOf,
  slotWindow,
} = await import("./playoffs.js");

/* --- Pure parts --------------------------------------------------------------------------- */

assert.equal(seedLabel(0), "#1 seed");
assert.equal(seedLabel(11), "#12 seed");
assert.equal(seedLabel(12), "LCQ", "the last four came through the last-chance qualifier");

assert.deepEqual(
  [0, 1, 2, 8, 10, 11, 12].map((n) => seedOrdinal(seedLabel(n))),
  ["1st seed", "2nd seed", "3rd seed", "9th seed", "11th seed", "12th seed", "LCQ"],
);

assert.ok(gameBelongs(bracket, slot, g1));
assert.ok(gameBelongs(bracket, slot, g2), "seat order is the room's, not the bracket's");
assert.ok(!gameBelongs(bracket, slot, reset), "a forfeit inside a minute is a room reset");
assert.ok(!gameBelongs(bracket, slot, otherPair));
assert.ok(
  !gameBelongs(
    bracket,
    slot,
    game(edcr, lauveer, start + 1200, null, { forfeited: true, result: { uuid: null, time: 145_000 } }),
  ),
  "a forfeit nobody won is a reset however long it ran (S11 edcr–lauveer, 2:25)",
);
assert.ok(
  gameBelongs(
    bracket,
    slot,
    game(edcr, lauveer, start + 1200, lauveer.uuid, {
      forfeited: true,
      result: { uuid: lauveer.uuid, time: 614_000 },
    }),
  ),
  "a forfeit with a winner is a game",
);
assert.ok(
  gameBelongs(bracket, slot, {
    ...g1,
    players: [seat("6174765b6174765b6174765b6174765b", "OliverSR"), ...g1.players],
  }),
  "the host seated as a third player does not hide the game (S11 13333220)",
);
assert.ok(
  !gameBelongs(bracket, slot, {
    ...g1,
    players: [seat("a", "x"), seat("b", "y"), ...g1.players],
  }),
  "four seats is not a 1v1",
);
assert.ok(!gameBelongs(bracket, slot, tooLate), "six hours after the listed start is another day");
assert.ok(!gameBelongs(bracket, slot, tooEarly), "an hour before it is practice");
assert.ok(
  gameBelongs(bracket, slot, game(edcr, lauveer, start - 600, edcr.uuid)),
  "a quarter hour early is fine",
);
assert.equal(slotFor(bracket, g2)?.id, 9);
assert.equal(slotFor(bracket, otherPair), null, "edcr and Feinberg hold no slot together");

const games = slotGames(bracket, slot, [...edcrHistory, ...lauveerHistory]);
assert.deepEqual(
  games.map((g) => [g.matchId, g.gameNo]),
  [
    [g1.id, 1],
    [g2.id, 2],
    [g3.id, 3],
  ],
  "numbered by date, deduplicated across both histories",
);
// The number is a pure function of the games handed in, so a caller that holds a game the
// history has not indexed yet can fold it in and get the number that counts it.
assert.deepEqual(
  slotGames(bracket, slot, [g1, g2]).map((g) => g.gameNo),
  [1, 2],
);
// The score going into each game, in the slot's seed order, for the band's dots: g1 edcr,
// g2 lauveer, g3 edcr.
const seeds = slotSeeds(bracket, slot)!;
assert.deepEqual(
  games.map((g) => scoreBefore(seeds, games, g.gameNo)),
  [
    [0, 0],
    [1, 0],
    [1, 1],
  ],
);
assert.deepEqual(contextOf(bracket, slot, games, g3.id)?.score, [1, 1]);
assert.equal(contextOf(bracket, slot, games, g3.id)?.firstTo, 3);

// An unscheduled slot takes any game of its pair inside the tournament's month.
const quarter = {
  ...bracket.matches.find((m) => m.id === 5)!,
  participants: [
    { player: 0, roundScore: 0 },
    { player: 7, roundScore: 0 },
  ],
};
const later = { ...bracket, matches: bracket.matches.map((m) => (m.id === 5 ? quarter : m)) };
assert.equal(quarter.startTime, null);
assert.deepEqual(slotWindow(later, quarter), [start - 900, start + 30 * 86_400]);
assert.equal(slotFor(later, game(edcr, feinberg, start + 3 * 86_400, edcr.uuid))?.id, 5);

/* --- Wording: the round, the game, the seeds. Never a series score, never the result -------- */

const ctx = {
  season: 11,
  round: "Round of 16",
  gameNo: 2,
  bestOf: 5,
  firstTo: 3,
  // Carried for the band's dots and for nothing printed: the paragraph check below runs with
  // a score in hand and must still find none.
  score: [1, 0] as [number, number],
  seeds: [
    { uuid: edcr.uuid, nickname: "edcr", label: "#1 seed", seasonEloRate: 2688 },
    { uuid: lauveer.uuid, nickname: "lauveer", label: "LCQ", seasonEloRate: 2137 },
  ] as const,
};
assert.equal(playoffLabel({ ...ctx, seeds: [...ctx.seeds] }), "Round of 16 · Game 2 of 5");
assert.equal(
  playoffTitleTail(ctx),
  "MCSR Ranked Season 11 Playoffs | Round of 16 | Game 2",
);
const para = playoffParagraph({ ...ctx, seeds: [...ctx.seeds] });
assert.ok(para.includes("edcr (1st seed, 2688 elo) vs lauveer (LCQ, 2137 elo)"));
assert.ok(!para.includes("#"), `no hash in playoff paragraph: ${para}`);
const para9 = playoffParagraph({
  ...ctx,
  seeds: [
    { uuid: edcr.uuid, nickname: "edcr", label: "#9 seed", seasonEloRate: 2688 },
    { uuid: lauveer.uuid, nickname: "lauveer", label: "LCQ", seasonEloRate: 2137 },
  ],
});
assert.ok(para9.includes("edcr (9th seed, 2688 elo) vs lauveer (LCQ, 2137 elo)"));
assert.ok(!para9.includes("#"), `no hash in 9th-seed playoff paragraph: ${para9}`);
// The house rule, pinned: no surface prints a series score. "Game 2 of 5" is the only pair of
// numbers allowed near each other, and 2688/2137 are the seeds' ratings.
assert.ok(
  !/\b\d+\s*[–-]\s*\d+\b/.test(para.replace("Game 2 of 5", "")),
  `a score-shaped pair slipped into the paragraph:\n${para}`,
);
assert.ok(para.includes("https://magmamcsr.com/events/playoffs/s11/bracket"));
assert.ok(para.includes("twitch.tv/mcsrranked") && para.includes("youtube.com/@MCSR_Ranked"));

/* --- Fetching: the bracket by season offset, histories paged and cached --------------------- */

const calls: string[] = [];
const ok = (payload: unknown) =>
  new Response(JSON.stringify({ status: "success", data: payload }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  calls.push(url.pathname + url.search);
  if (url.pathname === "/playoffs" || url.pathname === "/playoffs/11")
    return ok({ data: bracket, next: null, prev: 10 });
  if (url.pathname.startsWith("/playoffs/")) {
    return new Response(JSON.stringify({ status: "error", data: "not found" }), { status: 404 });
  }
  const m = /^\/users\/([^/]+)\/matches$/.exec(url.pathname);
  if (m) {
    assert.equal(url.searchParams.get("type"), "3", "playoff games are private-room matches");
    assert.equal(url.searchParams.get("season"), "12", "stamped with the season after the bracket's");
    if (m[1] === edcr.uuid) return ok(edcrHistory);
    if (m[1] === lauveer.uuid) return ok(lauveerHistory);
    if (m[1] === "pager") {
      // One full page newest-first, then a short one. The walk must ask for the next page below
      // the last id it saw, and must stop on the short page rather than spin to MAX_HISTORY_PAGES.
      const before = url.searchParams.get("before");
      if (before === null) return ok(pagerGames.slice(0, 50));
      assert.equal(before, String(pagerGames[49]!.id), "paged by the last id seen, not by date");
      return ok(pagerGames.slice(50));
    }
    return ok([]);
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

// Newest first and ids descending, like the API's own ordering.
const pagerGames: FeedMatch[] = Array.from({ length: 57 }, (_, i) => ({
  ...game(edcr, feinberg, start + 3600 - i, edcr.uuid),
  id: 900_100 - i,
}));

_resetPlayoffsForTest();
const paged = await loadHistory("pager", 12, start - 900);
assert.equal(paged.length, 57, "a full page is followed by the next; a short page ends the walk");
assert.equal(calls.filter((c) => c.includes("/users/pager/")).length, 2);
// A game inside the window stops the walk early even on a full page: the histories only have to
// reach back as far as the slot.
_resetPlayoffsForTest();
calls.length = 0;
assert.equal((await loadHistory("pager", 12, start + 3600)).length, 50, "one page covered the slot");
assert.equal(calls.filter((c) => c.includes("/users/pager/")).length, 1);

_resetPlayoffsForTest();
calls.length = 0;
const found = await playoffContextFor({ ...g2, timelines: [], completions: [] });
assert.deepEqual(
  found && { ...found, seeds: found.seeds.map((s) => [s.nickname, s.label, s.seasonEloRate]) },
  {
    season: 11,
    round: "Round of 16",
    gameNo: 2,
    bestOf: 5,
    firstTo: 3,
    // g1 was edcr's: the dots at g2's start.
    score: [1, 0],
    seeds: [
      ["edcr", "#1 seed", 2688],
      ["lauveer", "LCQ", 2137],
    ],
  },
);
assert.ok(calls[0]!.startsWith("/playoffs/11"), `a season-12 game reads the season-11 bracket: ${calls[0]}`);

// The frozen rating reaches eloAtMatchStart through the resolved context — the game itself has
// no changes[], and the live rating would be the new season's.
assert.equal(playoffEloFor(g2.id, edcr.uuid), 2688);
assert.equal(playoffEloFor(g2.id, "nobody"), null);
const { eloAtMatchStart } = await import("../pipeline/overlayProps.js");
const g2Info = { ...g2, timelines: [], completions: [] };
assert.equal(eloAtMatchStart(g2Info, edcr.uuid, 1500), 2688, "the bracket's rating, not the live one");
assert.equal(eloAtMatchStart(g2Info, lauveer.uuid, null), 2137);
assert.equal(
  eloAtMatchStart({ ...g2Info, id: 1 }, edcr.uuid, 1500),
  1500,
  "an unresolved match keeps the live rating",
);

// A game finished after the histories were cached — the operator pasting an id minutes after the
// slot, on a board the dashboard warmed half an hour ago. The packaging path reads the two
// histories again rather than numbering the game one short, silently.
const g4 = game(edcr, lauveer, start + 2100, lauveer.uuid);
edcrHistory.unshift(g4);
lauveerHistory.unshift(g4);
const warm = calls.length;
const fourth = await playoffContextFor({ ...g4, timelines: [], completions: [] });
assert.equal(fourth?.gameNo, 4, "found on the refetch, not missed as an ordinary match");
assert.equal(calls.length - warm, 2, "one history per seed, the bracket still cached");

// And one the API has not indexed anywhere yet: the match being packaged is always counted
// among the games it is numbered against, so the number can never be short by itself.
const g5 = game(edcr, lauveer, start + 2700, edcr.uuid);
const fifth = await playoffContextFor({ ...g5, timelines: [], completions: [] });
assert.equal(fifth?.gameNo, 5, "numbered from the games known at that moment, itself included");
edcrHistory.shift();
lauveerHistory.shift();

assert.equal(await playoffContextFor({ ...otherPair, timelines: [], completions: [] }), null);
assert.equal(
  await playoffContextFor({ ...g1, type: 2, timelines: [], completions: [] }),
  null,
  "a ranked match is never a playoff game",
);
const before = calls.length;
assert.equal(
  await playoffContextFor({ ...g1, season: 8, timelines: [], completions: [] }),
  null,
  "no bracket for that season",
);
assert.equal(await playoffContextFor({ ...g1, season: 8, id: 5, timelines: [], completions: [] }), null);
assert.equal(calls.length - before, 1, "a 404 bracket is remembered, not re-asked");

/* --- The board: seated slots with their games, only while the bracket is live --------------- */

assert.ok(bracketActive(bracket, start - 10 * 86_400), "ten days out is upcoming");
assert.ok(bracketActive(bracket, start + 10 * 86_400), "ten days in, games may exist");
assert.ok(!bracketActive(bracket, start - 20 * 86_400), "three weeks out is not yet a tournament");
assert.ok(!bracketActive(bracket, start + 40 * 86_400), "and six weeks after it is over");

_resetPlayoffsForTest();
calls.length = 0;
const board = await playoffBoard(start + 3600);
assert.equal(board.season, 11);
assert.equal(board.slots.length, 8, "the eight seated Round of 16 slots; later rounds have no seats yet");
assert.equal(board.slots[0]!.id, 9, "earliest start first, then by id");
const ours = board.slots.find((s) => s.id === 9)!;
assert.deepEqual(
  ours.seeds.map((s) => s.label),
  ["#1 seed", "LCQ"],
);
assert.deepEqual(
  ours.games.map((g) => g.gameNo),
  [1, 2, 3],
);
assert.equal(board.slots.find((s) => s.id === 10)!.games.length, 0);
const histories = calls.filter((c) => c.includes("/matches?")).length;
assert.equal(histories, 16, "one history per seated player");
assert.equal(playoffEloFor(g3.id, lauveer.uuid), 2137, "the board resolves every game it lists");
await playoffBoard(start + 3600);
assert.equal(
  calls.filter((c) => c.includes("/matches?")).length,
  histories,
  "cached: a second board fetches nothing",
);
assert.deepEqual(
  (await playoffBoard(start + 40 * 86_400)).slots,
  [],
  "over: nothing listed, nothing fetched",
);

console.log("playoffs: all checks passed");
