// Self-check for shortReason.ts: what the reasoner is shown must never include the result, and
// what it answers must never move the cut outside the candidates or the run.
// Run: npx tsx src/shortReason.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { distinctShortMoments } from "./shortMoment.js";
import { applyShortReason, REASON_FILE, reasonShortMoments, shortReasonInput } from "./shortReason.js";
import type { MatchInfo } from "./types.js";

const raw = JSON.parse(readFileSync(new URL("./fixtures/match-12730175.json", import.meta.url), "utf8"));
const match = (raw.data ?? raw) as MatchInfo;
const opts = {
  leftUuid: match.players[0]!.uuid,
  rightUuid: match.players[1]!.uuid,
  runMs: match.result.time,
  chatAtSec: [545, 546, 546, 560],
};
const moments = distinctShortMoments(match, opts, 5);
assert.ok(moments.length >= 2, "the fixture must offer alternatives");

// --- The winner is not in the input, in any form: no result object, no uuid of the winner.
{
  const text = JSON.stringify(shortReasonInput(match, moments, opts));
  assert.ok(!text.includes('"result"'), "match.result must not be sent");
  assert.ok(!text.includes(match.result.uuid!), "the winner's uuid must not be sent");
  assert.ok(!/"winner"|"loser"|"forfeit/.test(text));
  const input = shortReasonInput(match, moments, opts);
  assert.equal(input.candidates.length, moments.length);
  assert.equal(input.candidates[0]!.chatPer2s!.length, 11, "22 s in 2 s buckets");
  assert.equal(
    input.candidates[0]!.chatPer2s!.reduce((a, b) => a + b, 0),
    opts.chatAtSec.filter((t) => t * 1000 >= moments[0]!.startMs && t * 1000 < moments[0]!.endMs).length,
  );
  // Every event names its player, except the synthetic end-of-run marker, which names nobody —
  // naming whose finish it was would tell the model who won.
  assert.ok(
    input.candidates[0]!.events.every((e) => typeof e.player === "string" || e.player === null),
    "an event's player is a nickname or null, never undefined",
  );
}

// --- A valid answer puts the pick first, shifted; the rest keep their order.
{
  const r = applyShortReason(moments, { pick: 1, shiftSec: -2, why: " opens on the flip " }, opts.runMs);
  assert.equal(r.reasoner.applied, true);
  assert.equal(r.reasoner.why, "opens on the flip");
  assert.equal(r.moments[0]!.startMs, moments[1]!.startMs - 2000);
  assert.equal(r.moments[0]!.endMs, moments[1]!.endMs - 2000);
  // The payoff sits 2 s later into a window that starts 2 s earlier.
  const offset = (m: { reason: string }) => Number(/at \+(\d+)s/.exec(m.reason)![1]);
  assert.equal(offset(r.moments[0]!), offset(moments[1]!) + 2);
  assert.deepEqual(
    r.moments.slice(1).map((m) => m.startMs),
    moments.filter((m) => m !== moments[1]).map((m) => m.startMs),
  );
  assert.ok(
    r.moments[0]!.events.every((e) => e.time >= r.moments[0]!.startMs && e.time < r.moments[0]!.endMs),
  );
}

// --- Anything out of contract leaves the heuristic order untouched.
const untouched = (answer: unknown, label: string) => {
  const r = applyShortReason(moments, answer, opts.runMs);
  assert.equal(r.reasoner.applied, false, label);
  assert.deepEqual(r.moments, moments, label);
};
untouched(null, "null");
untouched("pick 1", "a string");
untouched({ pick: 99, shiftSec: 0 }, "pick out of range");
untouched({ pick: 1.5, shiftSec: 0 }, "fractional pick");
untouched({ pick: 0, shiftSec: 5 }, "shift past the cap");
untouched({ pick: 0, shiftSec: -4.5 }, "shift past the cap, negative");
{
  const first = moments.findIndex((m) => m.startMs < 4000);
  if (first >= 0) untouched({ pick: first, shiftSec: -4 }, "window before the run");
  const last = moments.findIndex((m) => m.endMs > opts.runMs - 4000);
  if (last >= 0) untouched({ pick: last, shiftSec: 4 }, "window past the run");
}
// A missing shift is no shift, not a rejection.
assert.equal(applyShortReason(moments, { pick: 1 }, opts.runMs).moments[0]!.startMs, moments[1]!.startMs);

// --- The exchange: a null answer (not configured, crashed, timed out) is the heuristic; one
// candidate is never worth a question; no match directory (no VODs) is never worth one either.
const dir = mkdtempSync(path.join(tmpdir(), "short-reason-"));
try {
  const r = await reasonShortMoments(match, moments, opts, dir, async () => null);
  assert.equal(r.reasoner.applied, false);
  assert.deepEqual(r.moments, moments);
  assert.match(r.reasoner.why!, /delete short-reason\.json/);
  let asked = 0;
  const count = (answer: unknown) => async () => (asked++, answer);
  await reasonShortMoments(match, moments.slice(0, 1), opts, dir, count({ pick: 0 }));
  await reasonShortMoments(match, moments, opts, path.join(dir, "missing"), count({ pick: 1 }));
  assert.equal(asked, 0);

  // Asked once per match: the answer is saved — a null too — and re-read while the candidates
  // are the same, so the panel's row index and the CLI's --pick name the same window.
  assert.deepEqual(
    (await reasonShortMoments(match, moments, opts, dir, count({ pick: 1 }))).moments,
    moments,
  );
  assert.equal(asked, 0, "a recorded null is not re-asked");
  rmSync(path.join(dir, REASON_FILE));
  const first = await reasonShortMoments(match, moments, opts, dir, count({ pick: 1, shiftSec: 1 }));
  assert.equal(asked, 1);
  assert.equal(first.moments[0]!.startMs, moments[1]!.startMs + 1000);
  assert.ok(existsSync(path.join(dir, REASON_FILE)));
  const again = await reasonShortMoments(match, moments, opts, dir, count({ pick: 2 }));
  assert.equal(asked, 1, "the saved answer is used");
  assert.deepEqual(again.moments, first.moments);
  // Different candidates (chat arrived, another window length): the saved answer is not for them.
  await reasonShortMoments(match, moments.slice(0, 2), opts, dir, count({ pick: 0 }));
  assert.equal(asked, 2);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("shortReason: all checks passed");
