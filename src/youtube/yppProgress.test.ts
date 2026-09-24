import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchVideoEngagement, projectYpp, videoEngagement, yppThresholds } from "./yppProgress.js";

const now = Date.UTC(2026, 8, 8);
const base = {
  fetchedAt: new Date(now).toISOString(),
  subscribers: 75,
  subscribersPer7d: 34,
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
// 425 to go at 34 a week is ~87.5 days.
assert.equal(
  p.subscribers.eta!.slice(0, 10),
  new Date(now + Math.round((425 / (34 / 7)) * 86_400_000)).toISOString().slice(0, 10),
);
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
assert.equal(p.tiers.full.watchHours.need, 4000);
assert.equal(p.tiers.full.shortsViews.need, 10_000_000);
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
console.log("yppProgress: all checks passed");
