// Contract test for src/playoffs/playoffs.ts, written from the docs (CLAUDE.md "Playoffs" and
// "A playoff game's nameplates show the seed"; handbook/claude-md-reference.md "Playoffs") by an
// outside reader, against the public surface only. playoffs.test.ts pins the wording helpers, the
// paging and the basic numbering; this file covers what that one does not, end to end where it can.
//
// The promises the docs make, as checked below:
//  P1  The bracket knows the series, not the games: a game is a private-room match (type 3)
//      between the slot's two seeds inside its window, numbered by date. A ranked match of the
//      same pair in the same hour is not one of its games.
//  P2  The API stamps a bracket's games with the season *after* the bracket's: a season-12 game
//      reads bracket 11, and a season-11-stamped private match never reads bracket 11.
//  P3  No surface prints a series score — round and game number only. Every printed helper reads
//      the same whatever the going-in score, and the board payload carries no score at all
//      (`roundScore`, the bracket's live score, never reaches it).
//  P4  The format is "Round of 16 · Game 2 of 5": best-of is twice the wins needed less one, so a
//      first-to-4 Grand Finals game reads "Game 1 of 7".
//  P5  The "Playoffs" section sits above the suggestions while a slot is within 14 days.
//  P6  `playoffsFirst` is off by default (it changes what tonight renders), in DEFAULTS and in
//      the generated example config.
//  P7  Quarterfinals onward carry no start and no participants until the round below resolves; a
//      game in such a slot packages as an ordinary private match (no error), and once the bracket
//      fills in and the cache lapses, the same game picks up its round/game framing by itself.
//  P8  The host seated as a ghost third player (S11 13333220) does not hide a game: `getMatch`
//      drops the extra seat and the game still resolves as the slot's.
//  P9  A forfeit nobody won is a room reset however long it ran; a forfeit with a winner counts
//      from 60 s; a reset never takes a game number.
//  P10 A playoff game's nameplates show the seed, not the ladder rank, in the room's seat order;
//      the band carries the frozen season-end elo and the series dots at the going-in score; the
//      intro line is round and game, never a score.
//
// Hermetic: the API is a stub at global fetch (no network), the saved S11 bracket
// (src/fixtures/playoffs-11.json) with every nickname replaced by a neutral "RunnerX" so no real
// runner is paired with a made-up result. Every game here is synthetic.
// Run: npx tsx src/playoffs/playoffs.contract.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, DEFAULTS } from "../config.js";
import type { FeedMatch, MatchInfo, PlayoffBracket, PlayoffSlot, UserDetails } from "../api/types.js";

config.mediaDir = mkdtempSync(path.join(tmpdir(), "playoffs-contract-"));
const tempMediaDir = config.mediaDir;
// On exit, so a failed assert cleans up too.
process.on("exit", () => rmSync(tempMediaDir, { recursive: true, force: true }));

/* --- Deviation reporting: keep the doc's assertion, report and continue ------------------------ */

const deviations: string[] = [];
async function deviation(clause: string, check: () => void | Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    const observed = err.message.split("\n")[0];
    deviations.push(clause);
    console.log(`DEVIATION: ${clause} — ${observed}`);
  }
}

/* --- The bracket, anonymised ------------------------------------------------------------------ */

const envelope = JSON.parse(readFileSync(new URL("../fixtures/playoffs-11.json", import.meta.url), "utf8"));
const real: PlayoffBracket = envelope.data.data;
const bracket: PlayoffBracket = {
  ...real,
  players: real.players.map((p, i) => ({ ...p, nickname: `Runner${String.fromCharCode(65 + i)}` })),
};
const slot9 = bracket.matches.find((m) => m.id === 9)!; // players[0] (#1 seed) vs players[15] (LCQ)
const A = bracket.players[0]!; // "#1 seed", 2688
const P = bracket.players[15]!; // "LCQ", 2137
const H = bracket.players[7]!; // "#8 seed", holds no slot with A
const start = slot9.startTime!;
const lastListedStart = Math.max(...bracket.matches.map((m) => m.startTime ?? 0));
const DAY = 86_400;

let nextId = 14_000_000;
const feedGame = (
  seats: Array<{ uuid: string; nickname: string }>,
  date: number,
  winner: string | null,
  over: Partial<FeedMatch> = {},
): FeedMatch =>
  ({
    id: nextId++,
    type: 3,
    season: 12,
    date,
    players: seats.map((p) => ({ uuid: p.uuid, nickname: p.nickname })),
    spectators: [],
    result: { uuid: winner, time: 480_000 },
    forfeited: false,
    changes: [],
    vod: [],
    rank: { season: null, allTime: null },
    tag: null,
    ...over,
  }) as FeedMatch;
const info = (m: FeedMatch, over: Partial<MatchInfo> = {}): MatchInfo =>
  ({ ...m, timelines: [], completions: [], seedType: null, bastionType: null, ...over }) as MatchInfo;

/* --- The API stub ----------------------------------------------------------------------------- */

const calls: string[] = [];
let served: PlayoffBracket = bracket;
let history: FeedMatch[] = [];
const byId = new Map<number, MatchInfo>();
const ok = (payload: unknown) =>
  new Response(JSON.stringify({ status: "success", data: payload }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "nmsr.nickac.dev") {
    // The overlay inlines its avatars; a 1-byte "image" is enough for the props.
    return new Response(new Uint8Array([0]), { status: 200, headers: { "content-type": "image/png" } });
  }
  assert.equal(url.hostname, "api.mcsrranked.com", `unexpected host: ${url}`);
  calls.push(url.pathname + url.search);
  if (url.pathname === "/playoffs" || url.pathname === "/playoffs/11")
    return ok({ data: served, next: null, prev: 10 });
  if (url.pathname.startsWith("/playoffs/"))
    return new Response(JSON.stringify({ status: "error", data: "not found" }), { status: 404 });
  if (/^\/users\/[^/]+\/matches$/.test(url.pathname)) return ok(history);
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m && byId.has(Number(m[1]))) return ok(byId.get(Number(m[1])));
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const {
  _resetPlayoffsForTest,
  bestOfSlot,
  bracketActive,
  contextOf,
  gameBelongs,
  playoffBoard,
  playoffContextFor,
  playoffContextForId,
  playoffIntroLabel,
  playoffLabel,
  playoffParagraph,
  playoffTitleTail,
  slotGames,
  slotSeeds,
} = await import("./playoffs.js");
const { getMatch } = await import("../api/mcsrApi.js");
const { computeOverlayProps } = await import("../pipeline/overlayProps.js");

/* --- P1: the bracket knows the series; the games are private rooms of the pair, by date ------- */
{
  // Ids run against dates on purpose: the API's ids are not a promise of order, the date is.
  const later = feedGame([A, P], start + 1200, A.uuid, { id: 14_100_001 });
  const earlier = feedGame([P, A], start + 300, P.uuid, { id: 14_100_009 });
  const ranked = feedGame([A, P], start + 600, A.uuid, { type: 2 });
  const casual = feedGame([A, P], start + 900, A.uuid, { type: 1 });
  const games = slotGames(bracket, slot9, [later, ranked, earlier, casual, earlier]);
  // A ranked or casual match of the same pair in the same hour is not a playoff game: the
  // games are private rooms with a referee spectating (handbook "Playoffs").
  assert.deepEqual(
    games.map((g) => [g.matchId, g.gameNo]),
    [
      [earlier.id, 1],
      [later.id, 2],
    ],
    "numbered by date, private rooms only, a game listed twice counted once",
  );
  // The bracket itself names no games: the board's slot gets them from the pair's histories
  // alone — an empty history leaves the seated slot with none, a full one with exactly its games.
  _resetPlayoffsForTest();
  history = [];
  const bare = (await playoffBoard(start + 3600)).slots.find((s) => s.id === 9);
  assert.deepEqual(bare?.games, [], "no history, no games: the bracket supplies none of its own");
  _resetPlayoffsForTest();
  history = [later, ranked, earlier, casual];
  const listed = (await playoffBoard(start + 3600)).slots.find((s) => s.id === 9);
  assert.deepEqual(
    listed?.games.map((g) => [g.matchId, g.gameNo]),
    [
      [earlier.id, 1],
      [later.id, 2],
    ],
    "the board's games are the history's private rooms, numbered by date",
  );
}

/* --- P2: a bracket's games are stamped with the next season ----------------------------------- */
{
  _resetPlayoffsForTest();
  const g = feedGame([A, P], start + 300, A.uuid);
  history = [g];
  calls.length = 0;
  const ctx = await playoffContextFor(info(g));
  assert.equal(ctx?.season, 11, "a season-12 game is a game of the Season 11 playoffs");
  assert.ok(calls[0]?.startsWith("/playoffs/11"), `read the season-11 bracket first: ${calls[0]}`);
  assert.ok(
    calls.some((c) => c.includes("/matches?") && c.includes("season=12")),
    "the histories are read in the games' own season (12), not the bracket's",
  );

  // The same room stamped season 11 belongs to the *Season 10* playoffs, if any: it must never be
  // read against bracket 11 and handed Season 11's framing.
  _resetPlayoffsForTest();
  calls.length = 0;
  const stamped11 = { ...g, id: nextId++, season: 11 };
  assert.equal(await playoffContextFor(info(stamped11)), null, "no Season 10 bracket: an ordinary match");
  assert.deepEqual(
    calls.filter((c) => c.startsWith("/playoffs")),
    ["/playoffs/10"],
    "a season-11 private match asks for bracket 10 only",
  );
}

/* --- P3 + P4: round and game number only; the score never changes a printed word ---------------- */
{
  const seeds = slotSeeds(bracket, slot9)!;
  const ctxAt = (score: [number, number], gameNo = 3) => ({
    season: 11,
    round: "Round of 16",
    gameNo,
    bestOf: 5,
    firstTo: 3,
    seeds,
    score,
  });
  const printed = (score: [number, number]) => [
    playoffLabel(ctxAt(score)),
    playoffTitleTail(ctxAt(score)),
    playoffIntroLabel(ctxAt(score)),
    playoffParagraph(ctxAt(score)),
  ];
  // "A 1–0 going in is as much of a spoiler as the result": the same game reads the same whether
  // it opened 0–0, 2–0 for either side, or 1–1.
  const base = printed([0, 0]);
  for (const score of [
    [2, 0],
    [0, 2],
    [1, 1],
  ] as Array<[number, number]>)
    assert.deepEqual(printed(score), base, `the going-in score ${score.join("-")} changed a printed surface`);
  assert.equal(base[0], "Round of 16 · Game 3 of 5", "round and game, in the documented format");
  assert.equal(base[2], "Season 11 Playoffs · Round of 16 · Game 3", "the intro line: no score");
  for (const text of base) {
    // The only number pairs allowed near each other are "Game 3 of 5" and the seeds' ratings.
    assert.ok(!/\b\d\s*[–-]\s*\d\b/.test(text.replace("Game 3 of 5", "")), `a score-shaped pair in: ${text}`);
    assert.ok(!/\b(won|wins|leads?|up \d|swept|sweep)\b/i.test(text), `a result word in: ${text}`);
  }

  // P4: best-of from the wins needed. The Grand Finals is first to 4 in the saved bracket.
  const gf = bracket.matches.find((m) => m.name === "Grand Finals")!;
  assert.equal(gf.maxRoundScore, 4);
  assert.equal(bestOfSlot(gf), 7);
  const seatedGf: PlayoffSlot = {
    ...gf,
    participants: [
      { player: 0, roundScore: 0 },
      { player: 15, roundScore: 0 },
    ],
  };
  const gfGame = feedGame([A, P], start + 8 * DAY, A.uuid);
  const gfCtx = contextOf(bracket, seatedGf, slotGames(bracket, seatedGf, [gfGame]), gfGame.id)!;
  assert.equal(playoffLabel(gfCtx), "Grand Finals · Game 1 of 7");
  assert.equal(playoffTitleTail(gfCtx), "MCSR Ranked Season 11 Playoffs | Grand Finals | Game 1");

  // The board (GET /api/playoffs) is a surface too. The bracket's own `roundScore` is the score
  // *now* — it must not reach the payload, and the payload must not change with it.
  const g1 = feedGame([A, P], start + 300, A.uuid);
  const g2 = feedGame([A, P], start + 900, A.uuid);
  history = [g1, g2];
  const withScore = (a: number, b: number): PlayoffBracket => ({
    ...bracket,
    matches: bracket.matches.map((m) =>
      m.id === 9
        ? {
            ...m,
            participants: [
              { player: 0, roundScore: a },
              { player: 15, roundScore: b },
            ],
          }
        : m,
    ),
  });
  _resetPlayoffsForTest();
  served = withScore(0, 0);
  const quiet = JSON.stringify(await playoffBoard(start + 3600));
  _resetPlayoffsForTest();
  served = withScore(2, 0);
  const scored = JSON.stringify(await playoffBoard(start + 3600));
  served = bracket;
  assert.equal(scored, quiet, "the bracket's live score changes nothing on the board");
  assert.ok(!scored.includes("roundScore"), "the board never carries the bracket's score");
}

/* --- P5: the section shows while a slot is within 14 days -------------------------------------- */
{
  const firstStart = Math.min(...bracket.matches.map((m) => m.startTime ?? Infinity));
  assert.ok(bracketActive(bracket, firstStart - 14 * DAY), "exactly 14 days before the first slot: shown");
  assert.ok(!bracketActive(bracket, firstStart - 14 * DAY - 1), "a second more than 14 days out: hidden");
  // The doc's other side of "within 14 days": 15 days after the last listed slot, no slot is
  // within 14 days of now, so the section should be gone.
  await deviation(
    'handbook "Playoffs": the section sits above the suggestions "while a slot is within 14 days"',
    () =>
      assert.equal(
        bracketActive(bracket, lastListedStart + 15 * DAY),
        false,
        "15 days after the last listed slot the board is still active (bracketActive keeps a 30-day tail)",
      ),
  );
  // Outside the tournament the board costs one cached bracket read and lists nothing.
  _resetPlayoffsForTest();
  calls.length = 0;
  const over = await playoffBoard(lastListedStart + 60 * DAY);
  assert.deepEqual(over.slots, []);
  assert.deepEqual(calls, ["/playoffs"], "one bracket read, no history fetched");
}

/* --- P6: playoffsFirst is on by default (18 Oct 2026, "pull them first") ----------------------- */
{
  assert.equal(DEFAULTS.playoffsFirst, true, "on by default: a bracket pulls ahead of suggestions");
  assert.equal(config.playoffsFirst, true, "and the running config (DEFAULTS under test) agrees");
  const example = JSON.parse(
    readFileSync(new URL("../../mcsr-vid.config.example.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(example.playoffsFirst, true, "the example config is generated from DEFAULTS");
}

/* --- P7: an unseated slot's game is an ordinary private match until the bracket fills in -------- */
{
  const qf = bracket.matches.find((m) => m.id === 5)!;
  assert.equal(qf.name, "Quarterfinals");
  assert.equal(qf.startTime, null, "the saved bracket: Quarterfinals unscheduled");
  assert.deepEqual(qf.participants, [], "and unseated");
  const qfGame = feedGame([A, H], start + 3 * DAY, H.uuid);
  history = [qfGame];
  _resetPlayoffsForTest();
  assert.equal(gameBelongs(bracket, qf, qfGame), false, "an unseated slot matches no game");
  assert.equal(
    await playoffContextFor(info(qfGame)),
    null,
    "packages as an ordinary private match — no error, no framing",
  );

  // The bracket fills in. Past the cache's life (here: a TTL of zero), the same game is the
  // quarterfinal's game 1 of 5 without anyone re-queueing it.
  served = {
    ...bracket,
    matches: bracket.matches.map((m) =>
      m.id === 5
        ? {
            ...m,
            participants: [
              { player: 0, roundScore: 0 },
              { player: 7, roundScore: 0 },
            ],
          }
        : m,
    ),
  };
  const ttl = config.suggestCacheTtlMin;
  config.suggestCacheTtlMin = 0;
  const filled = await playoffContextFor(info(qfGame));
  config.suggestCacheTtlMin = ttl;
  served = bracket;
  assert.equal(filled && playoffLabel(filled), "Quarterfinals · Game 1 of 5", "framed once seated");
}

/* --- P8: the host's ghost seat does not hide the game ----------------------------------------- */
{
  _resetPlayoffsForTest();
  const host = { uuid: "0000000000000000000000000000beef", nickname: "RoomHost" };
  const g1 = feedGame([A, P], start + 300, A.uuid);
  const ghosted = feedGame([host, A, P], start + 900, P.uuid);
  history = [g1, ghosted];
  byId.set(
    ghosted.id,
    info(ghosted, {
      timelines: [
        { uuid: A.uuid, time: 100_000, type: "story.enter_the_nether" },
        { uuid: P.uuid, time: 110_000, type: "story.enter_the_nether" },
      ],
    } as Partial<MatchInfo>),
  );
  const fetched = await getMatch(ghosted.id);
  assert.deepEqual(
    fetched.players.map((p) => p.uuid),
    [P.uuid, A.uuid].sort(),
    "the seat with no timeline is dropped, the two runners kept (seated by uuid)",
  );
  const ctx = await playoffContextForId(ghosted.id);
  assert.equal(ctx && playoffLabel(ctx), "Round of 16 · Game 2 of 5", "still the slot's game 2");
}

/* --- P9: resets are not games; a won forfeit counts from one minute ---------------------------- */
{
  const forfeit = (date: number, winner: string | null, timeMs: number) =>
    feedGame([A, P], date, winner, { forfeited: true, result: { uuid: winner, time: timeMs } });
  assert.equal(
    gameBelongs(bracket, slot9, forfeit(start, null, 20 * 60_000)),
    false,
    "20 min, no winner: a reset",
  );
  assert.equal(
    gameBelongs(bracket, slot9, forfeit(start, A.uuid, 59_999)),
    false,
    "won inside a minute: a reset",
  );
  assert.equal(gameBelongs(bracket, slot9, forfeit(start, A.uuid, 60_000)), true, "won at a minute: a game");
  const reset = forfeit(start + 100, null, 5 * 60_000);
  const first = feedGame([A, P], start + 700, P.uuid);
  assert.deepEqual(
    slotGames(bracket, slot9, [reset, first]).map((g) => [g.matchId, g.gameNo]),
    [[first.id, 1]],
    "a reset before the first real game never takes a number (S11: 'game 3 of 6')",
  );
}

/* --- P10: the band and nameplates — seed, frozen elo, dots in seat order, no score text --------- */
{
  _resetPlayoffsForTest();
  const g1 = feedGame([A, P], start + 300, A.uuid);
  const g2 = feedGame([P, A], start + 900, A.uuid);
  const g3 = feedGame([A, P], start + 1500, null);
  history = [g1, g2, g3];
  const user = (p: { uuid: string; nickname: string }, liveElo: number, ladderRank: number): UserDetails =>
    ({
      uuid: p.uuid,
      nickname: p.nickname,
      eloRate: liveElo,
      eloRank: ladderRank,
      country: null,
      achievements: { display: [], total: [] },
      statistics: { season: null, total: {} },
    }) as unknown as UserDetails;
  // The room seats by uuid: P's sorts first, so P is on the left, A on the right — the bracket's
  // order (A first) is not the screen's.
  const [leftSeat, rightSeat] = [A, P].sort((x, y) => (x.uuid < y.uuid ? -1 : 1));
  assert.equal(leftSeat, P);
  const props = await computeOverlayProps(
    info(g3, {
      players: [leftSeat!, rightSeat!].map((p) => ({ uuid: p.uuid, nickname: p.nickname })),
    } as Partial<MatchInfo>),
    user(P, 1900, 40),
    user(A, 3000, 2),
    { players: [], results: { ranked: { total: 0 }, casual: { total: 0 } }, changes: {} },
  );
  assert.equal(props.left.seed, "LCQ", "the left plate shows the left runner's seed, not the ladder rank");
  assert.equal(props.right.seed, "#1 seed");
  assert.equal(props.left.eloRate, 2137, "the frozen season-end rating, not the live 1900");
  assert.equal(props.right.eloRate, 2688, "the frozen season-end rating, not the live 3000");
  // Two games before this one, both the right runner's: the dots read 0 left, 2 right, first to 3.
  assert.deepEqual(props.series, { firstTo: 3, leftWins: 0, rightWins: 2 }, "dots in seat order");
  assert.equal(props.playoffLabel, "Season 11 Playoffs · Round of 16 · Game 3", "the band's text: no score");
}

if (deviations.length) console.log(`playoffs.contract: ${deviations.length} deviation(s) reported`);
console.log("playoffs.contract: all checks passed");
