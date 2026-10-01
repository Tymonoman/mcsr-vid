// Self-check for pinnedQuestion.ts: the pinned comment's question, on real matches (src/fixtures) and
// on generated races that reach every branch. Run: npx tsx src/pipeline/pinnedQuestion.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { MatchInfo } from "../api/types.js";
import { MILESTONES } from "../shorts/raceGap.js";
import { pinnedQuestion } from "./pinnedQuestion.js";

const load = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;

// Real matches: the rung from the bastion to the stronghold where the two got there closest
// together. 12730175's blind travel is 0.7 s apart (the teaser's line for it says the same),
// 13448958's fortress 1.0 s, 13549300's stronghold 3.8 s, the tightest of its four.
assert.equal(pinnedQuestion(load(12730175)), "who would you have backed on blind travel, edcr or doogile?");
assert.equal(
  pinnedQuestion(load(12929221)),
  "who would you have backed at the bastion, Feinberg or silverrruns?",
);
assert.equal(pinnedQuestion(load(13448958)), "who would you have backed at the fortress, Infume or bbiddd?");
assert.equal(
  pinnedQuestion(load(13549300)),
  "who would you have backed at the stronghold, hackingnoises or BeefSalad?",
);

// Every real match: blind to who won (the same question with the result handed to the other side),
// both players named once in the order the video shows them, and nobody ahead, no winner, no shouting.
for (const id of [12730175, 12898432, 12902901, 12929221, 13446429, 13448958, 13549300, 13617328, 13673240]) {
  const m = load(id);
  const q = pinnedQuestion(m)!;
  const loser = m.players.find((p) => p.uuid !== m.result.uuid)!.uuid;
  assert.equal(
    pinnedQuestion({ ...m, result: { ...m.result, uuid: loser, time: 1 } }),
    q,
    `${id}: reads the result`,
  );
  const [left, right] = m.players.map((p) => p.nickname);
  assert.ok(q.endsWith(`, ${left} or ${right}?`), `${id}: ${q}`);
  assert.equal(q.split(left!).length, 2, `${id}: names ${left} more than once`);
  assert.ok(!/[!A-Z]/.test(q.replace(left!, "").replace(right!, "")), `${id}: not plain lowercase: ${q}`);
  assert.match(
    q,
    /^who would you have backed (at the bastion|at the fortress|on blind travel|at the stronghold),/,
  );
}

// Generated races: `gaps[i]` is how far behind the left player the right one reaches rung i, null
// when the right player never does. The left reaches rung i at a minute per rung.
const base = load(12902901);
const [left, right] = base.players;
const race = (gaps: Array<number | null>): MatchInfo => ({
  ...base,
  timelines: MILESTONES.flatMap((m, i) => [
    { uuid: left!.uuid, time: 60_000 * (i + 1), type: m.type },
    ...(gaps[i] === null || gaps[i] === undefined
      ? []
      : [{ uuid: right!.uuid, time: 60_000 * (i + 1) + gaps[i]!, type: m.type }]),
  ]),
});
const q = (gaps: Array<number | null>, series = false) => pinnedQuestion(race(gaps), series);
const who = `${left!.nickname} or ${right!.nickname}?`;

assert.equal(q([0, 9000, 2000, 6000, 7000, 0]), `who would you have backed at the fortress, ${who}`);
// A tie goes to the later rung, and it is the distance that counts: the right player ahead is as close.
assert.equal(q([0, 5000, 5000, 9000, 9000, 0]), `who would you have backed at the fortress, ${who}`);
assert.equal(q([0, 5000, 9000, -1000, 9000, 0]), `who would you have backed on blind travel, ${who}`);
// The nether and the end are not rungs to be asked about, however close: no other rung, the plain prediction.
assert.equal(q([0, null, null, null, null, 0]), `who do you have winning this one, ${who}`);
// A rung only one of them reached has no gap.
assert.equal(q([0, null, 4000, null, null, null]), `who would you have backed at the fortress, ${who}`);
assert.equal(q([null, null, null, null, null, null]), `who do you have winning this one, ${who}`);
// A series holds every game, so one game's rung is not its question.
assert.equal(q([0, 5000, 5000, 9000, 9000, 0], true), `who do you have taking the series, ${who}`);
// Nobody to ask about.
assert.equal(pinnedQuestion({ ...base, players: base.players.slice(0, 1) }), null);

console.log("pinnedQuestion: all checks passed");
