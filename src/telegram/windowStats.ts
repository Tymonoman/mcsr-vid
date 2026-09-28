/**
 * Turns a `dimensions: "day"` Analytics report into the /stats windows: 1, 3, 7 and 30 days,
 * each against the equal-length window immediately before it — pure arithmetic over an array of
 * per-day rows, so it can be pinned without an API (facts.ts does the one Analytics request and
 * hands the rows here).
 */

export interface DayRow {
  /** YYYY-MM-DD. */
  date: string;
  [metric: string]: number | string;
}

export const WINDOW_DAYS = [1, 3, 7, 30] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];

export interface WindowTotals {
  days: WindowDays;
  /** Summed metrics over the most recent `days` rows present. */
  current: Record<string, number>;
  /** Summed metrics over the `days` rows immediately before that. */
  previous: Record<string, number>;
  /** How many rows actually fed each side — short of `days` when Analytics has not caught up yet. */
  currentDays: number;
  previousDays: number;
}

const sumOf = (rows: readonly DayRow[], metrics: readonly string[]): Record<string, number> =>
  Object.fromEntries(metrics.map((m) => [m, rows.reduce((a, r) => a + Number(r[m] ?? 0), 0)]));

/** One window's current and previous totals. `rows` need not be sorted; this sorts by date first. */
export function aggregateWindow(rows: readonly DayRow[], days: number, metrics: readonly string[]): WindowTotals {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const currentRows = sorted.slice(Math.max(0, sorted.length - days));
  const previousRows = sorted.slice(Math.max(0, sorted.length - 2 * days), Math.max(0, sorted.length - days));
  return {
    days: days as WindowDays,
    current: sumOf(currentRows, metrics),
    previous: sumOf(previousRows, metrics),
    currentDays: currentRows.length,
    previousDays: previousRows.length,
  };
}

/** All four windows at once, keyed by their day count. */
export function aggregateWindows(
  rows: readonly DayRow[],
  metrics: readonly string[],
): Record<WindowDays, WindowTotals> {
  return Object.fromEntries(WINDOW_DAYS.map((d) => [d, aggregateWindow(rows, d, metrics)])) as Record<
    WindowDays,
    WindowTotals
  >;
}

/** The last (most recent) date in the rows, or null for an empty report — "data ends on …". */
export function latestDate(rows: readonly DayRow[]): string | null {
  return rows.reduce((latest: string | null, r) => (latest === null || r.date > latest ? r.date : latest), null);
}
