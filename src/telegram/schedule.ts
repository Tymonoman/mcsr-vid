/**
 * When the Telegram bot's daily report runs, in `Europe/Warsaw` wall-clock time — DST-correct,
 * via `Intl`, never a fixed UTC offset: CEST (UTC+2) now, CET (UTC+1) from late October.
 */

/**
 * The Warsaw wall-clock date and time (24h) at a UTC instant, from `Intl` — never a fixed offset.
 * Exported for anything that needs one piece of Warsaw wall-clock time rather than a whole
 * schedule — the NAS quiet window (`inNasWindow`, src/dashboard/archive.ts) reads `.h`.
 */
export function warsawParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
  };
}

interface WarsawDate {
  y: number;
  mo: number;
  d: number;
}

const warsawDateOf = (ms: number): WarsawDate => {
  const p = warsawParts(ms);
  return { y: p.y, mo: p.mo, d: p.d };
};

export const warsawDateStr = (ms: number): string => {
  const { y, mo, d } = warsawDateOf(ms);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

/**
 * The UTC instant of `hourLocal`:00 Warsaw time on the given Warsaw calendar date. Poland only
 * ever runs UTC+1 (CET) or UTC+2 (CEST), so trying both and keeping the one that reads back as
 * the requested date and hour resolves it without hand-coding the transition dates.
 */
export function warsawUtcForHour(y: number, mo: number, d: number, hourLocal: number): number {
  for (const offsetH of [2, 1]) {
    const candidate = Date.UTC(y, mo - 1, d, hourLocal - offsetH, 0, 0, 0);
    const p = warsawParts(candidate);
    if (p.y === y && p.mo === mo && p.d === d && p.h === hourLocal && p.mi === 0) return candidate;
  }
  throw new Error(`could not resolve ${hourLocal}:00 Warsaw for ${y}-${mo}-${d}`);
}

/**
 * The Warsaw calendar date after `(y, mo, d)`. Stepped via 11:00 UTC — always 12:00 or 13:00
 * Warsaw, nowhere near either timezone's own midnight — so adding exactly one UTC day and
 * reading the Warsaw date back is never thrown off by a DST transition landing between them.
 */
function tomorrowWarsawDate({ y, mo, d }: WarsawDate): WarsawDate {
  const noonish = Date.UTC(y, mo - 1, d, 11, 0, 0, 0);
  return warsawDateOf(noonish + 24 * 60 * 60 * 1000);
}

/**
 * The next UTC instant of `hourLocal`:00 Warsaw time strictly after `nowMs`. `hourLocal` is meant
 * for the morning report (7 by default) and is not exercised near midnight — see the ponytail
 * note on `tomorrowWarsawDate` if that ever changes: an hour within an hour or two of midnight
 * could in principle skip a day right at a DST transition, which this does not guard against.
 */
export function nextWarsawRun(nowMs: number, hourLocal: number): number {
  const today = warsawDateOf(nowMs);
  const todayCandidate = warsawUtcForHour(today.y, today.mo, today.d, hourLocal);
  if (todayCandidate > nowMs) return todayCandidate;
  const tomorrow = tomorrowWarsawDate(today);
  return warsawUtcForHour(tomorrow.y, tomorrow.mo, tomorrow.d, hourLocal);
}

/**
 * Whether a restart that missed the scheduled hour should still send today's report: the report is
 * on (`reportHourLocal` not null), not sent yet today (`lastReportWarsawDate` is not today's Warsaw
 * date) and it is between `reportHourLocal` and `catchUpUntilHourLocal` (10, the spec's number)
 * Warsaw time. Before the report hour nothing was missed — the timer `scheduleReport` arms sends
 * it, and a catch-up then would send it twice.
 */
export function shouldCatchUp(
  nowMs: number,
  lastReportWarsawDate: string | null,
  reportHourLocal: number | null,
  catchUpUntilHourLocal = 10,
): boolean {
  if (reportHourLocal === null || lastReportWarsawDate === warsawDateStr(nowMs)) return false;
  const h = warsawParts(nowMs).h;
  return h >= reportHourLocal && h < catchUpUntilHourLocal;
}

/** Milliseconds until the next scheduled run — the re-arm delay, same shape as nightly.ts's. */
export const msUntilNextWarsawRun = (nowMs: number, hourLocal: number): number =>
  nextWarsawRun(nowMs, hourLocal) - nowMs;
