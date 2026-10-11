// The self-updating draw (config.learnedDraw, 11 Oct 2026): eligibility (public-ish, 7-90 days
// old), the channel median, the per-player n>=3 rule, the per-pair "most recent meeting" rule,
// the per-video view cache, and the once-a-day tick.
// Run: npx tsx src/dashboard/drawLearn.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import {
  drawLearnTick,
  readDrawLearned,
  recomputeDrawLearned,
  type DrawLearnDeps,
  type DrawLearned,
} from "./drawLearn.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-draw-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
const filePath = () => path.join(media, ".draw-learned.json");

// `isConfigured()` (src/youtube/youtube.ts) only checks that this file exists; every
// `firstWeekViews` below is injected and never calls the real `getAccessToken`.
const realTokenFile = process.env.YOUTUBE_TOKEN_FILE;
const tokenFile = path.join(media, "fake-token.json");
await writeFile(tokenFile, "{}");
process.env.YOUTUBE_TOKEN_FILE = tokenFile;

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 11);
const daysAgo = (n: number): number => NOW - n * DAY;
const iso = (ms: number): string => new Date(ms).toISOString();

const silence = async (fn: () => Promise<void>): Promise<string[]> => {
  const lines: string[] = [];
  const real = console.error;
  console.error = (msg: unknown) => lines.push(String(msg));
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return lines;
};

// --- readDrawLearned: missing is silent, corrupt logs once, both fall back to null -------------
{
  assert.equal(readDrawLearned(), null, "nothing computed yet");
  await writeFile(filePath(), "{not json");
  let result: DrawLearned | null = { computedAt: 1, channelMedian: 1, players: {}, pairs: {}, videoViews: {} };
  const lines = await silence(async () => {
    result = readDrawLearned();
  });
  assert.equal(result, null, "corrupt JSON falls back to null, not a throw");
  assert.equal(lines.length, 1, "logs once");
  assert.ok(lines[0]!.includes(".draw-learned.json"));
  await rm(filePath());
  console.log("OK: readDrawLearned — missing is silent, corrupt logs once, both fall back to null");
}

// --- recomputeDrawLearned: eligibility, the median, n>=3, "most recent meeting", the cache ------
{
  // video id -> [players, views, days ago, record overrides]
  type Row = { videoId: string; players: [string, string]; views: number; daysAgo: number; record?: Partial<{ privacyStatus: string; publishAt: string | null }> };
  const rows: Row[] = [
    { videoId: "v1", players: ["aaa", "bbb"], views: 200, daysAgo: 10 },
    { videoId: "v2", players: ["aaa", "ccc"], views: 100, daysAgo: 20 },
    { videoId: "v3", players: ["aaa", "ddd"], views: 300, daysAgo: 30 },
    { videoId: "v4", players: ["bbb", "eee"], views: 50, daysAgo: 40 },
    { videoId: "v5", players: ["ccc", "ddd"], views: 400, daysAgo: 50 },
    { videoId: "v7", players: ["ccc", "ddd"], views: 250, daysAgo: 12 }, // a later meeting of the same pair
    { videoId: "v8", players: ["zzz", "yyy"], views: 999, daysAgo: 3 }, // too recent: under 7 days
    { videoId: "v9", players: ["zzz", "yyy"], views: 999, daysAgo: 120 }, // too old: over 90 days
    { videoId: "v10", players: ["zzz", "yyy"], views: 999, daysAgo: 15, record: { privacyStatus: "private", publishAt: null } }, // never on the channel
    { videoId: "v11", players: ["fff", "ggg"], views: 350, daysAgo: 15, record: { privacyStatus: "private", publishAt: iso(daysAgo(15)) } }, // scheduled, past its time: still counts
    { videoId: "v12", players: ["Aquacorde", "zzz"], views: 999, daysAgo: 14 }, // a blocked player: never fed in, same as everywhere else
  ];
  const uploads = rows.map((r, i) => ({
    matchId: i + 1,
    record: {
      videoId: r.videoId,
      publishAt: r.record?.publishAt ?? null,
      privacyStatus: r.record?.privacyStatus ?? "public",
      uploadedAt: iso(daysAgo(r.daysAgo)),
    },
  }));
  const playersByMatch = new Map(rows.map((r, i) => [i + 1, r.players]));
  const viewsByVideo = new Map(rows.map((r) => [r.videoId, r.views]));
  const firstWeekCalls: string[] = [];
  const deps: DrawLearnDeps = {
    uploads: async () => uploads,
    playersOf: async (matchId) => playersByMatch.get(matchId) ?? null,
    firstWeekViews: async (videoId) => {
      firstWeekCalls.push(videoId);
      return viewsByVideo.get(videoId)!;
    },
  };

  const result = await recomputeDrawLearned(NOW, deps);
  assert.ok(result, "a token and eligible videos: a result");

  // Eligible: v1,v2,v3,v4,v5,v7,v11 (7 videos) — v8/v9 by age, v10 for never being public, v12 for
  // a blocked player, and `firstWeekViews` was asked for exactly those, each once.
  assert.deepEqual(
    [...firstWeekCalls].sort(),
    ["v1", "v11", "v2", "v3", "v4", "v5", "v7"],
    "age, public-ness and the block list all filter before a single Analytics call is made",
  );

  // Median of [200,100,300,50,400,250,350] is 250 — v12's 999 plays no part.
  assert.equal(result!.channelMedian, 250);

  // aaa: 200/250, 100/250, 300/250 -> median 0.8, n=3. ccc and ddd clear 3 too (v2/v5/v7 and
  // v3/v5/v7); bbb/eee/fff/ggg stop at 1-2 and keep none of DEFAULT_DRAW's job here.
  assert.deepEqual(result!.players["aaa"], { draw: 0.8, n: 3 });
  assert.deepEqual(result!.players["ccc"], { draw: 1, n: 3 });
  assert.deepEqual(result!.players["ddd"], { draw: 1.2, n: 3 });
  assert.equal(result!.players["bbb"], undefined, "two videos is not enough");
  assert.equal(result!.players["eee"], undefined);
  assert.equal(result!.players["fff"], undefined);
  assert.equal(result!.players["zzz"], undefined, "zzz's only two candidate videos were v10 and v12, both excluded");
  assert.equal(result!.players["aquacorde"], undefined, "a blocked player earns no learned draw");

  // Pairs: ccc|ddd met twice (v5, 50 days ago; v7, 12 days ago) — the more recent one, v7, wins.
  assert.deepEqual(result!.pairs["ccc|ddd"], { lastRatio: 1, lastVideoId: "v7" });
  assert.deepEqual(result!.pairs["aaa|bbb"], { lastRatio: 0.8, lastVideoId: "v1" });
  assert.deepEqual(result!.pairs["fff|ggg"], { lastRatio: 1.4, lastVideoId: "v11" });
  assert.equal(result!.pairs["aquacorde|zzz"], undefined, "a blocked player's pair is never proven either");
  console.log("OK: recomputeDrawLearned — eligibility, median, n>=3, the most recent meeting wins");

  // --- The per-video cache: a second call with the same videos and a firstWeekViews that throws
  // for everything must still reproduce the same answer, purely from `videoViews` on disk.
  const throwing: DrawLearnDeps = {
    ...deps,
    firstWeekViews: async (videoId) => {
      throw new Error(`should never be asked again for ${videoId}`);
    },
  };
  const again = await recomputeDrawLearned(NOW, throwing);
  assert.deepEqual(again, result, "every video was already cached; no Analytics call needed");
  console.log("OK: a video's first-week views are cached forever, never re-fetched");

  // --- A new video appearing alongside an all-caches-plus-one-throwing deps: the new one fails
  // and is skipped (one log line), everything already cached is untouched.
  const uploadsPlusOne = [
    ...uploads,
    { matchId: 99, record: { videoId: "v99", publishAt: null, privacyStatus: "public", uploadedAt: iso(daysAgo(14)) } },
  ];
  const playersPlusOne = new Map(playersByMatch);
  playersPlusOne.set(99, ["aaa", "zzz"]);
  const failingNew: DrawLearnDeps = {
    uploads: async () => uploadsPlusOne,
    playersOf: async (matchId) => playersPlusOne.get(matchId) ?? null,
    firstWeekViews: async (videoId) => {
      if (videoId === "v99") throw new Error("boom");
      throw new Error(`should be cached: ${videoId}`);
    },
  };
  const lines = await silence(async () => {
    const withFailure = await recomputeDrawLearned(NOW, failingNew);
    assert.deepEqual(withFailure!.players["aaa"], result!.players["aaa"], "the cached players are unaffected");
    assert.equal(withFailure!.pairs["aaa|zzz"], undefined, "the one video that failed contributes nothing");
  });
  assert.equal(lines.length, 1, "one failing video logs once, not once per retry");
  assert.ok(lines[0]!.includes("v99"));
  console.log("OK: one video's Analytics failure is skipped and logged, not fatal to the rest");

  // --- Not configured (no YouTube token): the prior answer, untouched.
  process.env.YOUTUBE_TOKEN_FILE = path.join(media, "no-such-file.json");
  const unconfigured = await recomputeDrawLearned(NOW, deps);
  assert.deepEqual(unconfigured, result, "no token: the prior file stands, nothing recomputed");
  process.env.YOUTUBE_TOKEN_FILE = tokenFile;
  console.log("OK: with no YouTube token, recomputeDrawLearned returns the prior answer untouched");
}

// --- channelMedian 0 (every eligible video scored zero views so far): no division by zero, and
// the written file has empty players/pairs rather than NaN. --------------------------------------
{
  const zeroMedia = await mkdtemp(path.join(tmpdir(), "mcsr-draw-zero-"));
  config.mediaDir = zeroMedia;
  const deps: DrawLearnDeps = {
    uploads: async () => [
      { matchId: 1, record: { videoId: "z1", publishAt: null, privacyStatus: "public", uploadedAt: iso(daysAgo(10)) } },
    ],
    playersOf: async () => ["aaa", "bbb"],
    firstWeekViews: async () => 0,
  };
  const result = await recomputeDrawLearned(NOW, deps);
  assert.equal(result!.channelMedian, 0);
  assert.deepEqual(result!.players, {});
  assert.deepEqual(result!.pairs, {});
  console.log("OK: a zero channel median writes empty players/pairs, not NaN");
  await rm(zeroMedia, { recursive: true, force: true });
  config.mediaDir = media;
}

// --- drawLearnTick: off is a no-op; on, at most once a day -------------------------------------
{
  const saved = config.learnedDraw;

  config.learnedDraw = false;
  let calls = 0;
  await drawLearnTick(NOW, async () => {
    calls++;
    return null;
  });
  assert.equal(calls, 0, "off never even looks at the file");

  config.learnedDraw = true;
  await rm(filePath(), { force: true });
  await drawLearnTick(NOW, async () => {
    calls++;
    return null;
  });
  assert.equal(calls, 1, "on, nothing computed yet: recomputes");

  await writeFile(
    filePath(),
    JSON.stringify({ computedAt: NOW, channelMedian: 1, players: {}, pairs: {}, videoViews: {} }),
  );
  await drawLearnTick(NOW + 60_000, async () => {
    calls++;
    return null;
  });
  assert.equal(calls, 1, "a minute later, same day: still gated");

  await drawLearnTick(NOW + DAY + 60_000, async () => {
    calls++;
    return null;
  });
  assert.equal(calls, 2, "a day and a minute later: recomputes again");

  // A throwing recompute is caught, not propagated — one background tick must not take the
  // others on the same 15-minute cadence down with it.
  await rm(filePath(), { force: true });
  const lines = await silence(() =>
    drawLearnTick(NOW, async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes("boom"));

  config.learnedDraw = saved;
  console.log("OK: drawLearnTick — off is a no-op, on recomputes at most once a day, never throws");
}

if (realTokenFile === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
else process.env.YOUTUBE_TOKEN_FILE = realTokenFile;
await rm(media, { recursive: true, force: true });
console.log("drawLearn: ok");
