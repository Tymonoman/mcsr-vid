// Self-check for the DNF verdict on a whole video (`matchIsDnf`) and the playoffs board, from the
// rule alone (the operator, 16 Oct 2026: "remember not to post DNF matches also dont suggest them";
// the lead's reading for a series: a forfeited game inside an otherwise finished series does not
// block the series, a single forfeited playoff game is a DNF like any ranked match). The bracket is
// the saved Season 11 one (src/fixtures/playoffs-11.json); the API is stubbed at global fetch.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/playoffs/playoffs.dnf.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { FeedMatch, MatchInfo, PlayoffBracket } from "../api/types.js";
import {
  _resetPlayoffsForTest,
  dnfRefusal,
  matchIsDnf,
  playoffBoard,
  type PlayoffGame,
  type PlayoffSeries,
} from "./playoffs.js";

const finished = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const forfeit: MatchInfo = { ...finished, forfeited: true, completions: [] };
const served = (m: MatchInfo) => async () => m;
const noSeries = async () => null;
const seriesOf = (games: Partial<PlayoffGame>[]) => async () => ({ games }) as unknown as PlayoffSeries;

// --- A ranked match: judged alone --------------------------------------------------------------
assert.equal(await matchIsDnf(1, served(finished), noSeries), false, "a finished ranked match goes ahead");
assert.equal(await matchIsDnf(1, served(forfeit), noSeries), true, "a forfeited ranked match is a DNF");
assert.equal(
  await matchIsDnf(1, served({ ...finished, result: { ...finished.result, uuid: null } }), noSeries),
  true,
  "no winner is a DNF",
);
console.log("OK: a ranked match is a DNF when nobody finished, and only then");

// --- A playoff game: judged by its series --------------------------------------------------------
assert.equal(
  await matchIsDnf(2, served(forfeit), seriesOf([{ matchId: 1 }, { matchId: 2, dnf: true }, { matchId: 3 }])),
  false,
  "a forfeited game inside an otherwise finished series is not blocked",
);
assert.equal(
  await matchIsDnf(2, served(forfeit), seriesOf([{ matchId: 2, dnf: true }])),
  true,
  "a single forfeited playoff game is a DNF",
);
assert.equal(
  await matchIsDnf(
    2,
    served(forfeit),
    seriesOf([
      { matchId: 1, dnf: true },
      { matchId: 2, dnf: true },
    ]),
  ),
  true,
  "a series nobody finished a game of is a DNF",
);
assert.equal(
  await matchIsDnf(9, served(forfeit), seriesOf([{ matchId: 1 }, { matchId: 2 }])),
  true,
  "a room reset (not a game of the series) is judged alone",
);
// The series is never even asked about a finished match.
let asked = 0;
await matchIsDnf(1, served(finished), async () => (asked++, null));
assert.equal(asked, 0, "a finished match costs no bracket read");
console.log("OK: a series video is a DNF only when every game in it is one");

// --- A down API refuses nothing, and says so ----------------------------------------------------
{
  const logged: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const down = async () => {
      throw new Error("MCSR Ranked API /matches/5 -> 503");
    };
    assert.equal(await matchIsDnf(5, down, noSeries), false, "an unreadable match is not refused");
  } finally {
    console.error = error;
  }
  assert.ok(
    logged.some((l) => /match 5: DNF check skipped — .*503/.test(l)),
    `logged: ${logged.join(" | ")}`,
  );
}
assert.equal(dnfRefusal(7, "it is not rendered"), "match 7 is a DNF (nobody finished) — it is not rendered");
console.log("OK: a down API refuses nothing; the refusal reads the same everywhere");

// --- The board: a series with nothing but DNFs offers nothing ------------------------------------
const bracket: PlayoffBracket = JSON.parse(
  readFileSync(new URL("../fixtures/playoffs-11.json", import.meta.url), "utf8"),
).data.data;
const slot9 = bracket.matches.find((m) => m.id === 9)!; // edcr vs lauveer
const slot10 = bracket.matches.find((m) => m.id === 10)!;
const seat = (i: number) => bracket.players[slot10.participants[i]!.player]!;
const [edcr, lauveer] = [bracket.players[0]!, bracket.players[15]!];
let nextId = 13_200_000;
const game = (
  a: { uuid: string; nickname: string },
  b: { uuid: string; nickname: string },
  date: number,
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
    result: { uuid: a.uuid, time: 480_000 },
    forfeited: false,
    vod: [],
    ...over,
  }) as FeedMatch;
// Slot 9: game 1 forfeited at 10:14 (a winner on record, past the first minute: a real game), game 2 finished.
const s9g1 = game(edcr, lauveer, slot9.startTime! + 300, {
  forfeited: true,
  result: { uuid: edcr.uuid, time: 614_061 },
});
const s9g2 = game(lauveer, edcr, slot9.startTime! + 1200);
// Slot 10: its only game so far is a forfeit.
const s10g1 = game(seat(0), seat(1), slot10.startTime! + 300, {
  forfeited: true,
  result: { uuid: seat(0).uuid, time: 300_000 },
});
const histories: Record<string, FeedMatch[]> = {
  [edcr.uuid]: [s9g2, s9g1],
  [lauveer.uuid]: [s9g2, s9g1],
  [seat(0).uuid]: [s10g1],
  [seat(1).uuid]: [s10g1],
};
const saved = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }));
  if (url.pathname === "/playoffs" || url.pathname === "/playoffs/11") return ok({ data: bracket });
  const m = /^\/users\/([^/]+)\/matches$/.exec(url.pathname);
  if (m) return ok(histories[m[1]!] ?? []);
  throw new Error(`no network in this test: ${url.href}`);
}) as typeof fetch;
try {
  _resetPlayoffsForTest();
  const board = await playoffBoard(slot9.startTime! + 3600);
  const games = (id: number) => board.slots.find((s) => s.id === id)!.games;
  assert.deepEqual(
    games(9).map((g) => [g.matchId, g.gameNo, g.dnf]),
    [
      [s9g1.id, 1, true],
      [s9g2.id, 2, false],
    ],
    "a forfeited game among finished ones stays on the board, numbered, for its series",
  );
  assert.deepEqual(games(10), [], "a series whose only game is a forfeit offers nothing to render");
  console.log("OK: the board hides a series of DNFs and keeps a forfeited game inside a finished series");

  // The same through the real series lookup: slot 9's forfeit renders for its series, slot 10's does not.
  const full = (f: FeedMatch): MatchInfo => ({ ...(f as MatchInfo), completions: [], timelines: [] });
  _resetPlayoffsForTest();
  assert.equal(
    await matchIsDnf(s9g1.id, served(full(s9g1))),
    false,
    "slot 9's forfeited game 1 is its series'",
  );
  assert.equal(await matchIsDnf(s10g1.id, served(full(s10g1))), true, "slot 10's lone forfeit is a DNF");
  console.log("OK: matchIsDnf reads the bracket for a playoff game, the same verdict as the board");
} finally {
  globalThis.fetch = saved;
}

console.log("playoffs.dnf: all checks passed");
