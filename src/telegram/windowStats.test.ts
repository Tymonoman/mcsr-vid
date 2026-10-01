// Self-check for windowStats.ts's window aggregation, from a synthetic day series.
// Run: npx tsx src/telegram/windowStats.test.ts
import assert from "node:assert/strict";
import {
  aggregateWindow,
  aggregateWindows,
  latestDate,
  netSubscribers,
  subsPer1kEngaged,
  WINDOW_DAYS,
  type DayRow,
} from "./windowStats.js";

// 40 days, 2026-01-01 .. 2026-02-09, views = day index (1..40) so every window's sum is easy to
// hand-check, and shuffled so the function's own sort is exercised too.
const rows: DayRow[] = [];
for (let i = 1; i <= 40; i++) {
  const d = new Date(Date.UTC(2026, 0, i));
  rows.push({ date: d.toISOString().slice(0, 10), views: i, likes: i * 2 });
}
const shuffled = [...rows].sort(() => Math.random() - 0.5);

// Day 40 is the latest one whatever the order fed in.
assert.equal(latestDate(shuffled), "2026-02-09");
assert.equal(latestDate([]), null);

// The last 1 day (day 40) vs the day before it (day 39).
{
  const w = aggregateWindow(shuffled, 1, ["views", "likes"]);
  assert.equal(w.current.views, 40);
  assert.equal(w.previous.views, 39);
  assert.equal(w.current.likes, 80);
  assert.equal(w.currentDays, 1);
  assert.equal(w.previousDays, 1);
}

// The last 7 days (34..40, sum 259) vs the 7 before that (27..33, sum 210).
{
  const w = aggregateWindow(shuffled, 7, ["views"]);
  assert.equal(
    w.current.views,
    [34, 35, 36, 37, 38, 39, 40].reduce((a, b) => a + b, 0),
  );
  assert.equal(
    w.previous.views,
    [27, 28, 29, 30, 31, 32, 33].reduce((a, b) => a + b, 0),
  );
  assert.equal(w.currentDays, 7);
  assert.equal(w.previousDays, 7);
}

// The 30-day window only has 40 rows total: current (11..40, 30 rows) vs previous, which only
// has 10 rows before that (1..10) — short of a full 30, and the count says so.
{
  const w = aggregateWindow(shuffled, 30, ["views"]);
  assert.equal(w.currentDays, 30);
  assert.equal(w.previousDays, 10);
  assert.equal(
    w.previous.views,
    Array.from({ length: 10 }, (_, i) => i + 1).reduce((a, b) => a + b, 0),
  );
}

// An empty previous window (only "current"-many rows exist at all) sums to zero, not a throw.
{
  const w = aggregateWindow(rows.slice(0, 3), 7, ["views"]);
  assert.equal(w.currentDays, 3);
  assert.equal(w.previousDays, 0);
  assert.deepEqual(w.previous, { views: 0 });
}

// aggregateWindows runs all four at once, keyed by day count, matching the individual calls.
{
  const all = aggregateWindows(shuffled, ["views"]);
  assert.deepEqual(
    Object.keys(all)
      .map(Number)
      .sort((a, b) => a - b),
    [...WINDOW_DAYS],
  );
  for (const d of WINDOW_DAYS) assert.deepEqual(all[d], aggregateWindow(shuffled, d, ["views"]));
}

// Net subscribers (gained minus lost) and subscribers gained per 1,000 engaged views, per window:
// 14 days: the last 7 gained 10, lost 2 and drew 4,000 engaged views a day, the 7 before 5, 1 and 5,000.
{
  const days: DayRow[] = [];
  for (let i = 1; i <= 14; i++) {
    const last7 = i > 7;
    days.push({
      date: new Date(Date.UTC(2026, 8, i)).toISOString().slice(0, 10),
      subscribersGained: last7 ? 10 : 5,
      subscribersLost: last7 ? 2 : 1,
      engagedViews: last7 ? 4000 : 5000,
    });
  }
  const w = aggregateWindow(days, 7, ["subscribersGained", "subscribersLost", "engagedViews"]);
  assert.equal(netSubscribers(w.current), 56, "7 x (10 - 2)");
  assert.equal(netSubscribers(w.previous), 28, "7 x (5 - 1)");
  assert.equal(subsPer1kEngaged(w.current), 2.5, "70 gained over 28,000 engaged views");
  assert.equal(subsPer1kEngaged(w.previous), 1, "35 gained over 35,000 engaged views");
  // A net loss is negative, not clamped; a window with no engaged views has no rate at all.
  assert.equal(netSubscribers({ subscribersGained: 1, subscribersLost: 4 }), -3);
  assert.equal(subsPer1kEngaged({ subscribersGained: 3, engagedViews: 0 }), null);
  assert.equal(subsPer1kEngaged({}), null);
  assert.equal(subsPer1kEngaged({ engagedViews: 2000 }), 0, "views but no subscribers is a rate of zero");
  assert.equal(netSubscribers({}), 0);
}

console.log("windowStats: all checks passed");
