import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  distinctShortMoments,
  leadChangeTimes,
  pickShortMoment,
  rankShortMoments,
  SHORT_WINDOW_SEC,
} from "./shortMoment.js";
import type { MatchInfo } from "./types.js";

const load = (id: number): MatchInfo => {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/match-${id}.json`, import.meta.url), "utf8"));
  return (raw.data ?? raw) as MatchInfo;
};

const optsFor = (m: MatchInfo) => ({
  leftUuid: m.players[0]!.uuid,
  rightUuid: m.players[1]!.uuid,
  runMs: m.result.time || 900_000,
});

// --- 12730175: edcr vs doogile. Its ending is not dull — the dragon dies and both players get
// there seconds apart — so the window that runs to the finish wins, which is what lets the Short
// stamp its result card and stop on it (all three 30k+ reference Shorts do).
//
// The mid-run story is still found, not lost: the 9:08 stretch, where the lead flips and they die
// 0.4s apart, is the best window that stops short of the end, and `--pick=1` is how the operator
// takes it. Asserted on the shape of the window, not the clock.
{
  const match = load(12730175);
  const opts = optsFor(match);
  const best = pickShortMoment(match, opts)!;
  assert.ok(best, "a match with events must yield a moment");
  assert.ok(
    best.endMs >= opts.runMs,
    `expected the window that reaches the finish, got ${best.startMs / 1000}-${best.endMs / 1000}s`,
  );
  assert.match(best.reason, /ends on the finish/);

  const midRun = rankShortMoments(match, opts).find((m) => m.endMs < opts.runMs)!;
  assert.ok(
    midRun.startMs >= 540_000 && midRun.endMs <= 575_000,
    `expected the double-death window around 9:08, got ${midRun.startMs / 1000}-${midRun.endMs / 1000}s`,
  );
  assert.match(midRun.reason, /lead change/);
  assert.match(midRun.reason, /death/);
}

// --- A forfeit or a draw ends with nothing in `timelines` at all, so before the synthetic
// terminal event the finish of one was unreachable — and the best-performing Short in the whole
// reference set (42k views) is a draw. The run's end is now scoreable on its own.
{
  const match = load(12902901);
  const drawn: MatchInfo = {
    ...match,
    result: { ...match.result, time: 0 },
    timelines: [{ uuid: match.players[0]!.uuid, time: 120_000, type: "projectelo.timeline.blind_travel" }],
  };
  const opts = optsFor(drawn);
  const best = pickShortMoment(drawn, opts)!;
  assert.ok(best, "a match that ends without a dragon must still yield a moment");
  assert.equal(best.endMs, opts.runMs, "the window must run to the end of the match");
  assert.match(best.reason, /ends on the finish/);
}

// --- Where the payoff lands. The window is sized around completion rate: the reference Short
// (@MCSR-Vault, 42k views) is 21.3s with its payoff at t=9s and no outro, so the target leaves
// ~9s of reaction after the biggest event rather than the ~4s a 0.9 position would.
//
// One event, every window containing it, so the only thing being scored is position: the winner
// must be the window that opens 13s before it — 59% through a 22s window, 9s of tail.
{
  const match = load(12902901);
  const solo: MatchInfo = {
    ...match,
    timelines: [{ uuid: match.players[0]!.uuid, time: 200_000, type: "projectelo.timeline.dragon_death" }],
  };
  const best = pickShortMoment(solo, optsFor(match))!;
  const position = (200_000 - best.startMs) / (best.endMs - best.startMs);
  assert.ok(
    position >= 0.55 && position <= 0.6,
    `payoff should land 55-60% through the window, landed at ${(position * 100).toFixed(0)}%`,
  );
  assert.equal(best.endMs - 200_000, 9_000, "the reference Short's ~9s of reaction must survive");
  // And the finish bonus does not swallow it: this run ends long after the only thing worth
  // watching, so a window over its bare ending must still lose to the moment itself.
  assert.doesNotMatch(best.reason, /ends on the finish/);
}

// --- Every window is exactly the configured length and lies inside the run.
{
  const match = load(12902901);
  const opts = optsFor(match);
  for (const m of rankShortMoments(match, opts)) {
    assert.equal(m.endMs - m.startMs, SHORT_WINDOW_SEC * 1000);
    assert.ok(m.startMs >= 0, `window starts before the match: ${m.startMs}`);
    assert.ok(m.events.length > 0, "a scored window must contain at least one scored event");
    for (const e of m.events) {
      assert.ok(e.time >= m.startMs && e.time < m.endMs, "an event was counted outside its window");
    }
  }
}

// --- Distinct moments must not overlap. With a 1s stride the raw ranking is the same window
// shifted by a second, over and over; offering that as "three options" offers one.
{
  const match = load(12902901);
  const picks = distinctShortMoments(match, optsFor(match), 3);
  assert.equal(picks.length, 3);
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const a = picks[i]!;
      const b = picks[j]!;
      assert.ok(a.endMs <= b.startMs || b.endMs <= a.startMs, `moments ${i} and ${j} overlap`);
    }
  }
  assert.ok(picks[0]!.score >= picks[1]!.score, "still ordered best first");
}

// --- Lead changes are located, not just counted. matchScore reports how many there were; a
// Short needs to know when, because that is the frame the window should be built around.
{
  const match = load(12929221);
  const flips = leadChangeTimes(match, match.players[0]!.uuid, match.players[1]!.uuid);
  assert.ok(flips.length >= 1, "this match's whole story is a lead change; it must be found");
  assert.ok(
    flips.every((t) => t > 0 && t <= match.result.time + 60_000),
    `a lead change landed outside the match: ${flips}`,
  );
  assert.deepEqual(
    [...flips].sort((a, b) => a - b),
    flips,
    "lead changes must be in time order",
  );
}

// --- A match whose timeline holds nothing worth watching yields nothing, rather than a
// confident window over `mine_stone`.
{
  const match = load(12902901);
  const empty: MatchInfo = { ...match, timelines: [] };
  assert.equal(pickShortMoment(empty, optsFor(match)), null);
  const noise: MatchInfo = {
    ...match,
    timelines: [
      { uuid: match.players[0]!.uuid, time: 10_000, type: "adventure.mine_stone" },
      { uuid: match.players[0]!.uuid, time: 20_000, type: "story.smelt_iron" },
    ],
  };
  assert.equal(pickShortMoment(noise, optsFor(match)), null, "unwatchable events must score nothing");
}

console.log("shortMoment: all checks passed");

// --- Chat as the crowd's own record of the moment ---------------------------------------------
// Two identical events far apart score alike on the timeline. A burst of chat after one of them
// is what the crowd reacted to, and it decides the tie — without ever outranking the event
// itself, and without changing anything for a match that has no saved chat.
{
  const { chatBurst } = await import("./shortMoment.js");
  const match = load(12902901);
  const uuid = match.players[0]!.uuid;
  const twin: MatchInfo = {
    ...match,
    timelines: [
      { uuid, time: 100_000, type: "projectelo.timeline.dragon_death" },
      { uuid, time: 300_000, type: "projectelo.timeline.dragon_death" },
    ],
  };
  const opts = { ...optsFor(match), runMs: 500_000 };
  const quiet = pickShortMoment(twin, opts)!;
  const withoutChat = pickShortMoment(twin, { ...opts, chatAtSec: [] })!;
  assert.equal(withoutChat.score, quiet.score, "an empty chat changes nothing");

  // Twelve messages in the ten seconds after the second event, one a minute otherwise.
  const chat = [
    ...Array.from({ length: 8 }, (_, i) => i * 60 + 30),
    ...Array.from({ length: 12 }, (_, i) => 302 + i),
  ];
  const loud = pickShortMoment(twin, { ...opts, chatAtSec: chat })!;
  assert.ok(
    loud.startMs < 300_000 && loud.endMs > 300_000,
    `the window should hold the event chat reacted to, got ${loud.startMs}-${loud.endMs}`,
  );
  assert.match(loud.reason, /chat burst/);
  assert.ok(loud.score > quiet.score, "the burst adds, it does not replace");

  // The burst is relative to the match's own average, and needs a crowd: one message a minute
  // is a single viewer typing, and a window that happens to hold one of them is no burst.
  assert.equal(chatBurst([10, 70, 130, 190, 250], 0, 22_000, 500_000), 0, "steady chat is no burst");
  assert.equal(chatBurst([], 0, 22_000, 500_000), 0);
  assert.ok(
    chatBurst(chat, 290_000, 312_000, 500_000) >= 0.9,
    "twelve messages in ten seconds against one a minute is a full burst",
  );
  console.log("OK: chat bursts break ties toward the moment the crowd reacted to");
}
