// Contract tests for "explain the moves" (src/pipeline/explainMoves.ts), from CLAUDE.md "What the
// render produces" and handbook/claude-md-reference.md. Promise P11 of the list at the top of
// splitStates.contract.test.ts (timing and overlap, P12, are tested there):
//
//  P11 One card the first time EITHER player reaches each of the six MILESTONES splits, showing
//      the split and why (`MOVE_LINES`); it names nobody.
//
// explainMoves.test.ts pins eight fixtures and the line widths; this covers every fixture, a split
// only one seat reached, which seat got there first, and the six against the timeline itself.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import type { MatchInfo } from "../api/types.js";
import { MILESTONES } from "../shorts/raceGap.js";
import { MOVE_LINES, chooseMoves } from "./explainMoves.js";

globalThis.fetch = (async () => {
  throw new Error("explain-the-moves reached for the network");
}) as typeof fetch;

const fixtures = readdirSync(new URL("../fixtures/", import.meta.url))
  .filter((f) => /^match-\d+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8")) as MatchInfo);

// "six MILESTONES splits", each with its own line.
assert.equal(MILESTONES.length, 6, "six splits");
assert.deepEqual(
  new Set(Object.keys(MOVE_LINES)),
  new Set(MILESTONES.map((m) => m.type)),
  "a line per split",
);
assert.equal(new Set(Object.values(MOVE_LINES).map((l) => l.head)).size, 6, "six different heads");

// Every real match: one card per split either seat reached, at the earlier of the two arrivals,
// carrying that split's own head and line — checked against the raw timeline, not the code's maps.
for (const m of fixtures) {
  const seats = m.players.map((p) => p.uuid);
  const cards = chooseMoves(m);
  const expected = MILESTONES.flatMap(({ type }) => {
    const t = m.timelines.filter((e) => e.type === type && seats.includes(e.uuid)).map((e) => e.time);
    return t.length ? [{ atMs: Math.min(...t), ...MOVE_LINES[type]! }] : [];
  }).sort((a, b) => a.atMs - b.atMs);
  assert.deepEqual(cards, expected, `${m.id}: a card per split, at its first arrival`);
  assert.equal(new Set(cards.map((c) => c.head)).size, cards.length, `${m.id}: each split once`);

  // Names nobody: no nickname anywhere on a card, and the cards cannot tell who won or who sits
  // where — the same cards with the result handed to either player and the seats swapped.
  for (const c of cards)
    for (const p of m.players) {
      const name = p.nickname.toUpperCase();
      assert.ok(!c.head.includes(name) && !c.line.includes(name), `${m.id}: a card names a player`);
    }
  for (const p of m.players)
    assert.deepEqual(
      chooseMoves({ ...m, result: { ...m.result, uuid: p.uuid } }),
      cards,
      `${m.id}: reads the result`,
    );
  assert.deepEqual(
    chooseMoves({ ...m, players: [m.players[1]!, m.players[0]!] }),
    cards,
    `${m.id}: reads the seats`,
  );
}

// "either player": a split reached by one seat only is still explained, at that seat's time —
// whichever seat it is. Take the fortress away from one seat, then from the other.
{
  const m = fixtures[0]!;
  const fortress = "nether.find_fortress";
  for (const [kept, gone] of [
    [m.players[0]!, m.players[1]!],
    [m.players[1]!, m.players[0]!],
  ]) {
    const oneSeat = {
      ...m,
      timelines: m.timelines.filter((e) => !(e.type === fortress && e.uuid === gone.uuid)),
    };
    const keptAt = Math.min(
      ...m.timelines.filter((e) => e.type === fortress && e.uuid === kept.uuid).map((e) => e.time),
    );
    const card = chooseMoves(oneSeat).find((c) => c.head === MOVE_LINES[fortress]!.head);
    assert.equal(card?.atMs, keptAt, "a split only one seat reached still gets its card");
  }
  // Nobody reached it: no card, and the other five are untouched.
  const nobody = { ...m, timelines: m.timelines.filter((e) => e.type !== fortress) };
  assert.deepEqual(
    chooseMoves(nobody),
    chooseMoves(m).filter((c) => c.head !== MOVE_LINES[fortress]!.head),
    "a split nobody reached is no card",
  );
}

// The first time, not every time: a second blind travel (a re-throw) or a second Nether entry
// adds no card and does not move the first.
{
  const m = fixtures[0]!;
  const again = {
    ...m,
    timelines: [
      ...m.timelines,
      ...m.timelines
        .filter((e) => e.type === "projectelo.timeline.blind_travel" || e.type === "story.enter_the_nether")
        .map((e) => ({ ...e, time: e.time + 30_000 })),
    ],
  };
  assert.deepEqual(chooseMoves(again), chooseMoves(m), "repeats are not new cards");
}

console.log("explainMoves.contract: all checks passed");
