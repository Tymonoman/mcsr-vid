// Self-check for banners.ts: nothing while the switches are off, gap chips at each second arrival
// and never in the last minute before the dragon, banners one at a time, nobody named.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { MatchInfo } from "../api/types.js";
import { DEFAULTS } from "../config.js";
import { GAP_CHIP_BEFORE_DECIDED_MS, bannersFor, gapChips } from "./banners.js";
import { decidedAtMs } from "../shorts/raceGap.js";

const load = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
const ALL_ON = {
  ...DEFAULTS,
  stakesLine: true,
  explainMovesStyle: "banner" as const,
  explainMovesSec: 6,
  teaserAtSec: 2,
  gapChips: true,
};

for (const id of [12730175, 12898432, 12902901, 12929221, 13446429, 13448958, 13549300, 13617328]) {
  const m = load(id);
  assert.deepEqual(bannersFor(m, DEFAULTS), [], `${id}: the defaults draw nothing`);

  const all = bannersFor(m, ALL_ON);
  const decided = decidedAtMs(m)!;
  // Never a runner's name, and never told the result: the same banners with the result flipped.
  const names = m.players.map((p) => p.nickname.toUpperCase());
  for (const b of all)
    for (const n of names)
      assert.ok(!`${b.head} ${b.text}`.toUpperCase().includes(n), `${id}: ${b.text} names ${n}`);
  const loser = m.players.find((p) => p.uuid !== m.result.uuid)!.uuid;
  assert.deepEqual(
    bannersFor({ ...m, result: { ...m.result, uuid: loser } }, ALL_ON),
    all,
    `${id}: reads the winner`,
  );

  // The stakes line from the first frame to match start, and nothing else before it.
  assert.equal(all[0]!.kind, "stakes");
  assert.equal(all[0]!.toMs, 0);
  assert.ok(all.slice(1).every((b) => b.fromMs >= 0));

  // Explain banners one at a time, and off the finish.
  const explain = all.filter((b) => b.kind === "explain");
  for (let i = 1; i < explain.length; i++)
    assert.ok(explain[i]!.fromMs >= explain[i - 1]!.toMs, `${id}: overlap`);
  assert.ok(explain.every((b) => b.toMs <= m.result.time));

  // A chip per split both reached, at the second arrival, gone a minute before the dragon.
  for (const chip of gapChips(m)) {
    assert.match(chip.text, /^(NETHER|BASTION|FORTRESS|BLIND|STRONGHOLD|END): \d+\.\ds APART$/);
    assert.equal(chip.toMs - chip.fromMs, 4000);
    assert.ok(chip.toMs <= decided - GAP_CHIP_BEFORE_DECIDED_MS, `${id}: ${chip.text} in the last minute`);
  }
}

// 13549300's arrivals: the chip lands on the later of the two, with the gap between them.
{
  const m = load(13549300);
  const nether = m.timelines
    .filter((e) => e.type === "story.enter_the_nether")
    .reduce<Record<string, number>>(
      (acc, e) => ({ ...acc, [e.uuid]: Math.min(acc[e.uuid] ?? Infinity, e.time) }),
      {},
    );
  const [a, b] = Object.values(nether) as [number, number];
  const chip = gapChips(m).find((c) => c.text.startsWith("NETHER"))!;
  assert.equal(chip.fromMs, Math.max(a, b));
  assert.equal(chip.text, `NETHER: ${(Math.abs(a - b) / 1000).toFixed(1)}s APART`);
}

console.log("banners: all checks passed");
