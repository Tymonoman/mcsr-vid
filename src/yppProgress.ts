/**
 * Where the channel stands on the Partner Programme's gates, and when each lands at the current
 * rate. The dashboard is what the operator opens every morning; the thresholds were in a report.
 *
 * Three gates, of which the channel needs the first and either of the other two:
 *   - 500 subscribers,
 *   - 4,000 public watch hours in the trailing 365 days, or
 *   - 10,000,000 public Shorts views in the trailing 90 days.
 * Rates are measured over the last 28 days for hours and Shorts, and the last 7 for subscribers
 * — subscribers move on each upload, hours accumulate.
 */
import { describeError } from "./errorText.js";
import { getAccessToken, isConfigured } from "./youtube.js";

export const YPP = { subscribers: 500, watchHours: 4000, shortsViews: 10_000_000 } as const;

export interface YppSnapshot {
  fetchedAt: string;
  subscribers: number;
  subscribersPer7d: number;
  watchHours365d: number;
  watchHoursPer28d: number;
  shortsViews90d: number;
  shortsViewsPer28d: number;
}

export interface YppGate {
  have: number;
  need: number;
  /** Per day, from the window each gate is measured over. */
  ratePerDay: number;
  /** ISO date the gate lands at that rate, or null when it never does (rate zero, or ceiling). */
  eta: string | null;
  /**
   * For the rolling-window gates: where the window's total levels off at this rate (rate x
   * window days). Under `need`, the gate is unreachable at this rate however long it runs —
   * a flat line never gets there — and `needPerDay` is the daily rate that would.
   */
  ceiling?: number;
  needPerDay?: number;
}

export interface YppProgress {
  fetchedAt: string;
  subscribers: YppGate;
  watchHours: YppGate;
  shortsViews: YppGate;
}

/** The arithmetic on its own, so it can be pinned without an API. */
export function projectYpp(s: YppSnapshot, nowMs: number = Date.now()): YppProgress {
  const gate = (
    have: number,
    need: number,
    perWindow: number,
    windowDays: number,
    rollingDays?: number,
  ): YppGate => {
    const ratePerDay = perWindow / windowDays;
    const left = Math.max(0, need - have);
    const out: YppGate = { have, need, ratePerDay, eta: null };
    if (rollingDays !== undefined) {
      // A rolling window's total converges on rate x window, so the gate is out of reach at
      // this rate when that ceiling is under it — the audit's "flat line never reaches 4,000".
      out.ceiling = ratePerDay * rollingDays;
      out.needPerDay = need / rollingDays;
      if (left > 0 && out.ceiling < need) return out;
    }
    out.eta =
      left === 0
        ? new Date(nowMs).toISOString()
        : ratePerDay > 0
          ? new Date(nowMs + (left / ratePerDay) * 86_400_000).toISOString()
          : null;
    return out;
  };
  return {
    fetchedAt: s.fetchedAt,
    subscribers: gate(s.subscribers, YPP.subscribers, s.subscribersPer7d, 7),
    watchHours: gate(s.watchHours365d, YPP.watchHours, s.watchHoursPer28d, 28, 365),
    shortsViews: gate(s.shortsViews90d, YPP.shortsViews, s.shortsViewsPer28d, 28, 90),
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function analytics(token: string, params: Record<string, string>): Promise<number[][]> {
  const url = `https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({ ids: "channel==MINE", ...params })}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const json = (await res.json()) as { rows?: number[][]; error?: { message: string } };
  if (!res.ok || json.error) throw new Error(`Analytics: ${json.error?.message ?? res.status}`);
  return json.rows ?? [];
}

const sum = (rows: number[][], col = 0) => rows.reduce((a, r) => a + (r[col] ?? 0), 0);

/** Five requests: channel subscribers, hours over 365 and 28 days, Shorts views over 90 and 28 days. */
export async function fetchYppSnapshot(nowMs: number = Date.now()): Promise<YppSnapshot> {
  const token = await getAccessToken();
  const now = new Date(nowMs);
  const daysAgo = (n: number) => ymd(new Date(nowMs - n * 86_400_000));
  const channel = await fetch("https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true", {
    headers: { authorization: `Bearer ${token}` },
  });
  const stats = ((await channel.json()) as { items?: Array<{ statistics: { subscriberCount: string } }> })
    .items?.[0]?.statistics;
  const subs = await analytics(token, {
    startDate: daysAgo(7),
    endDate: ymd(now),
    metrics: "subscribersGained,subscribersLost",
  });
  const h365 = await analytics(token, {
    startDate: daysAgo(365),
    endDate: ymd(now),
    metrics: "estimatedMinutesWatched",
  });
  const h28 = await analytics(token, {
    startDate: daysAgo(28),
    endDate: ymd(now),
    metrics: "estimatedMinutesWatched",
  });
  // Shorts views: the Analytics API separates them by creatorContentType.
  const shorts = async (days: number) => {
    try {
      const rows = await analytics(token, {
        startDate: daysAgo(days),
        endDate: ymd(now),
        metrics: "views",
        dimensions: "creatorContentType",
      });
      return rows.filter((r) => String(r[0]) === "SHORTS").reduce((a, r) => a + Number(r[1] ?? 0), 0);
    } catch {
      return 0;
    }
  };
  return {
    fetchedAt: now.toISOString(),
    subscribers: Number(stats?.subscriberCount ?? 0),
    subscribersPer7d: sum(subs, 0) - sum(subs, 1),
    watchHours365d: sum(h365) / 60,
    watchHoursPer28d: sum(h28) / 60,
    shortsViews90d: await shorts(90),
    shortsViewsPer28d: await shorts(28),
  };
}

const REFRESH_MS = 6 * 60 * 60 * 1000;
let cached: { atMs: number; progress: YppProgress | null; error: string | null } = {
  atMs: 0,
  progress: null,
  error: null,
};
let inflight: Promise<void> | null = null;

/** The last computed progress, refreshed in the background when older than six hours. */
export function yppProgress(nowMs: number = Date.now()): {
  progress: YppProgress | null;
  error: string | null;
  stale: boolean;
} {
  if (isConfigured() && !inflight && nowMs - cached.atMs >= REFRESH_MS) {
    inflight = fetchYppSnapshot(nowMs)
      .then((s) => {
        cached = { atMs: nowMs, progress: projectYpp(s, nowMs), error: null };
      })
      .catch((err: unknown) => {
        cached = { ...cached, atMs: nowMs, error: describeError(err) };
      })
      .finally(() => {
        inflight = null;
      });
  }
  return {
    progress: cached.progress,
    error: isConfigured() ? cached.error : "no YouTube token",
    stale: inflight !== null,
  };
}
