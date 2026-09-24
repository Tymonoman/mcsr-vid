// Self-check for teaser.ts: the first-minute "COMING UP" line, on real matches (src/fixtures) and
// on a generated race that reaches every line the chooser can build.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { MatchInfo } from "../api/types.js";
import { MILESTONES, decidedAtMs } from "../shorts/raceGap.js";
import { TEASER_MAX_CHARS, chooseTeaser } from "./teaser.js";

const load = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
const withEvents = (m: MatchInfo, ...events: MatchInfo["timelines"]): MatchInfo => ({
  ...m,
  timelines: [...m.timelines, ...events],
});

// Real matches: a death beats everything; a close split is the last resort; a match led wire to
// wire with no death outside its last minute gets nothing.
assert.deepEqual(chooseTeaser(load(12929221)), { momentMs: 196454, text: "A DEATH AT THE BASTION" });
// 12730175 has death_spawnpoints (the routine bed warp): they are not "a death".
assert.equal(chooseTeaser(load(12730175))?.text, "0.7 S APART ON BLIND TRAVEL");
assert.equal(chooseTeaser(load(12898432)), null);
assert.equal(chooseTeaser(load(12902901)), null);
// 13549300 changes lead three times; the last, into the End at 6:39, is inside the last minute
// (decided 7:20), so the promise is blind travel, which also overturned the biggest deficit.
assert.deepEqual(chooseTeaser(load(13549300)), {
  momentMs: 314090,
  text: "THE LEAD CHANGES ON BLIND TRAVEL",
});
// 13448958 has a real death at 9:18.9, a second and a half before the dragon: the finish.
assert.deepEqual(chooseTeaser(load(13448958)), {
  momentMs: 322756,
  text: "THE LEAD CHANGES AT THE FORTRESS",
});
// Led wire to wire with bed warps only: nothing (a fallback line is the operator's call).
assert.equal(chooseTeaser(load(13446429)), null);
assert.equal(chooseTeaser(load(13617328)), null);

// Every real match: blind to who won — the same line with the result handed to the other side —
// inside the window, and naming nobody.
for (const id of [12730175, 12898432, 12902901, 12929221, 13446429, 13448958, 13549300, 13617328]) {
  const m = load(id);
  const t = chooseTeaser(m);
  const loser = m.players.find((p) => p.uuid !== m.result.uuid)!.uuid;
  assert.deepEqual(
    chooseTeaser({ ...m, result: { ...m.result, uuid: loser } }),
    t,
    `${id}: reads the result`,
  );
  if (!t) continue;
  assert.ok(t.momentMs >= 60_000 && t.momentMs <= decidedAtMs(m)! - 60_000, `${id}: ${t.momentMs} outside`);
  for (const p of m.players)
    assert.ok(!t.text.includes(p.nickname.toUpperCase()), `${id} names ${p.nickname}`);
}

// The window: a minute into the race at the earliest, a minute before the game is decided at
// the latest. 12902901 has no death; add one for players[0] where it sits on blind travel.
{
  const m = load(12902901);
  const uuid = m.players[0]!.uuid;
  const decided = decidedAtMs(m)!;
  const death = (time: number, type = "projectelo.timeline.death") => ({ uuid, time, type });
  assert.deepEqual(chooseTeaser(withEvents(m, death(decided - 60_000))), {
    momentMs: decided - 60_000,
    text: "A DEATH ON BLIND TRAVEL",
  });
  assert.equal(chooseTeaser(withEvents(m, death(decided - 59_000))), null, "inside the last minute");
  assert.equal(chooseTeaser(withEvents(m, death(59_999))), null, "inside the first minute");
  assert.deepEqual(chooseTeaser(withEvents(m, death(60_000))), {
    momentMs: 60_000,
    text: "A DEATH IN THE OVERWORLD",
  });
  assert.equal(
    chooseTeaser(withEvents(m, death(decided - 90_000, "projectelo.timeline.death_spawnpoint"))),
    null,
    "a bed warp is not a death",
  );
  // No dragon and no result time: nothing says when the game is decided, so nothing is safe.
  const undecided = {
    ...withEvents(m, death(200_000)),
    result: { ...m.result, time: 0 },
  };
  undecided.timelines = undecided.timelines.filter((e) => e.type !== "projectelo.timeline.dragon_death");
  assert.equal(chooseTeaser(undecided), null);
}

// A generated race reaching every line: `L`/`R` arrive at rung i at 100 s + 60 s·i (R 10 s
// later), except where a case says otherwise; the dragon falls at 900 s.
const L = { uuid: "l".repeat(32), nickname: "Leftnick" };
const R = { uuid: "r".repeat(32), nickname: "Rightnick" };
const race = (
  rightAt: (i: number, leftAt: number) => number,
  extra: MatchInfo["timelines"] = [],
): MatchInfo =>
  ({
    players: [L, R],
    result: { uuid: L.uuid, time: 910_000 },
    timelines: [
      ...MILESTONES.flatMap((m, i) => [
        { uuid: L.uuid, time: 100_000 + 60_000 * i, type: m.type },
        { uuid: R.uuid, time: rightAt(i, 100_000 + 60_000 * i), type: m.type },
      ]),
      { uuid: L.uuid, time: 900_000, type: "projectelo.timeline.dragon_death" },
      ...extra,
    ],
  }) as unknown as MatchInfo;

const texts: string[] = [];
const expectText = (m: MatchInfo, text: string) => {
  const t = chooseTeaser(m);
  assert.equal(t?.text, text);
  texts.push(t!.text);
};
assert.equal(chooseTeaser(race((_, t) => t + 10_000)), null, "led wire to wire by 10 s: nothing");
// A lead change at every rung above the Nether (in the Nether nobody led before).
for (let k = 1; k < MILESTONES.length; k++) {
  const m = race((i, t) => (i < k ? t + 10_000 : t - 5_000));
  expectText(
    m,
    `THE LEAD CHANGES ${["", "AT THE BASTION", "AT THE FORTRESS", "ON BLIND TRAVEL", "IN THE STRONGHOLD", "IN THE END"][k]}`,
  );
  assert.equal(chooseTeaser(m)!.momentMs, 100_000 + 60_000 * k - 5_000, "at the new leader's arrival");
}
// The biggest overturned deficit wins: the Fortress flip (10 s down at the Bastion) beats blind
// travel (1 s down) and the Stronghold (3 s down).
assert.equal(
  chooseTeaser(
    race((i, t) =>
      i === 0 ? t + 3_000 : i === 1 ? t + 10_000 : i === 2 ? t - 1_000 : i === 3 ? t + 3_000 : t - 1_000,
    ),
  )?.text,
  "THE LEAD CHANGES AT THE FORTRESS",
);
// The first dragon decides the game whoever kills it, so an earlier one pulls the window in: the
// Fortress flip at 215 s needs the dragon at 275 s or later.
{
  const flipAtFortress = (dragonAt: number) =>
    chooseTeaser(
      race(
        (i, t) => (i < 2 ? t + 10_000 : t - 5_000),
        [{ uuid: R.uuid, time: dragonAt, type: "projectelo.timeline.dragon_death" }],
      ),
    );
  assert.equal(flipAtFortress(274_999), null, "the flip is inside the last minute");
  assert.deepEqual(flipAtFortress(275_000), { momentMs: 215_000, text: "THE LEAD CHANGES AT THE FORTRESS" });
}
// A close split at every rung.
for (let k = 0; k < MILESTONES.length; k++)
  expectText(
    race((i, t) => t + (i === k ? 1_900 : 10_000)),
    `1.9 S APART ${MILESTONES[k]!.behind}`,
  );
// A death on every rung and before the first; the furthest rung wins, then the earliest.
for (let k = -1; k < MILESTONES.length; k++) {
  const at = k < 0 ? 70_000 : 100_000 + 60_000 * k + 20_000;
  expectText(
    race((_, t) => t + 10_000, [{ uuid: R.uuid, time: at, type: "projectelo.timeline.death" }]),
    `A DEATH ${k < 0 ? "IN THE OVERWORLD" : ["IN THE NETHER", "AT THE BASTION", "AT THE FORTRESS", "ON BLIND TRAVEL", "IN THE STRONGHOLD", "IN THE END"][k]}`,
  );
}
assert.equal(
  chooseTeaser(
    race(
      (_, t) => t + 10_000,
      [
        { uuid: R.uuid, time: 130_000, type: "projectelo.timeline.death" },
        { uuid: L.uuid, time: 250_000, type: "projectelo.timeline.death" },
        { uuid: L.uuid, time: 260_000, type: "projectelo.timeline.death" },
      ],
    ),
  )?.momentMs,
  250_000,
);

// Every line the chooser can build: short enough for two lines of the meta column, and silent
// on who and on how it ends.
for (const t of texts) {
  assert.ok(t.length <= TEASER_MAX_CHARS, `${t} is ${t.length} characters`);
  assert.equal(t, t.toUpperCase());
  for (const w of [L.nickname, R.nickname, "DRAGON", "WIN", "FINISH", "WON", "LOSE", "BEAT"])
    assert.ok(!t.includes(w.toUpperCase()), `${t} says ${w}`);
}
console.log(`teaser: all checks passed (${texts.length} lines)`);
