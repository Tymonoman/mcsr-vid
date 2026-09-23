/**
 * Where the channel stands on the Partner Programme's gates, and when each lands at the current
 * rate. The dashboard is what the operator opens every morning; the thresholds were in a report.
 *
 * Two tiers (YouTube Help 13429240, 72851 and 12843009, read 23 Sept 2026):
 *   - expanded (fan funding: memberships, Supers, Thanks) — 500 subscribers, 3 public uploads in
 *     the last 90 days, and either 3,000 public long-form watch hours in 365 days or 3M Shorts
 *     views in 90 days. Unchanged by the 2027 update, and the channel's next target.
 *   - full (ads) — 1,000 subscribers and either 4,000 hours or 10M Shorts views; from
 *     1 Feb 2027, 8,000 hours or 20M Shorts views for new applicants.
 * Watch hours count long-form only ("watch hours from Shorts views in the Shorts Feed won't
 * count"), so hours are read per `creatorContentType` and the Shorts rows left out.
 * Rates are measured over the last 28 days for hours and Shorts, and the last 7 for subscribers
 * — subscribers move on each upload, hours accumulate.
 */
import { describeError } from "../errorText.js";
import { dataApiGet, getAccessToken, isConfigured } from "./youtube.js";

/** The day the full tier's thresholds double for new applicants. */
export const FULL_TIER_2027_MS = Date.UTC(2027, 1, 1);

export function yppThresholds(nowMs: number = Date.now()) {
  const after2027 = nowMs >= FULL_TIER_2027_MS;
  return {
    expanded: { subscribers: 500, uploads90d: 3, watchHours: 3000, shortsViews: 3_000_000 },
    full: {
      subscribers: 1000,
      watchHours: after2027 ? 8000 : 4000,
      shortsViews: after2027 ? 20_000_000 : 10_000_000,
    },
  } as const;
}

interface YppSnapshot {
  fetchedAt: string;
  subscribers: number;
  subscribersPer7d: number;
  watchHours365d: number;
  watchHoursPer28d: number;
  shortsViews90d: number;
  shortsViewsPer28d: number;
  /** Public uploads in the last 90 days, or null when the count could not be read. */
  uploads90d: number | null;
}

interface YppGate {
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

interface YppTier {
  subscribers: YppGate;
  watchHours: YppGate;
  shortsViews: YppGate;
}

export interface YppProgress extends YppTier {
  fetchedAt: string;
  /** The top-level gates are the expanded tier's, the channel's next target; both tiers here. */
  tiers: {
    expanded: YppTier & { uploads90d: { have: number | null; need: number } };
    full: YppTier;
  };
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
  const t = yppThresholds(nowMs);
  const tier = (need: { subscribers: number; watchHours: number; shortsViews: number }): YppTier => ({
    subscribers: gate(s.subscribers, need.subscribers, s.subscribersPer7d, 7),
    watchHours: gate(s.watchHours365d, need.watchHours, s.watchHoursPer28d, 28, 365),
    shortsViews: gate(s.shortsViews90d, need.shortsViews, s.shortsViewsPer28d, 28, 90),
  });
  const expanded = { ...tier(t.expanded), uploads90d: { have: s.uploads90d, need: t.expanded.uploads90d } };
  return { fetchedAt: s.fetchedAt, ...tier(t.expanded), tiers: { expanded, full: tier(t.full) } };
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
async function fetchYppSnapshot(nowMs: number = Date.now()): Promise<YppSnapshot> {
  const token = await getAccessToken();
  const now = new Date(nowMs);
  const daysAgo = (n: number) => ymd(new Date(nowMs - n * 86_400_000));
  const channel = await dataApiGet<{ items?: Array<{ statistics: { subscriberCount: string } }> }>(
    "/channels?part=statistics&mine=true",
  );
  const stats = channel.items?.[0]?.statistics;
  const subs = await analytics(token, {
    startDate: daysAgo(7),
    endDate: ymd(now),
    metrics: "subscribersGained,subscribersLost",
  });
  // Both split by creatorContentType, whose values the API spells "videoOnDemand", "liveStream",
  // "shorts" and "creatorContentTypeUnspecified" — the panel compared against "SHORTS" and read
  // 0 Shorts views for weeks (3,146 on 23 Sept 2026), and counted Shorts minutes as watch hours.
  const byType = (days: number, metric: string) =>
    analytics(token, {
      startDate: daysAgo(days),
      endDate: ymd(now),
      metrics: metric,
      dimensions: "creatorContentType",
    });
  const typed = (rows: number[][], keep: (type: string) => boolean) =>
    rows.filter((r) => keep(String(r[0]).toLowerCase())).reduce((a, r) => a + Number(r[1] ?? 0), 0);
  const longForm = (type: string) => type === "videoondemand" || type === "livestream";
  const h365 = typed(await byType(365, "estimatedMinutesWatched"), longForm);
  const h28 = typed(await byType(28, "estimatedMinutesWatched"), longForm);
  const shorts = async (days: number) => typed(await byType(days, "views"), (type) => type === "shorts");
  return {
    fetchedAt: now.toISOString(),
    subscribers: Number(stats?.subscriberCount ?? 0),
    subscribersPer7d: sum(subs, 0) - sum(subs, 1),
    watchHours365d: h365 / 60,
    watchHoursPer28d: h28 / 60,
    shortsViews90d: await shorts(90),
    shortsViewsPer28d: await shorts(28),
    uploads90d: await publicUploads90d(nowMs),
  };
}

/**
 * Public uploads in the last 90 days, from the channel's uploads playlist (the expanded tier's
 * third gate). A scheduled video sits in the playlist before it is public, so publish times in
 * the future are left out. Null when it cannot be read — the gate then shows as unknown.
 */
async function publicUploads90d(nowMs: number): Promise<number | null> {
  try {
    const ch = await dataApiGet<{
      items?: Array<{ contentDetails: { relatedPlaylists: { uploads: string } } }>;
    }>("/channels?part=contentDetails&mine=true");
    const uploads = ch.items?.[0]?.contentDetails.relatedPlaylists.uploads;
    if (!uploads) return null;
    const list = await dataApiGet<{ items?: Array<{ contentDetails: { videoPublishedAt?: string } }> }>(
      `/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}`,
    );
    const from = nowMs - 90 * 86_400_000;
    return (list.items ?? []).filter((i) => {
      const at = Date.parse(i.contentDetails.videoPublishedAt ?? "");
      return Number.isFinite(at) && at >= from && at <= nowMs;
    }).length;
  } catch {
    return null;
  }
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
