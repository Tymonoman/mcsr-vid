// Self-check for explainMoves.ts: one card per split kind, at the first arrival of either player,
// on the real matches in src/fixtures, and blind to who won.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { MatchInfo } from "../api/types.js";
import { MILESTONES } from "../shorts/raceGap.js";
import { MOVE_LINES, MOVE_MAX_ROWS, MOVE_ROW_MAX_CHARS, chooseMoves } from "./explainMoves.js";

const load = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;

// A line for every rung the race climbs, short enough for the column, naming no side.
assert.deepEqual(Object.keys(MOVE_LINES).sort(), MILESTONES.map((m) => m.type).sort());
for (const { head, line } of Object.values(MOVE_LINES)) {
  const rows = line.split("\n");
  assert.ok(rows.length <= MOVE_MAX_ROWS, `${rows.length} rows: ${line}`);
  for (const row of rows) assert.ok(row.length <= MOVE_ROW_MAX_CHARS, `${row.length} chars: ${row}`);
  assert.ok(head.length <= 12, head);
  assert.equal(line, line.toUpperCase());
  assert.doesNotMatch(line, /\b(LEAD|AHEAD|BEHIND|FIRST|WIN|WINS|WINNER)\b/, line);
}

// 13549300: the right seat is first into the Nether (1:53.8) and to the bastion; the left first on
// blind travel. A card is the first arrival whoever made it.
{
  assert.deepEqual(
    chooseMoves(load(13549300)).map((m) => [m.head, m.atMs]),
    [
      ["NETHER", 113_774],
      ["BASTION", 129_186],
      ["FORTRESS", 241_283],
      ["BLIND TRAVEL", 314_090],
      ["STRONGHOLD", 379_310],
      ["THE END", 399_261],
    ],
  );
}

for (const id of [12730175, 12898432, 12902901, 12929221, 13446429, 13448958, 13549300, 13617328]) {
  const m = load(id);
  const moves = chooseMoves(m);
  assert.equal(moves.length, 6, `${id}: every fixture reaches all six splits`);
  for (let i = 1; i < moves.length; i++) assert.ok(moves[i - 1]!.atMs <= moves[i]!.atMs, `${id}: in order`);
  // The same cards with the result handed to the other side, and with the seats swapped.
  const loser = m.players.find((p) => p.uuid !== m.result.uuid)!.uuid;
  assert.deepEqual(
    chooseMoves({ ...m, result: { ...m.result, uuid: loser } }),
    moves,
    `${id}: reads the result`,
  );
  assert.deepEqual(chooseMoves({ ...m, players: [...m.players].reverse() }), moves, `${id}: reads the seats`);
}

// A split nobody reached is no card; an event from someone not seated (a private room's host) is
// not an arrival.
{
  const m = load(12902901);
  const noEnd = { ...m, timelines: m.timelines.filter((e) => e.type !== "story.enter_the_end") };
  assert.ok(!chooseMoves(noEnd).some((c) => c.head === "THE END"));
  const ghost = {
    ...m,
    timelines: [...m.timelines, { uuid: "ghost", time: 1, type: "story.enter_the_nether" }],
  };
  assert.equal(chooseMoves(ghost)[0]!.atMs, chooseMoves(m)[0]!.atMs);
}

console.log("OK: one card per split, at the first arrival, whoever got there");
