import assert from "node:assert/strict";
import { projectYpp, YPP } from "./yppProgress.js";

const now = Date.UTC(2026, 8, 8);
const base = {
  fetchedAt: new Date(now).toISOString(),
  subscribers: 75,
  subscribersPer7d: 34,
  watchHours365d: 1120,
  watchHoursPer28d: 52,
  shortsViews90d: 0,
  shortsViewsPer28d: 0,
};
const p = projectYpp(base, now);
assert.equal(p.subscribers.need, YPP.subscribers);
assert.equal(p.subscribers.have, 75);
// 425 to go at 34 a week is ~87.5 days.
assert.equal(
  p.subscribers.eta!.slice(0, 10),
  new Date(now + Math.round((425 / (34 / 7)) * 86_400_000)).toISOString().slice(0, 10),
);
// Hours are a rolling year: 52 h per 28 days levels off near 678 h, so the gate is out of reach
// at this rate and the honest answer is the daily rate that would get there, not a date.
assert.equal(p.watchHours.eta, null, "a ceiling under the gate is no ETA");
assert.ok(Math.abs(p.watchHours.ceiling! - (52 / 28) * 365) < 0.01);
assert.ok(Math.abs(p.watchHours.needPerDay! - 4000 / 365) < 0.01);
// Fast enough, and the rolling window is no obstacle: a date comes back.
const fast = projectYpp({ ...base, watchHours365d: 3000, watchHoursPer28d: 28 * 15 }, now).watchHours;
assert.ok(fast.ceiling! > 4000 && fast.eta !== null, "15 h/day clears the ceiling and lands on a date");
assert.equal(
  fast.eta!.slice(0, 10),
  new Date(now + Math.round((1000 / 15) * 86_400_000)).toISOString().slice(0, 10),
);
assert.equal(p.shortsViews.eta, null, "no Shorts views yet means no ETA, not a division by zero");
assert.equal(p.shortsViews.ratePerDay, 0);
assert.equal(p.shortsViews.ceiling, 0);
// A gate already met lands today.
assert.equal(projectYpp({ ...base, subscribers: 600 }, now).subscribers.eta!.slice(0, 10), "2026-09-08");
console.log("yppProgress: all checks passed");
