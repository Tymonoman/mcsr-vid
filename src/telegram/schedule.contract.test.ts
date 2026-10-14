// Contract test for schedule.ts, written from the docs (CLAUDE.md "Telegram bot", handbook
// claude-md-reference.md "Telegram bot"), not from the code. schedule.test.ts already pins 2026's
// two transition days and the catch-up rule in January (CET); this file covers what it does not:
// a whole year walked against an independent EU-DST oracle, CEST-season and transition-day catch-up
// boundaries that a fixed UTC offset would get wrong, a non-default report hour, and the re-arm delay.
//
// Promises (numbering shared with index.contract.test.ts):
//  P8. A restart that missed the report hour still sends the report if it is between the report hour
//      and 10:00 Warsaw and today's (Warsaw) date is not recorded; before the report hour nothing is
//      sent early; with the report off (null) nothing catches up.
//  P9. One report at `telegramReportHourWarsaw`, Europe/Warsaw wall-clock, DST-correct — never a
//      fixed UTC offset.
// Run: npx tsx src/telegram/schedule.contract.test.ts
import assert from "node:assert/strict";
import {
  msUntilNextWarsawRun,
  nextWarsawRun,
  shouldCatchUp,
  warsawDateStr,
  warsawParts,
  warsawUtcForHour,
} from "./schedule.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

/** The EU rule, computed independently of Intl: summer time runs from 01:00 UTC on the last Sunday
 *  of March to 01:00 UTC on the last Sunday of October. Poland follows it (UTC+1 / UTC+2). */
const lastSundayUtc = (y: number, month0: number): number => {
  const lastDay = new Date(Date.UTC(y, month0 + 1, 0));
  return Date.UTC(y, month0, lastDay.getUTCDate() - lastDay.getUTCDay(), 1, 0, 0);
};
const warsawOffsetH = (utcMs: number): number => {
  const y = new Date(utcMs).getUTCFullYear();
  return utcMs >= lastSundayUtc(y, 2) && utcMs < lastSundayUtc(y, 9) ? 2 : 1;
};
/** What 07:00 (or `h`:00) Warsaw on a calendar date is in UTC, by the oracle. Both transitions happen
 *  at 01:00 UTC, hours before any morning report hour, so the day's offset is the one at 12:00 UTC. */
const oracleRun = (y: number, mo: number, d: number, h: number): number =>
  Date.UTC(y, mo - 1, d, h) - warsawOffsetH(Date.UTC(y, mo - 1, d, 12)) * HOUR;

/* --- P9: a whole year, every day, at the documented hour and at a non-default one ----------------- */
for (const year of [2026, 2027]) {
  for (const hour of [7, 9]) {
    let t = Date.UTC(year, 0, 1, 0, 0, 0) - 2 * HOUR; // 31 Dec 23:00 Warsaw: the year's first run is 1 Jan
    let prev: number | null = null;
    const gaps = new Map<number, number>();
    for (let i = 0; i < 365; i++) {
      const next = nextWarsawRun(t, hour);
      const p = warsawParts(next);
      // The report reads the operator's wall clock: exactly hour:00 Warsaw every day of the year.
      assert.equal(p.h, hour, `${iso(next)} is ${p.h}:${p.mi} Warsaw, not ${hour}:00`);
      assert.equal(p.mi, 0, iso(next));
      // ...and on the instant the EU rule says, not on one fixed offset all year.
      assert.equal(
        next,
        oracleRun(p.y, p.mo, p.d, hour),
        `${year}-${p.mo}-${p.d} ${hour}:00 -> ${iso(next)}`,
      );
      assert.equal(warsawUtcForHour(p.y, p.mo, p.d, hour), next);
      // One run per Warsaw date, no day skipped or doubled.
      if (prev !== null) {
        assert.notEqual(warsawDateStr(next), warsawDateStr(prev), "two runs on one Warsaw date");
        const gapH = (next - prev) / HOUR;
        gaps.set(gapH, (gaps.get(gapH) ?? 0) + 1);
      }
      // The re-arm delay is exactly the distance to that instant (the timer index.ts sets).
      assert.equal(msUntilNextWarsawRun(t, hour), next - t);
      prev = next;
      t = next; // "exactly on the hour counts as already happened" — the end-of-run reschedule
    }
    // Over a year the day is 24 h long except once 23 h (spring forward) and once 25 h (fall back).
    assert.deepEqual(
      [...gaps.entries()].sort((a, b) => a[0] - b[0]),
      [
        [23, 1],
        [24, 362],
        [25, 1],
      ],
      `${year} @${hour}: ${JSON.stringify([...gaps])}`,
    );
  }
}
console.log(
  "OK: every day of 2026 and 2027 runs at hour:00 Warsaw on the EU-rule instant, 23/25 h once each",
);

/* --- P9: the re-arm across the fall-back night is 25 h, not 24 -------------------------------------- */
{
  // 24 Oct 2026 07:00:01 CEST: the next run is 07:00 CET on the 25th, an hour later in UTC terms.
  const justAfter = Date.UTC(2026, 9, 24, 5, 0, 1);
  assert.equal(msUntilNextWarsawRun(justAfter, 7), 25 * HOUR - 1000);
  // 28 Mar 2027 is spring forward: from 07:00:01 CET on the 27th the next run is 23 h away.
  const springEve = Date.UTC(2027, 2, 27, 6, 0, 1);
  assert.equal(msUntilNextWarsawRun(springEve, 7), 23 * HOUR - 1000);
  console.log("OK: the re-arm delay stretches to 25 h on the fall-back night and shrinks to 23 h in spring");
}

/* --- P8: catch-up in summer time, where a fixed CET offset would be an hour off --------------------- */
{
  // Wed 14 Oct 2026 is CEST (UTC+2). Each case below gets the opposite answer under UTC+1.
  const oct14 = (hUtc: number, mUtc = 0) => Date.UTC(2026, 9, 14, hUtc, mUtc);
  assert.equal(shouldCatchUp(oct14(5, 30), null, 7), true, "07:30 CEST, never sent — catch up");
  assert.equal(shouldCatchUp(oct14(4, 59), null, 7), false, "06:59 CEST — the 07:00 timer still sends it");
  assert.equal(shouldCatchUp(oct14(7, 59), null, 7), true, "09:59 CEST — still before 10:00 Warsaw");
  assert.equal(shouldCatchUp(oct14(8, 0), null, 7), false, "10:00 CEST — too late, wait for tomorrow");
  // The dedupe date is the Warsaw date: already sent "2026-10-14" means not again that morning.
  assert.equal(shouldCatchUp(oct14(6), "2026-10-14", 7), false, "already sent today");
  assert.equal(shouldCatchUp(oct14(6), "2026-10-13", 7), true, "sent yesterday, not yet today");
  // The report off (`telegramReportHourWarsaw: null`) never catches up, whatever the hour.
  for (let h = 0; h < 24; h++) assert.equal(shouldCatchUp(oct14(h), null, null), false, `report off @${h}Z`);
  console.log(
    "OK: catch-up reads CEST in October, dedupes on the Warsaw date, and stays off when the report is",
  );
}

/* --- P8: the two transition mornings ------------------------------------------------------------- */
{
  // Sun 25 Oct 2026: CET from 01:00 UTC, so 07:00 Warsaw is 06:00 UTC that morning.
  const oct25 = (hUtc: number, mUtc = 0) => Date.UTC(2026, 9, 25, hUtc, mUtc);
  assert.equal(shouldCatchUp(oct25(5, 30), null, 7), false, "06:30 CET on fall-back day — not yet");
  assert.equal(shouldCatchUp(oct25(6, 0), null, 7), true, "07:00 CET on fall-back day — catch up");
  assert.equal(shouldCatchUp(oct25(8, 59), null, 7), true, "09:59 CET — still in the window");
  assert.equal(shouldCatchUp(oct25(9, 0), null, 7), false, "10:00 CET — closed");
  // Sun 28 Mar 2027: CEST from 01:00 UTC, so 07:00 Warsaw is 05:00 UTC.
  const mar28 = (hUtc: number, mUtc = 0) => Date.UTC(2027, 2, 28, hUtc, mUtc);
  assert.equal(shouldCatchUp(mar28(4, 30), null, 7), false, "06:30 CEST on spring-forward day — not yet");
  assert.equal(shouldCatchUp(mar28(5, 0), null, 7), true, "07:00 CEST on spring-forward day — catch up");
  assert.equal(shouldCatchUp(mar28(8, 0), null, 7), false, "10:00 CEST — closed");
  console.log("OK: catch-up is right on both transition mornings");
}

/* --- P8: a non-default report hour moves the window's start, never its 10:00 end ------------------- */
{
  const oct14 = (hUtc: number, mUtc = 0) => Date.UTC(2026, 9, 14, hUtc, mUtc);
  assert.equal(
    shouldCatchUp(oct14(5, 30), null, 8),
    false,
    "07:30 with the report at 08:00 — nothing missed",
  );
  assert.equal(shouldCatchUp(oct14(6, 30), null, 8), true, "08:30 with the report at 08:00 — catch up");
  assert.equal(shouldCatchUp(oct14(7, 59), null, 9), true, "09:59 with the report at 09:00 — catch up");
  assert.equal(shouldCatchUp(oct14(8, 0), null, 9), false, "10:00 with the report at 09:00 — closed");
  console.log("OK: the window opens at the configured hour and closes at 10:00 Warsaw");
}

/* --- The Warsaw date the dedupe records, around Warsaw midnight in both seasons -------------------- */
assert.equal(warsawDateStr(Date.UTC(2026, 9, 14, 21, 59)), "2026-10-14", "23:59 CEST is still the 14th");
assert.equal(
  warsawDateStr(Date.UTC(2026, 9, 14, 22, 0)),
  "2026-10-15",
  "00:00 CEST is the 15th, while UTC says 14th",
);
assert.equal(warsawDateStr(Date.UTC(2026, 11, 31, 23, 0)), "2027-01-01", "00:00 CET on New Year");
assert.equal(DAY, 86_400_000);

console.log("schedule.contract: all checks passed");
