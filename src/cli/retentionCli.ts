/**
 * npm run retention -- <videoId> [<videoId>…] [--days=90]
 *
 * The audience retention curve of the channel's own videos, from the YouTube Analytics API:
 * `audienceWatchRatio` by `elapsedVideoTimeRatio`, printed as a small table (and as JSON on
 * stdout when piped). The 22 Sept 2026 audit could not say whether the 42% average view
 * percentage is lost in the 17 s before the race or mid-race; this is the number that says.
 * Needs the repo's OAuth token (`youtube-token.json`, scope yt-analytics.readonly).
 */
import { getAccessToken } from "../youtube/youtube.js";
import { config } from "../config.js";

const args = process.argv.slice(2);
const ids = args.filter((a) => !a.startsWith("--"));
const days = Number(args.find((a) => a.startsWith("--days="))?.slice(7) ?? 90);
if (ids.length === 0) {
  console.error("usage: npm run retention -- <videoId> [<videoId>…] [--days=90]");
  process.exit(2);
}

const token = await getAccessToken();
const end = new Date().toISOString().slice(0, 10);
const start = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
const out: Record<string, Array<{ at: number; ratio: number }>> = {};
for (const id of ids) {
  const q = new URLSearchParams({
    ids: `channel==${config.youtubeChannelId}`,
    startDate: start,
    endDate: end,
    metrics: "audienceWatchRatio",
    dimensions: "elapsedVideoTimeRatio",
    filters: `video==${id}`,
  });
  const res = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { rows?: number[][]; error?: { message: string } };
  if (!res.ok) {
    console.error(`${id}: ${body.error?.message ?? res.status}`);
    continue;
  }
  const rows = (body.rows ?? []).map(([at, ratio]) => ({ at: at!, ratio: ratio! }));
  out[id] = rows;
  // Analytics lags two to three days: a new video has no rows yet, and one such id used to
  // throw on rows[0] and abort the whole batch.
  if (rows.length === 0) {
    console.error(`${id}: no retention data yet (Analytics lags 2–3 days behind the upload)`);
    continue;
  }
  // The curve at every tenth, plus the intro's end (the first 3% of a 10-minute video).
  const at = (t: number) =>
    rows.reduce((best, r) => (Math.abs(r.at - t) < Math.abs(best.at - t) ? r : best), rows[0]!);
  const pct = (r: { ratio: number }) => `${(r.ratio * 100).toFixed(0).padStart(3)}%`;
  console.error(
    `${id}  ${[0.03, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((t) => `${(t * 100).toFixed(0)}%:${pct(at(t))}`).join("  ")}`,
  );
}
if (!process.stdout.isTTY) console.log(JSON.stringify(out, null, 2));
