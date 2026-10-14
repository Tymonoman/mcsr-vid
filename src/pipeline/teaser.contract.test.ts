// Contract tests for the COMING UP moment (src/pipeline/teaser.ts), from CLAUDE.md "What the
// render produces" and handbook/claude-md-reference.md's long form of it. Promises P5–P9 of the
// list at the top of splitStates.contract.test.ts:
//
//  P5  From `match.timelines` only: ready at render time, no model call, no other match field.
//  P6  An unplanned death, else the biggest-deficit lead change, else a split under 2 s.
//  P7  Never in the first minute, never in the last minute before the game is decided.
//  P8  Names nobody: the same moment whoever sits left, whoever won, whatever they are called.
//  P9  Reads `death` only: never a hunger reset, never a bed-spawn death in the End.
//
// The existing teaser.test.ts pins the death window and the per-rung lines; this file covers the
// lead-change and close-split windows, the forfeit clock, every fixture, and the edges between.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import type { MatchInfo } from "../api/types.js";
import { MILESTONES, decidedAtMs } from "../shorts/raceGap.js";
import { TEASER_BEFORE_DECIDED_MS, TEASER_EARLIEST_MS, chooseTeaser } from "./teaser.js";

// P5: no model call, no fetch of any kind — the moment must be ready at render time.
globalThis.fetch = (async () => {
  throw new Error("the teaser reached for the network");
}) as typeof fetch;

/** Keeps the suite green on a documented promise the code breaks, and says so for triage. */
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (e) {
    if (!(e instanceof assert.AssertionError)) throw e;
    console.log(`DEVIATION: ${clause} — ${e.message.split("\n")[0]}`);
  }
}

const fixtures = readdirSync(new URL("../fixtures/", import.meta.url))
  .filter((f) => /^match-\d+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8")) as MatchInfo);

// Two made-up runners. Each rung i: `A` arrives at 100 s + 60 s·i, `B` per the case; one dragon
// at 900 s decides the game, so the window is [60 s, 840 s].
const A = { uuid: "a".repeat(32), nickname: "Alphaplayer" };
const B = { uuid: "b".repeat(32), nickname: "Bravoplayer" };
type Ev = MatchInfo["timelines"][number];
const ev = (who: { uuid: string }, time: number, type: string): Ev => ({ uuid: who.uuid, time, type }) as Ev;
const DEATH = "projectelo.timeline.death";
const SPAWN = "projectelo.timeline.death_spawnpoint";
const DRAGON = "projectelo.timeline.dragon_death";
const race = (opts: {
  aAt?: (i: number) => number;
  bAt: (i: number, aAt: number) => number;
  extra?: Ev[];
  dragonAt?: number | null;
  resultMs?: number;
}): MatchInfo => {
  const aAt = opts.aAt ?? ((i: number) => 100_000 + 60_000 * i);
  return {
    id: 1,
    players: [A, B],
    result: { uuid: null, time: opts.resultMs ?? 910_000 },
    changes: [],
    timelines: [
      ...MILESTONES.flatMap((m, i) => [ev(A, aAt(i), m.type), ev(B, opts.bAt(i, aAt(i)), m.type)]),
      ...(opts.dragonAt === null ? [] : [ev(A, opts.dragonAt ?? 900_000, DRAGON)]),
      ...(opts.extra ?? []),
    ],
  } as unknown as MatchInfo;
};
const swapSeats = (m: MatchInfo): MatchInfo => ({ ...m, players: [m.players[1]!, m.players[0]!] });
const wireToWire = (i: number, t: number) => t + 10_000 + i; // B 10 s behind everywhere: no moment

// --- P5: timelines only -----------------------------------------------------------------------
for (const m of fixtures) {
  const t = chooseTeaser(m);
  // Synchronous: a Promise here would mean something is fetched or asked at render time.
  assert.ok(!(t instanceof Promise), `${m.id}: the moment is computed, not fetched`);
  // Everything but the timeline changed: the result (who and, with a dragon on record, when), the
  // rating changes, the seed, the date and the names. None of it may move the moment.
  assert.ok(decidedAtMs(m) !== null && m.timelines.some((e) => e.type === DRAGON), `${m.id} has a dragon`);
  const other = m.players.find((p) => p.uuid !== m.result.uuid)!;
  const scrubbed = {
    ...m,
    result: { uuid: other.uuid, time: m.result.time + 123_456 },
    changes: [],
    seedType: null,
    bastionType: null,
    date: 0,
    players: m.players.map((p, i) => ({ ...p, nickname: `Seat${i}` })),
  } as unknown as MatchInfo;
  assert.deepEqual(chooseTeaser(scrubbed), t, `${m.id}: read something beyond match.timelines`);
}
console.log("OK: P5 — the moment is a pure function of the timeline, on every fixture");

// --- P6: the order of preference ---------------------------------------------------------------
{
  // All three kinds at once: B takes the lead at the fortress (10 s down at the bastion), the
  // blind split is 1.2 s apart, and B dies in the stronghold.
  const bAt = (i: number, t: number) => (i < 2 ? t + 10_000 : i === 3 ? t - 1_200 : t - 5_000);
  const death = ev(B, 100_000 + 60_000 * 4 + 20_000, DEATH);
  assert.equal(
    chooseTeaser(race({ bAt, extra: [death] }))?.text,
    "A DEATH IN THE STRONGHOLD",
    "a death first",
  );
  assert.equal(
    chooseTeaser(race({ bAt }))?.text,
    "THE LEAD CHANGES AT THE FORTRESS",
    "no death: the lead change beats a close split",
  );
  // No lead change (B is behind everywhere), one split 1.2 s apart: the last resort.
  assert.equal(
    chooseTeaser(race({ bAt: (i, t) => t + (i === 3 ? 1_200 : 10_000) }))?.text,
    "1.2 S APART ON BLIND TRAVEL",
  );
  // "under 2 s" is strict: exactly two seconds apart is not a close split; a millisecond less is.
  assert.equal(
    chooseTeaser(race({ bAt: (i, t) => t + (i === 2 ? 2_000 : 10_000) })),
    null,
    "2.000 s is not under 2 s",
  );
  assert.equal(chooseTeaser(race({ bAt: (i, t) => t + (i === 2 ? 1_999 : 10_000) }))?.momentMs, 221_999);
  // Two lead changes: the one that overturned the bigger deficit wins, not the first or the last.
  // B 3 s down at the Nether takes the bastion; A, 20 s down there, takes back the fortress.
  const twoFlips = race({
    bAt: (i, t) => (i === 0 ? t + 3_000 : i === 1 ? t - 20_000 : t + 5_000),
  });
  assert.deepEqual(chooseTeaser(twoFlips), { momentMs: 220_000, text: "THE LEAD CHANGES AT THE FORTRESS" });

  // A dead heat — both seats reach a rung on the same millisecond — is not a lead change, and the
  // answer cannot depend on which seat the earlier leader happens to sit in. Here A leads the
  // Nether by 10 s, both reach the bastion on the same ms, A is ahead again everywhere after.
  const deadHeat = race({ bAt: (i, t) => (i === 1 ? t : t + 10_000) });
  deviation("an unplanned death, else the biggest-deficit lead change, else a split under 2s", () => {
    const seated = chooseTeaser(deadHeat);
    const swapped = chooseTeaser(swapSeats(deadHeat));
    assert.deepEqual(
      swapped,
      seated,
      `a same-millisecond arrival reads "${seated?.text}" seated and "${swapped?.text}" with the seats swapped`,
    );
    assert.ok(!swapped?.text.startsWith("THE LEAD CHANGES"), "a dead heat is promised as a lead change");
  });
}
console.log("OK: P6 — death, then the biggest overturned deficit, then a split strictly under 2 s");

// --- P7: the window, for every kind of moment --------------------------------------------------
{
  assert.equal(TEASER_EARLIEST_MS, 60_000, "the first minute");
  assert.equal(TEASER_BEFORE_DECIDED_MS, 60_000, "the last minute before the game is decided");

  // A lead change at 59.999 s is in the first minute; at 60 s it is not. A is 5 s ahead into the
  // Nether, B reaches the bastion first and stays 10 s ahead from there.
  const flipAt = (t: number) =>
    race({
      aAt: (i) => (i === 0 ? t - 20_000 : t + 10_000 + 60_000 * i),
      bAt: (i) => (i === 0 ? t - 15_000 : i === 1 ? t : t + 60_000 * i),
    });
  assert.equal(chooseTeaser(flipAt(59_999)), null, "a lead change in the first minute");
  assert.deepEqual(chooseTeaser(flipAt(60_000)), {
    momentMs: 60_000,
    text: "THE LEAD CHANGES AT THE BASTION",
  });

  // A close split is its later arrival: 58.5/59.5 s is inside the first minute, 59.5/60.5 s is not.
  const closeNether = (a: number, b: number) =>
    race({ aAt: (i) => (i === 0 ? a : 100_000 + 60_000 * i), bAt: (i, t) => (i === 0 ? b : t + 10_000) });
  assert.equal(chooseTeaser(closeNether(58_500, 59_500)), null, "a close split in the first minute");
  assert.equal(chooseTeaser(closeNether(59_500, 60_500))?.momentMs, 60_500);

  // The last minute, for a lead change and a close split: the dragon at 900 s closes the window
  // at 840 s. The End rung is A's at 400 s, so move B's End entry around it.
  const endFlip = (bEnd: number, dragonAt: number) =>
    race({ bAt: (i, t) => (i === 5 ? bEnd : t + 10_000), dragonAt, extra: [] });
  // B reaches the End first (A's End entry pushed later), 10 s down at the stronghold before.
  const lateEnd = (bEnd: number, dragonAt: number) => {
    const m = endFlip(bEnd, dragonAt);
    m.timelines = m.timelines.map((e) =>
      e.uuid === A.uuid && e.type === "story.enter_the_end" ? { ...e, time: bEnd + 5_000 } : e,
    );
    return m;
  };
  assert.equal(chooseTeaser(lateEnd(800_000, 859_999)), null, "a lead change in the last minute");
  assert.deepEqual(chooseTeaser(lateEnd(800_000, 860_000)), {
    momentMs: 800_000,
    text: "THE LEAD CHANGES IN THE END",
  });
  const closeEnd = (dragonAt: number) =>
    chooseTeaser(race({ bAt: (i, t) => t + (i === 5 ? 1_000 : 10_000), dragonAt }));
  // The End split completes at 401 s.
  assert.equal(closeEnd(460_999), null, "a close split in the last minute");
  assert.equal(closeEnd(461_000)?.momentMs, 401_000);

  // A forfeit has no dragon: the game is decided at result.time, and the last minute is before it.
  const forfeit = (resultMs: number) =>
    chooseTeaser(race({ bAt: wireToWire, dragonAt: null, resultMs, extra: [ev(B, 300_000, DEATH)] }));
  assert.equal(forfeit(359_999), null, "a death in the forfeit's last minute");
  // B went blind at 290 s, so that is where the death is.
  assert.equal(forfeit(360_000)?.text, "A DEATH ON BLIND TRAVEL");

  // Every fixture's moment, whatever its kind, sits inside the window.
  for (const m of fixtures) {
    const t = chooseTeaser(m);
    if (t)
      assert.ok(t.momentMs >= 60_000 && t.momentMs <= decidedAtMs(m)! - 60_000, `${m.id}: ${t.momentMs}`);
  }
}
console.log("OK: P7 — never in the first minute or the last, for deaths, lead changes and close splits");

// --- P8: names nobody ----------------------------------------------------------------------------
{
  const cases: Array<[string, MatchInfo]> = [
    ...fixtures.map((m): [string, MatchInfo] => [String(m.id), m]),
    ["flip", race({ bAt: (i, t) => (i < 2 ? t + 10_000 : t - 5_000) })],
    ["close", race({ bAt: (i, t) => t + (i === 4 ? 700 : 10_000) })],
    ["death", race({ bAt: wireToWire, extra: [ev(A, 250_000, DEATH)] })],
  ];
  let some = 0;
  for (const [id, m] of cases) {
    const t = chooseTeaser(m);
    // Whoever sits left, and whoever won: the same moment, so the line cannot point at anyone.
    assert.deepEqual(chooseTeaser(swapSeats(m)), t, `${id}: depends on the seats`);
    for (const winner of m.players)
      assert.deepEqual(
        chooseTeaser({ ...m, result: { ...m.result, uuid: winner.uuid } }),
        t,
        `${id}: reads the result`,
      );
    if (!t) continue;
    some++;
    for (const p of m.players) assert.ok(!t.text.includes(p.nickname.toUpperCase()), `${id}: names a player`);
    // Nothing about how it ends either: the dragon is the finish, not a moment in the race.
    assert.doesNotMatch(
      t.text,
      /\b(WINS?|WON|WINNER|LOSES?|LOST|BEATS?|DRAGON|FINISH)\b/,
      `${id}: ${t.text}`,
    );
  }
  assert.ok(some >= 8, `enough cases carried a moment (${some})`);
}
console.log("OK: P8 — the same moment with seats and result swapped, no name in the line");

// --- P9: `death` only ----------------------------------------------------------------------------
{
  // A death_spawnpoint is the routine bed warp (a hunger reset) everywhere but the End, where it
  // is a real death to deathKind — the teaser promises neither. B's in the Nether at 130 s, both
  // in the End at 420 s, all well inside the window, on a race led wire to wire: nothing.
  const spawns = [ev(B, 130_000, SPAWN), ev(A, 420_000, SPAWN), ev(B, 425_000, SPAWN)];
  assert.equal(chooseTeaser(race({ bAt: wireToWire, extra: spawns })), null, "a bed warp is not a death");
  // And with a real death beside them, the line is about the real one.
  assert.deepEqual(chooseTeaser(race({ bAt: wireToWire, extra: [...spawns, ev(A, 190_000, DEATH)] })), {
    momentMs: 190_000,
    text: "A DEATH AT THE BASTION",
  });
  // A death by someone not in either seat (a private room's host) is nobody's death to promise.
  assert.equal(
    chooseTeaser(race({ bAt: wireToWire, extra: [ev({ uuid: "c".repeat(32) }, 200_000, DEATH)] })),
    null,
  );

  // Every real match with its unplanned deaths taken out: whatever bed warps it has, no line
  // promises a death, and nothing ever says reset.
  for (const m of fixtures) {
    const noDeaths = { ...m, timelines: m.timelines.filter((e) => e.type !== DEATH) };
    const t = chooseTeaser(noDeaths);
    assert.ok(!t?.text.includes("DEATH"), `${m.id}: "${t?.text}" from bed warps alone`);
    assert.doesNotMatch(chooseTeaser(m)?.text ?? "", /RESET|HUNGER|RESPAWN/, `${m.id}`);
  }
}
console.log("OK: P9 — only `death` is a death; bed warps, End bed-spawns and the host's are not");

console.log("teaser.contract: all checks passed");
