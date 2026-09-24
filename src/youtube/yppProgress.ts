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
 * The Shorts gate counts engaged views: since the March 2025 change a Shorts "view" is every
 * start or replay, and YouTube kept the old, watched-for-a-while count (the Analytics API's
 * `engagedViews`) for eligibility. Raw views ride along for the label, 3–5x the engaged number.
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

export interface YppSnapshot {
  fetchedAt: string;
  subscribers: number;
  subscribersPer7d: number;
  /** Number of days Analytics actually returned for the subscriber window. */
  subscribersDays?: number;
  watchHours365d: number;
  watchHoursPer28d: number;
  /** Number of days Analytics actually returned for the watch hours 28-day window. */
  watchHoursDays?: number;
  /** Engaged Shorts views — what the gate counts. */
  shortsViews90d: number;
  shortsViewsPer28d: number;
  /** Number of days Analytics actually returned for the Shorts 28-day window. */
  shortsViewsDays?: number;
  /** Every Shorts play over the same 90 days, for the label only. */
  shortsRawViews90d: number;
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
  shortsRawViews90d: number;
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
    // Analytics lags ~2–3 days, so the trailing days of the window are missing from the
    // report. Dividing by the window's full calendar length treats those missing days as
    // zero and dilutes the rate; dividing by the days Analytics actually returned gives
    // the real daily rate.
    const ratePerDay = windowDays > 0 ? perWindow / windowDays : 0;
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
    subscribers: gate(s.subscribers, need.subscribers, s.subscribersPer7d, s.subscribersDays ?? 7),
    watchHours: gate(s.watchHours365d, need.watchHours, s.watchHoursPer28d, s.watchHoursDays ?? 28, 365),
    shortsViews: gate(s.shortsViews90d, need.shortsViews, s.shortsViewsPer28d, s.shortsViewsDays ?? 28, 90),
  });
  const expanded = { ...tier(t.expanded), uploads90d: { have: s.uploads90d, need: t.expanded.uploads90d } };
  return {
    fetchedAt: s.fetchedAt,
    shortsRawViews90d: s.shortsRawViews90d,
    ...tier(t.expanded),
    tiers: { expanded, full: tier(t.full) },
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function analytics(token: string, params: Record<string, string>): Promise<(string | number)[][]> {
  const url = `https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({ ids: "channel==MINE", ...params })}`;
  // A hung Analytics call would otherwise hold the YouTube panel (Upload, Adopt) for minutes.
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { rows?: (string | number)[][]; error?: { message: string } };
  if (!res.ok || json.error) throw new Error(`Analytics: ${json.error?.message ?? res.status}`);
  return json.rows ?? [];
}

const sum = (rows: (string | number)[][], col = 0) => rows.reduce((a, r) => a + Number(r[col] ?? 0), 0);

/** Five requests: channel subscribers, hours over 365 and 28 days, Shorts views over 90 and 28 days. */
export async function fetchYppSnapshot(nowMs: number = Date.now()): Promise<YppSnapshot> {
  const token = await getAccessToken();
  const now = new Date(nowMs);
  const daysAgo = (n: number) => ymd(new Date(nowMs - n * 86_400_000));
  const channel = await dataApiGet<{ items?: Array<{ statistics: { subscriberCount: string } }> }>(
    "/channels?part=statistics&mine=true",
  );
  const stats = channel.items?.[0]?.statistics;

  // Analytics lags ~2–3 days, so the trailing days of the 7-day query window are missing.
  // We query dimensions: "day" to measure the net rate over the days Analytics actually returned
  // (the rows' dates) rather than dividing by 7 calendar days, which treats missing days as zero.
  const subs = await analytics(token, {
    startDate: daysAgo(7),
    endDate: ymd(now),
    dimensions: "day",
    metrics: "subscribersGained,subscribersLost",
  });
  const subsDays = new Set(subs.map((r) => String(r[0]))).size;

  // Both split by creatorContentType, whose values the API spells "videoOnDemand", "liveStream",
  // "shorts" and "creatorContentTypeUnspecified" — the panel compared against "SHORTS" and read
  // 0 Shorts views for weeks (3,146 on 23 Sept 2026), and counted Shorts minutes as watch hours.
  const byType = (days: number, metric: string, dimensions = "creatorContentType") =>
    analytics(token, {
      startDate: daysAgo(days),
      endDate: ymd(now),
      metrics: metric,
      dimensions,
    });
  const typed = (rows: (string | number)[][], keep: (type: string) => boolean, col = 1, typeCol = 0) =>
    rows.filter((r) => keep(String(r[typeCol]).toLowerCase())).reduce((a, r) => a + Number(r[col] ?? 0), 0);
  const longForm = (type: string) => type === "videoondemand" || type === "livestream";
  const isShort = (type: string) => type === "shorts";

  const h365 = typed(await byType(365, "estimatedMinutesWatched"), longForm);
  // Rate queries include dimensions: "day,creatorContentType" to count actual dates returned.
  const h28Rows = await byType(28, "estimatedMinutesWatched", "day,creatorContentType");
  const h28Days = new Set(h28Rows.map((r) => String(r[0]))).size;
  const h28 = typed(h28Rows, longForm, 2, 1);

  const shorts90 = await byType(90, "engagedViews,views");
  const shorts28Rows = await byType(28, "engagedViews", "day,creatorContentType");
  const shorts28Days = new Set(shorts28Rows.map((r) => String(r[0]))).size;
  const shorts28 = typed(shorts28Rows, isShort, 2, 1);

  return {
    fetchedAt: now.toISOString(),
    subscribers: Number(stats?.subscriberCount ?? 0),
    subscribersPer7d: sum(subs, 1) - sum(subs, 2),
    subscribersDays: subsDays,
    watchHours365d: h365 / 60,
    watchHoursPer28d: h28 / 60,
    watchHoursDays: h28Days,
    shortsViews90d: typed(shorts90, isShort),
    shortsViewsPer28d: shorts28,
    shortsViewsDays: shorts28Days,
    shortsRawViews90d: typed(shorts90, isShort, 2),
    uploads90d: await publicUploads90d(nowMs),
  };
}

/**
 * Public uploads in the last 90 days, from the channel's uploads playlist (the expanded tier's
 * third gate). The uploads gate counts only public videos (status.privacyStatus === "public");
 * scheduled or private ones do not count toward YPP. Null when it cannot be read — the gate
 * then shows as unknown.
 */
export async function publicUploads90d(nowMs: number): Promise<number | null> {
  try {
    const ch = await dataApiGet<{
      items?: Array<{ contentDetails: { relatedPlaylists: { uploads: string } } }>;
    }>("/channels?part=contentDetails&mine=true");
    const uploads = ch.items?.[0]?.contentDetails.relatedPlaylists.uploads;
    if (!uploads) return null;
    const list = await dataApiGet<{
      items?: Array<{
        contentDetails: { videoPublishedAt?: string };
        status?: { privacyStatus?: string };
      }>;
    }>(`/playlistItems?part=contentDetails,status&maxResults=50&playlistId=${uploads}`);
    const from = nowMs - 90 * 86_400_000;
    return (list.items ?? []).filter((i) => {
      if (i.status?.privacyStatus !== "public") return false;
      const at = Date.parse(i.contentDetails?.videoPublishedAt ?? "");
      return Number.isFinite(at) && at >= from && at <= nowMs;
    }).length;
  } catch {
    return null;
  }
}

/** Lifetime engaged views and minutes watched for one video, from the Analytics API. */
export interface VideoEngagement {
  engagedViews: number;
  minutesWatched: number;
}

/**
 * Every video's engaged views and minutes watched in one request (the top-videos report).
 *
 * The Data API's viewCount counts the muted autoplay previews Browse and Search start: engaged
 * views were 38% of long-form views over 28 days (audit, 24 Sept 2026), and minutes watched
 * track engaged views, not views. Analytics is about two days behind, so a new video has no row.
 */
export async function fetchVideoEngagement(
  token: string,
  nowMs: number = Date.now(),
): Promise<Map<string, VideoEngagement>> {
  // ponytail: top 200 by views is the report's cap; a channel past 200 videos needs paging here.
  const rows = await analytics(token, {
    startDate: "2025-01-01",
    endDate: ymd(new Date(nowMs)),
    dimensions: "video",
    metrics: "views,engagedViews,estimatedMinutesWatched",
    sort: "-views",
    maxResults: "200",
  });
  return new Map(
    rows.map((r) => [String(r[0]), { engagedViews: Number(r[2] ?? 0), minutesWatched: Number(r[3] ?? 0) }]),
  );
}

const ENGAGEMENT_TTL_MS = 60 * 60 * 1000;
const ENGAGEMENT_RETRY_MS = 5 * 60 * 1000;
let engagement: { atMs: number; byVideo: Map<string, VideoEngagement> | null; error: string | null } = {
  atMs: -Infinity,
  byVideo: null,
  error: null,
};
let engagementInflight: Promise<void> | null = null;

/**
 * The per-video engagement, cached an hour (five minutes after a failure). Never throws: a
 * missing token or a spent quota is `error`, and the panel shows the old number with "n/a".
 */
export async function videoEngagement(
  nowMs: number = Date.now(),
): Promise<{ byVideo: Map<string, VideoEngagement> | null; error: string | null }> {
  if (!isConfigured()) return { byVideo: null, error: "no YouTube token" };
  const age = nowMs - engagement.atMs;
  if (age < (engagement.error ? ENGAGEMENT_RETRY_MS : ENGAGEMENT_TTL_MS)) return engagement;
  // Screens opened while the request is out share it rather than each firing their own.
  engagementInflight ??= (async () => {
    try {
      engagement = {
        atMs: nowMs,
        byVideo: await fetchVideoEngagement(await getAccessToken(), nowMs),
        error: null,
      };
    } catch (err) {
      // Keep the last good numbers: an hour-old engaged count beats "n/a" after a blip.
      engagement = { atMs: nowMs, byVideo: engagement.byVideo, error: describeError(err) };
    } finally {
      engagementInflight = null;
    }
  })();
  await engagementInflight;
  return engagement;
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
