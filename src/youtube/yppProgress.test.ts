import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fetchVideoEngagement,
  fetchYppSnapshot,
  projectYpp,
  publicUploads90d,
  videoEngagement,
  yppThresholds,
} from "./yppProgress.js";

const now = Date.UTC(2026, 8, 8);
const base = {
  fetchedAt: new Date(now).toISOString(),
  subscribers: 75,
  subscribersPer7d: 34, // 4.86 a day: a good week
  subscribersPer28d: 56, // 2 a day
  watchHours365d: 1120,
  watchHoursPer28d: 52,
  shortsViews90d: 0,
  shortsViewsPer28d: 0,
  shortsRawViews90d: 3197,
  uploads90d: 20,
};
const p = projectYpp(base, now);
assert.equal(p.subscribers.need, 500, "the top-level gates are the expanded tier's, the next target");
assert.equal(p.subscribers.have, 75);
// 425 to go. The date is the 28-day pace (2 a day, 212.5 days): a good week is not a pace.
assert.equal(p.subscribers.ratePerDay, 2);
assert.equal(
  p.subscribers.eta!.slice(0, 10),
  new Date(now + Math.round((425 / 2) * 86_400_000)).toISOString().slice(0, 10),
);
// The week was faster, so it rides along as the optimistic end of the range: 34 a week, 87.5 days.
assert.ok(Math.abs(p.subscribers.recent!.ratePerDay - 34 / 7) < 1e-9);
assert.equal(
  p.subscribers.recent!.eta.slice(0, 10),
  new Date(now + Math.round((425 / (34 / 7)) * 86_400_000)).toISOString().slice(0, 10),
);
assert.ok(p.subscribers.recent!.eta < p.subscribers.eta!, "the optimistic end lands first");
// Both tiers carry it, and only the subscribers gate does: hours and Shorts keep their 28-day pace.
assert.ok(p.tiers.full.subscribers.recent && p.tiers.expanded.subscribers.recent);
assert.equal(p.watchHours.recent, undefined);
assert.equal(p.shortsViews.recent, undefined);
// No range when the week was no faster than the month (equal included), or when there is nothing to wait for.
assert.equal(projectYpp({ ...base, subscribersPer7d: 7 }, now).subscribers.recent, undefined);
assert.equal(projectYpp({ ...base, subscribersPer7d: 14 }, now).subscribers.recent, undefined);
assert.equal(projectYpp({ ...base, subscribers: 600 }, now).subscribers.recent, undefined);
// A flat month has no date, whatever the last week did: the week alone is not a date.
{
  const flat = projectYpp({ ...base, subscribersPer28d: 0 }, now).subscribers;
  assert.equal(flat.eta, null);
  assert.ok(flat.recent, "the week is still reported");
}
// The 30 Sept 2026 post-mortem's channel (102 subscribers; 63 net in 28 days, 27 in the last 7):
// the week put 1,000 on 21 May 2027, the month on 3 Nov 2027 — the countdown now says both.
{
  const postMortemNow = Date.UTC(2026, 8, 30, 12);
  const full = projectYpp(
    { ...base, subscribers: 102, subscribersPer7d: 27, subscribersPer28d: 63 },
    postMortemNow,
  ).tiers.full.subscribers;
  assert.equal(full.eta!.slice(0, 10), "2027-11-03");
  assert.equal(full.recent!.eta.slice(0, 10), "2027-05-21");
}
// Hours are a rolling year: 52 h per 28 days levels off near 678 h, so the gate is out of reach
// at this rate and the honest answer is the daily rate that would get there, not a date.
assert.equal(p.watchHours.eta, null, "a ceiling under the gate is no ETA");
assert.ok(Math.abs(p.watchHours.ceiling! - (52 / 28) * 365) < 0.01);
assert.ok(Math.abs(p.watchHours.needPerDay! - 3000 / 365) < 0.01);
// Fast enough, and the rolling window is no obstacle: a date comes back.
const fast = projectYpp({ ...base, watchHours365d: 2000, watchHoursPer28d: 28 * 15 }, now).watchHours;
assert.ok(fast.ceiling! > 3000 && fast.eta !== null, "15 h/day clears the ceiling and lands on a date");
assert.equal(
  fast.eta!.slice(0, 10),
  new Date(now + Math.round((1000 / 15) * 86_400_000)).toISOString().slice(0, 10),
);
assert.equal(p.shortsViews.eta, null, "no Shorts views yet means no ETA, not a division by zero");
assert.equal(p.shortsViews.ratePerDay, 0);
assert.equal(p.shortsViews.ceiling, 0);
// A gate already met lands today.
assert.equal(projectYpp({ ...base, subscribers: 600 }, now).subscribers.eta!.slice(0, 10), "2026-09-08");
// Both tiers ride along: the full tier's hours double for new applicants on 1 Feb 2027
// (YouTube Help 12843009), the expanded tier does not change.
assert.equal(p.tiers.full.subscribers.need, 1000);
// 925 to go at 2 a day lands in 2027-12, after 1 Feb 2027: judged by the thresholds in force then.
assert.equal(p.tiers.full.watchHours.need, 8000);
assert.equal(p.tiers.full.shortsViews.need, 20_000_000);
// A full tier that lands before 1 Feb 2027 keeps today's: 990 subs at 2 a day, 3,900 h at 15 h a day.
{
  const soon = projectYpp({ ...base, subscribers: 990, watchHours365d: 3900, watchHoursPer28d: 28 * 15 }, now)
    .tiers.full;
  assert.equal(soon.watchHours.need, 4000);
  assert.equal(soon.shortsViews.need, 10_000_000);
}
// Subscribers in time, but 4,000 h only after 1 Feb (3,900 to go at 24 a day, 162 days): the later
// threshold applies, and its later date (7,900 to go, ~329 days).
{
  const late = projectYpp({ ...base, subscribers: 990, watchHours365d: 100, watchHoursPer28d: 28 * 24 }, now)
    .tiers.full.watchHours;
  assert.equal(late.need, 8000);
  assert.equal(late.eta!.slice(0, 10), new Date(now + (7900 / 24) * 86_400_000).toISOString().slice(0, 10));
}
assert.equal(p.tiers.expanded.shortsViews.need, 3_000_000);
assert.deepEqual(p.tiers.expanded.uploads90d, { have: 20, need: 3 });
const in2027 = projectYpp(base, Date.UTC(2027, 1, 1));
assert.equal(in2027.tiers.full.watchHours.need, 8000);
assert.equal(in2027.tiers.full.shortsViews.need, 20_000_000);
assert.equal(in2027.tiers.expanded.watchHours.need, 3000);
assert.deepEqual(yppThresholds(Date.UTC(2027, 0, 31)).full.watchHours, 4000);
// Raw Shorts views ride along for the label; the gate itself counts engaged views only.
assert.equal(p.shortsRawViews90d, 3197);
assert.equal(p.shortsViews.have, 0);

// Lagging window: Analytics lags ~2–3 days so a 28-day query window returned only 25 days
// (3 missing trailing days). Daily rate must divide by the days actually returned, not the
// calendar days of the window — for the week that rides along as `recent` too.
{
  const lagging = projectYpp({ ...base, subscribersPer28d: 10, subscribersDays28: 4 }, now);
  assert.equal(lagging.subscribers.ratePerDay, 2.5, "rate divides by 4 returned days, not 28 calendar days");
  assert.equal(
    lagging.subscribers.eta!.slice(0, 10),
    new Date(now + Math.round((425 / 2.5) * 86_400_000)).toISOString().slice(0, 10),
  );
  const week = projectYpp({ ...base, subscribersPer7d: 10, subscribersDays: 4 }, now).subscribers;
  assert.equal(week.recent!.ratePerDay, 2.5, "the week divides by its 4 returned days, not 7");

  // The audit item b5 scenario on 24 Sept 2026:
  // Dividing by the window's calendar days gave 19 Jul 2027 (1.43/day), while the real rate over returned days (2.14/day) gives 11 Apr 2027.
  const auditNow = Date.UTC(2026, 8, 24, 12, 0, 0);
  const auditDivBy28 = projectYpp({ ...base, subscribersPer28d: 40, subscribersDays28: 28 }, auditNow);
  assert.equal(auditDivBy28.subscribers.eta!.slice(0, 10), "2027-07-19");
  const auditReal = projectYpp({ ...base, subscribersPer28d: 10, subscribersDays28: 10 / 2.14 }, auditNow);
  assert.ok(Math.abs(auditReal.subscribers.ratePerDay - 2.14) < 0.001);
  assert.equal(auditReal.subscribers.eta!.slice(0, 10), "2027-04-11");

  // Watch hours with 3 missing trailing days (25 days returned out of 28):
  const hoursLag = projectYpp({ ...base, watchHoursPer28d: 50, watchHoursDays: 25 }, now);
  assert.equal(hoursLag.watchHours.ratePerDay, 2.0);
  assert.equal(hoursLag.watchHours.ceiling, 730);

  // Shorts views with 3 missing trailing days (25 days returned out of 28):
  const shortsLag = projectYpp({ ...base, shortsViewsPer28d: 25_000, shortsViewsDays: 25 }, now);
  assert.equal(shortsLag.shortsViews.ratePerDay, 1000);
}

// The panel (public/youtube.js, a browser script with no module system, probed the way
// splitsChart.test.ts probes splits.js): the header names the tier the bars show — the expanded
// tier's, `progress`'s top level — with the bars' own thresholds; the subscribers gate prints the
// 28-day pace and the date at it, then the last week's date as the optimistic end (the date alone when
// the week was no faster), and the full tier's subscriber date the same way under it.
{
  const source = readFileSync(path.join(import.meta.dirname, "..", "..", "public", "youtube.js"), "utf8");
  const yppInner = new Function("esc", `${source}; return yppInner;`)((s: unknown) => String(s ?? "")) as (
    ypp: unknown,
  ) => string;
  const monthYear = (iso: string) =>
    new Date(iso).toLocaleDateString([], { month: "short", year: "numeric" });
  const at = Date.UTC(2026, 8, 30, 12);
  const week = { ...base, subscribers: 102, subscribersPer7d: 27, subscribersPer28d: 63 };
  const progress = projectYpp(week, at);
  const { subscribers } = progress;
  const html = yppInner({ progress });
  assert.ok(html.includes("+63 / 28 days"), "the rate is the 28 days', not a week's");
  assert.ok(
    html.includes(
      `at this rate ${monthYear(subscribers.eta!)} &middot; ${monthYear(subscribers.recent!.eta)} at the last week's pace`,
    ),
    html,
  );
  const slow = yppInner({ progress: projectYpp({ ...week, subscribersPer7d: 7 }, at) });
  assert.ok(
    slow.includes(`at this rate ${monthYear(subscribers.eta!)}`) && !slow.includes("last week"),
    slow,
  );

  // The header said "500 subscribers and either 4,000 watch hours or 10M Shorts views": the expanded
  // tier's subscribers beside the full tier's hours and Shorts, while the bars read 3,000 h and 3M.
  const header = (page: string) => /<div class="ypphead">(.*?)<\/div>/.exec(page)?.[1];
  const goals = yppThresholds(at).expanded;
  assert.equal(
    header(html),
    `Partner programme &middot; expanded tier (fan funding) &middot; ${goals.subscribers} subscribers and either ${goals.watchHours.toLocaleString()} watch hours or ${goals.shortsViews / 1e6}M Shorts views`,
  );
  assert.ok(!html.includes("4,000") && !html.includes("10M"), html);
  // ...and those are the numbers on the bars.
  assert.ok(
    html.includes(`102 / ${goals.subscribers}`) && html.includes(`/ ${goals.watchHours.toLocaleString()} h`),
    html,
  );
  assert.ok(html.includes("/ 3.0M"), html);

  // Both tiers' subscriber dates: the bar's own first, the full tier's under it, each with the
  // last week's date as the optimistic end.
  const full = progress.tiers.full.subscribers;
  const pace = (g: typeof full) =>
    `at this rate ${monthYear(g.eta!)} &middot; ${monthYear(g.recent!.eta)} at the last week's pace`;
  const fullLine = `full tier (ads) &middot; ${yppThresholds(at).full.subscribers.toLocaleString()}</span><span>`;
  assert.notEqual(monthYear(full.eta!), monthYear(subscribers.eta!), "two tiers, two dates");
  assert.ok(html.includes(`${fullLine}${pace(full)}`), html);
  assert.ok(
    html.indexOf(pace(subscribers)) < html.indexOf(fullLine),
    "the bar's tier first, the full tier under it",
  );
  assert.ok(slow.includes(`${fullLine}at this rate ${monthYear(full.eta!)}</span>`), slow);
  // The expanded tier reached: its bar says so, and the full tier still has its date.
  const done = yppInner({ progress: projectYpp({ ...week, subscribers: 600 }, at) });
  assert.equal(done.split('<span class="ok">reached</span>').length - 1, 1, done);
  assert.ok(done.includes(`${fullLine}at this rate`), done);

  // An older server cannot break it: no `tiers` (before 23 Sept) leaves the bar's date alone, no
  // `recent` (before the 28-day pace) leaves dates without a range.
  const noTiers = yppInner({ progress: { ...progress, tiers: undefined } });
  assert.ok(!noTiers.includes("full tier") && noTiers.includes(pace(subscribers)), noTiers);
  assert.equal(header(noTiers), header(html));
  const noRecent = yppInner({
    progress: JSON.parse(JSON.stringify(progress), (key, value) => (key === "recent" ? undefined : value)),
  });
  assert.ok(!noRecent.includes("last week") && noRecent.includes(`${fullLine}at this rate`), noRecent);
}

// Per-video engagement: one top-videos request, rows keyed by video id. The fake answers the
// way the Analytics API does — the dimension first, then the metrics in the order asked for.
{
  const realFetch = globalThis.fetch;
  const asked: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(new URL(String(input)));
    return new Response(
      JSON.stringify({
        rows: [
          ["FtJ-VEv6pgk", 6385, 2709, 12040],
          ["opWF0000000", 1492, 1492, 3001.5],
        ],
      }),
    );
  }) as typeof fetch;
  try {
    const byVideo = await fetchVideoEngagement("tok", now);
    assert.equal(asked.length, 1, "one request for every video, not one per video");
    const q = asked[0].searchParams;
    assert.equal(q.get("dimensions"), "video");
    assert.equal(q.get("metrics"), "views,engagedViews,estimatedMinutesWatched");
    assert.equal(q.get("ids"), "channel==MINE");
    assert.equal(q.get("endDate"), "2026-09-08");
    assert.deepEqual(byVideo.get("FtJ-VEv6pgk"), { engagedViews: 2709, minutesWatched: 12040 });
    assert.deepEqual(byVideo.get("opWF0000000"), { engagedViews: 1492, minutesWatched: 3001.5 });
    assert.equal(
      byVideo.get("unknown"),
      undefined,
      "a video Analytics has no row for yet is absent, not zero",
    );

    // A spent quota is an error the caller turns into "engaged n/a", not a crash.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), {
        status: 403,
      })) as typeof fetch;
    await assert.rejects(fetchVideoEngagement("tok", now), /Analytics: Quota exceeded/);
  } finally {
    globalThis.fetch = realFetch;
  }
}
// The cached getter the uploads route calls on every screen: one request an hour however many
// screens open at once, and a spent quota keeps the last good numbers rather than throwing.
{
  const realFetch = globalThis.fetch;
  const realToken = process.env.YOUTUBE_TOKEN_FILE;
  const dir = await mkdtemp(path.join(tmpdir(), "mcsr-ypp-"));
  process.env.YOUTUBE_TOKEN_FILE = path.join(dir, "token.json");
  let analyticsCalls = 0;
  let quotaSpent = false;
  // Every fetch lands here, the token refresh included: nothing reaches Google from a test.
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (!String(input).includes("youtubeanalytics")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    }
    analyticsCalls++;
    await new Promise((r) => setTimeout(r, 10));
    return quotaSpent
      ? new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: 403 })
      : new Response(JSON.stringify({ rows: [["FtJ-VEv6pgk", 6385, 2709, 12040]] }));
  }) as typeof fetch;
  try {
    assert.deepEqual(await videoEngagement(now), { byVideo: null, error: "no YouTube token" });
    await writeFile(
      process.env.YOUTUBE_TOKEN_FILE,
      JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
    );

    const [a, b] = await Promise.all([videoEngagement(now), videoEngagement(now)]);
    assert.equal(analyticsCalls, 1, "two screens opened together share one request");
    assert.equal(a.byVideo?.get("FtJ-VEv6pgk")?.engagedViews, 2709);
    assert.equal(b.byVideo?.get("FtJ-VEv6pgk")?.engagedViews, 2709);
    await videoEngagement(now + 59 * 60_000);
    assert.equal(analyticsCalls, 1, "cached for the hour");

    quotaSpent = true;
    const failed = await videoEngagement(now + 61 * 60_000);
    assert.equal(analyticsCalls, 2);
    assert.match(failed.error ?? "", /Quota exceeded/);
    assert.equal(failed.byVideo?.get("FtJ-VEv6pgk")?.engagedViews, 2709, "the last good numbers stay");
    await videoEngagement(now + 64 * 60_000);
    assert.equal(analyticsCalls, 2, "no retry inside five minutes of a failure");
    quotaSpent = false;
    assert.equal((await videoEngagement(now + 67 * 60_000)).error, null);
    assert.equal(analyticsCalls, 3);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
    else process.env.YOUTUBE_TOKEN_FILE = realToken;
    await rm(dir, { recursive: true, force: true });
  }
}

// Uploads gate: counts only public videos in the last 90 days (status.privacyStatus === "public").
// Private, scheduled, and unlisted videos in the playlist must not count toward YPP.
{
  const realFetch = globalThis.fetch;
  const realToken = process.env.YOUTUBE_TOKEN_FILE;
  const dir = await mkdtemp(path.join(tmpdir(), "mcsr-ypp-uploads-"));
  process.env.YOUTUBE_TOKEN_FILE = path.join(dir, "token.json");
  await writeFile(
    process.env.YOUTUBE_TOKEN_FILE,
    JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
  );
  const askedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    askedUrls.push(url);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    }
    if (url.includes("/channels?part=contentDetails")) {
      return new Response(
        JSON.stringify({
          items: [{ contentDetails: { relatedPlaylists: { uploads: "UU_TEST_PLAYLIST" } } }],
        }),
      );
    }
    if (url.includes("/playlistItems")) {
      return new Response(
        JSON.stringify({
          items: [
            // Public video within 90 days -> counts
            {
              contentDetails: { videoPublishedAt: new Date(now - 10 * 86_400_000).toISOString() },
              status: { privacyStatus: "public" },
            },
            // Private video in the list within 90 days -> does NOT count
            {
              contentDetails: { videoPublishedAt: new Date(now - 15 * 86_400_000).toISOString() },
              status: { privacyStatus: "private" },
            },
            // Scheduled video (private status) within 90 days -> does NOT count
            {
              contentDetails: { videoPublishedAt: new Date(now - 20 * 86_400_000).toISOString() },
              status: { privacyStatus: "private" },
            },
            // Unlisted video within 90 days -> does NOT count
            {
              contentDetails: { videoPublishedAt: new Date(now - 25 * 86_400_000).toISOString() },
              status: { privacyStatus: "unlisted" },
            },
            // Public video older than 90 days -> does NOT count
            {
              contentDetails: { videoPublishedAt: new Date(now - 100 * 86_400_000).toISOString() },
              status: { privacyStatus: "public" },
            },
          ],
        }),
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;

  try {
    const publicCount = await publicUploads90d(now);
    assert.equal(
      publicCount,
      1,
      "only public videos in the 90-day window count; private/unlisted/scheduled do not",
    );
    const playlistReq = askedUrls.find((u) => u.includes("/playlistItems"));
    assert.ok(playlistReq, "made a playlistItems request");
    assert.ok(
      playlistReq.includes("part=contentDetails%2Cstatus") ||
        playlistReq.includes("part=contentDetails,status"),
      "playlistItems requested part=contentDetails,status",
    );
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
    else process.env.YOUTUBE_TOKEN_FILE = realToken;
    await rm(dir, { recursive: true, force: true });
  }
}

// fetchYppSnapshot computes rates over the days Analytics actually returned (the rows' dates).
{
  const realFetch = globalThis.fetch;
  const realToken = process.env.YOUTUBE_TOKEN_FILE;
  const dir = await mkdtemp(path.join(tmpdir(), "mcsr-ypp-snapshot-"));
  process.env.YOUTUBE_TOKEN_FILE = path.join(dir, "token.json");
  await writeFile(
    process.env.YOUTUBE_TOKEN_FILE,
    JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
  );
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    }
    if (url.includes("/channels?part=statistics")) {
      return new Response(JSON.stringify({ items: [{ statistics: { subscriberCount: "75" } }] }));
    }
    if (url.includes("/channels?part=contentDetails")) {
      return new Response(
        JSON.stringify({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UU_TEST" } } }] }),
      );
    }
    if (url.includes("/playlistItems")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              contentDetails: { videoPublishedAt: new Date(now - 10 * 86_400_000).toISOString() },
              status: { privacyStatus: "public" },
            },
            {
              contentDetails: { videoPublishedAt: new Date(now - 20 * 86_400_000).toISOString() },
              status: { privacyStatus: "private" },
            },
          ],
        }),
      );
    }
    if (url.includes("youtubeanalytics")) {
      const u = new URL(url);
      const metrics = u.searchParams.get("metrics") ?? "";
      const dimensions = u.searchParams.get("dimensions") ?? "";
      // Subscribers query: one 28-day report, 4 of its last 7 days returned (3 missing trailing
      // days due to lag) and two older days that only the 28-day pace counts.
      if (metrics.includes("subscribersGained")) {
        assert.equal(dimensions, "day", "subscribers query asks for dimensions=day");
        assert.equal(u.searchParams.get("startDate"), "2026-08-11", "28 days back from 8 Sept, not 7");
        return new Response(
          JSON.stringify({
            rows: [
              ["2026-08-15", 1, 0],
              ["2026-08-30", 0, 0],
              ["2026-09-02", 3, 0],
              ["2026-09-03", 2, 1],
              ["2026-09-04", 4, 0],
              ["2026-09-05", 2, 0],
            ],
          }),
        );
      }
      if (metrics.includes("estimatedMinutesWatched") && dimensions.includes("day")) {
        return new Response(
          JSON.stringify({
            rows: [
              ["2026-09-02", "videoOnDemand", 120],
              ["2026-09-03", "videoOnDemand", 180],
            ],
          }),
        );
      }
      if (metrics.includes("estimatedMinutesWatched") && !dimensions.includes("day")) {
        return new Response(JSON.stringify({ rows: [["videoOnDemand", 60000]] }));
      }
      if (metrics.includes("engagedViews") && dimensions.includes("day")) {
        return new Response(
          JSON.stringify({
            rows: [
              ["2026-09-02", "shorts", 50],
              ["2026-09-03", "shorts", 50],
            ],
          }),
        );
      }
      if (metrics.includes("engagedViews,views")) {
        return new Response(JSON.stringify({ rows: [["shorts", 1000, 3000]] }));
      }
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;

  try {
    const snap = await fetchYppSnapshot(now);
    assert.equal(snap.subscribers, 75);
    // Net gained: (3+2+4+2) - (0+1+0+0) = 10 net subscribers over the 4 days returned in the last week
    assert.equal(snap.subscribersPer7d, 10, "the week is the rows dated from 1 Sept on");
    assert.equal(
      snap.subscribersDays,
      4,
      "subscribersDays reflects the 4 dates actually returned by Analytics",
    );
    // ...and 11 over the 6 days of the 28-day report: the same rows plus 15 Aug and 30 Aug.
    assert.equal(snap.subscribersPer28d, 11);
    assert.equal(snap.subscribersDays28, 6);
    assert.equal(snap.watchHoursDays, 2, "watchHoursDays reflects the 2 dates actually returned");
    assert.equal(snap.shortsViewsDays, 2, "shortsViewsDays reflects the 2 dates actually returned");
    assert.equal(snap.uploads90d, 1, "only the public upload is counted");

    const projected = projectYpp(snap, now);
    assert.equal(
      projected.subscribers.ratePerDay,
      11 / 6,
      "the date's rate is the 28 days': 11 / 6 returned days",
    );
    assert.equal(projected.subscribers.recent!.ratePerDay, 2.5, "the week's rate is 10 / 4 = 2.5 / day");
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
    else process.env.YOUTUBE_TOKEN_FILE = realToken;
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("yppProgress: all checks passed");
