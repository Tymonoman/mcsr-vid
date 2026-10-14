// Self-check for schedule.ts across both 2026 Polish DST changes (spring forward 29 Mar, fall
// back 25 Oct) and the report-hour-to-10:00 Warsaw catch-up rule.
// Run: npx tsx src/telegram/schedule.test.ts
import assert from "node:assert/strict";
import { nextWarsawRun, shouldCatchUp, warsawDateStr, warsawUtcForHour } from "./schedule.js";

const iso = (ms: number) => new Date(ms).toISOString();

// --- Ordinary CET day (well clear of any transition): Poland is UTC+1 in January. ---
assert.equal(warsawUtcForHour(2026, 1, 15, 7), Date.UTC(2026, 0, 15, 6, 0, 0));

// --- Ordinary CEST day: Poland is UTC+2 in July. ---
assert.equal(warsawUtcForHour(2026, 7, 15, 7), Date.UTC(2026, 6, 15, 5, 0, 0));

// --- Spring forward, 29 Mar 2026: the transition is 01:00 UTC (02:00 CET -> 03:00 CEST), well
// before 07:00 local, so 07:00 Warsaw that day is already CEST (UTC+2). ---
assert.equal(warsawUtcForHour(2026, 3, 29, 7), Date.UTC(2026, 2, 29, 5, 0, 0));
// From the evening before (still CET), the next run is 07:00 CEST the next morning.
{
  const now = Date.UTC(2026, 2, 28, 20, 0, 0); // 28 Mar 21:00 CET
  const next = nextWarsawRun(now, 7);
  assert.equal(next, Date.UTC(2026, 2, 29, 5, 0, 0), iso(next));
}
// From just after 07:00 on transition day itself, the next run is the following morning, also CEST.
{
  const now = Date.UTC(2026, 2, 29, 6, 0, 0); // 29 Mar 08:00 CEST
  const next = nextWarsawRun(now, 7);
  assert.equal(next, Date.UTC(2026, 2, 30, 5, 0, 0), iso(next));
}

// --- Fall back, 25 Oct 2026: the transition is 01:00 UTC (03:00 CEST -> 02:00 CET), well before
// 07:00 local, so 07:00 Warsaw that day is already CET (UTC+1). ---
assert.equal(warsawUtcForHour(2026, 10, 25, 7), Date.UTC(2026, 9, 25, 6, 0, 0));
{
  const now = Date.UTC(2026, 9, 24, 20, 0, 0); // 24 Oct 22:00 CEST
  const next = nextWarsawRun(now, 7);
  assert.equal(next, Date.UTC(2026, 9, 25, 6, 0, 0), iso(next));
}
{
  const now = Date.UTC(2026, 9, 25, 10, 0, 0); // 25 Oct 11:00 CET
  const next = nextWarsawRun(now, 7);
  assert.equal(next, Date.UTC(2026, 9, 26, 6, 0, 0), iso(next));
}

// --- Exactly on the hour counts as "already happened" (the reschedule at the end of a run), never a zero-delay refire. ---
{
  const onTheHour = warsawUtcForHour(2026, 1, 15, 7);
  const next = nextWarsawRun(onTheHour, 7);
  assert.equal(next, warsawUtcForHour(2026, 1, 16, 7));
}

// --- warsawDateStr ---
assert.equal(warsawDateStr(Date.UTC(2026, 0, 15, 6, 0, 0)), "2026-01-15"); // 07:00 Warsaw
assert.equal(warsawDateStr(Date.UTC(2026, 0, 15, 22, 30, 0)), "2026-01-15"); // 23:30 CET, still the 15th
assert.equal(warsawDateStr(Date.UTC(2026, 0, 15, 23, 30, 0)), "2026-01-16"); // 00:30 CET, already the 16th

// --- The catch-up rule: between the report hour (7) and 10:00 Warsaw ---
const jan15 = (localHour: number, minute = 0) => Date.UTC(2026, 0, 15, localHour - 1, minute, 0); // CET = UTC+1
assert.equal(shouldCatchUp(jan15(8, 30), null, 7), true, "08:30, never sent — catch up");
assert.equal(shouldCatchUp(jan15(9, 59), null, 7), true, "09:59, never sent — still catch up");
assert.equal(shouldCatchUp(jan15(7, 0), null, 7), true, "07:00 on the dot, never sent — catch up");
assert.equal(shouldCatchUp(jan15(10, 0), null, 7), false, "10:00, never sent — too late, wait for tomorrow");
assert.equal(shouldCatchUp(jan15(11, 0), null, 7), false, "11:00, never sent — too late");
assert.equal(
  shouldCatchUp(jan15(8, 30), "2026-01-15", 7),
  false,
  "already sent today, however early it still is",
);
assert.equal(shouldCatchUp(jan15(8, 30), "2026-01-14", 7), true, "sent yesterday, not yet today — catch up");
// Before the report hour nothing was missed: the 07:00 timer still sends it, a catch-up would be a second report.
assert.equal(shouldCatchUp(jan15(5, 25), "2026-01-14", 7), false, "05:25 restart — the 07:00 timer sends it");
assert.equal(shouldCatchUp(jan15(0, 30), null, 7), false, "00:30 restart — nothing missed yet");
// The report switched off (`telegramReportHourWarsaw: null`) never catches up either.
assert.equal(shouldCatchUp(jan15(8, 30), null, null), false, "report off — no catch-up");

console.log("schedule: all checks passed");
