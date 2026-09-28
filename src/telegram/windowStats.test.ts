// Self-check for windowStats.ts's window aggregation, from a synthetic day series.
// Run: npx tsx src/telegram/windowStats.test.ts
import assert from "node:assert/strict";
import { aggregateWindow, aggregateWindows, latestDate, WINDOW_DAYS, type DayRow } from "./windowStats.js";

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

console.log("windowStats: all checks passed");
