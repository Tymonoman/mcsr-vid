// Self-check for fastTrack.ts: which matches are "really good" enough to jump the nightly's
// clock, the once-a-day cap, and that a candidate is skipped (not fatal) when its VODs cannot be
// found. No network and no real pipeline: `checkVods` is a fake and `startRender` is injected so
// a "render started" is a fake, already-settled Job — a render running for real belongs to
// pipeline.test.ts, not here.
// Run: npx tsx src/dashboard/fastTrack.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { MatchMetrics } from "../pipeline/matchScore.js";
import { CACHE_VERSION, type PooledMatch } from "./suggest.js";
import {
  FAST_TRACK_CLOSE_MS,
  FAST_TRACK_SUB_EIGHT_MS,
  FAST_TRACK_WINDOW_MS,
  FEINFUME_CLOSE_MS,
  FEINFUME_SUB_MS,
  fastTrackTick,
  isReallyGood,
  readFastTrackState,
} from "./fastTrack.js";
import type { Job } from "./jobs.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-fasttrack-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
// chainExport would otherwise try a real ffmpeg encode once the fake job settles "done".
config.nightlyRenderExport = false;
const cachePath = path.join(media, ".suggest-cache.json");

const known = (players: readonly [string, string]): boolean => players.includes("KnownOne");

/** A render that "started" and immediately settled clean — afterSettled's first poll sees
 *  `done` already true, so nothing here ever waits on a timer or touches the network. */
const startedRenders: number[] = [];
const fakeStartRender = (matchId: number): Job => {
  startedRenders.push(matchId);
  return {
    matchId,
    events: [],
    done: true,
    error: null,
    errorStage: null,
    aborted: false,
    subscribers: new Set(),
    controller: new AbortController(),
  };
};

try {
  /* --- isReallyGood: a known pair's sub-5s/sub-8 finish, or Feinberg/Infume's tighter rule ----- */
  const metrics = (
    players: [string, string],
    finishMarginMs: number | null,
    resultMs: number,
  ): Pick<MatchMetrics, "players" | "finishMarginMs" | "resultMs"> => ({ players, finishMarginMs, resultMs });

  assert.equal(
    isReallyGood(metrics(["KnownOne", "Stranger"], FAST_TRACK_CLOSE_MS - 1, 500_000), known),
    true,
    "a known pair under the close threshold",
  );
  assert.equal(
    isReallyGood(metrics(["KnownOne", "Stranger"], FAST_TRACK_CLOSE_MS, 500_000), known),
    false,
    "exactly at the threshold does not count (strictly under)",
  );
  assert.equal(
    isReallyGood(metrics(["KnownOne", "Stranger"], null, FAST_TRACK_SUB_EIGHT_MS), known),
    true,
    "a known pair's sub-8 finish, no margin needed",
  );
  assert.equal(
    isReallyGood(metrics(["Stranger", "Stranger2"], 1, 400_000), known),
    false,
    "no known player: not good enough, however close",
  );
  assert.equal(
    isReallyGood(metrics(["Feinberg", "Infume"], FEINFUME_CLOSE_MS, FEINFUME_SUB_MS - 1), known),
    true,
    "Feinberg vs Infume, 1s margin, under 9:00 — the tighter named-pair rule",
  );
  assert.equal(
    isReallyGood(metrics(["Feinberg", "Infume"], FEINFUME_CLOSE_MS + 1, FEINFUME_SUB_MS - 1), known),
    false,
    "Feinberg vs Infume over 1s does not qualify on its own (not under the general 5s/known gate either)",
  );
  assert.equal(
    isReallyGood(metrics(["Feinberg", "Infume"], FEINFUME_CLOSE_MS, FEINFUME_SUB_MS), known),
    false,
    "Feinberg vs Infume at exactly 9:00 does not clear 'under 9:00'",
  );
  console.log("OK: isReallyGood — known pair sub-5s/sub-8, or Feinberg/Infume's tighter named rule");

  /* --- The tick: pool -> VOD check -> render, once a day, skipping what fails the VOD check ---- */
  // fastTrackTick reads its own "known" off config.favouritePlayers (the real knownTierFor), not
  // the stub above — so "KnownOne" has to actually be on the roster for these.
  config.favouritePlayers = ["KnownOne"];
  const nowMs = Date.parse("2026-10-18T12:00:00Z");
  const nowSec = Math.floor(nowMs / 1000);
  const pooled = (
    matchId: number,
    players: [string, string],
    finishMarginMs: number | null,
    resultMs: number,
    hoursAgo: number,
  ): PooledMatch => ({
    metrics: {
      matchId,
      players,
      winner: players[0],
      resultMs,
      splits: [],
      finishMarginMs,
      finishEstimated: false,
      splitsWithin3s: 0,
      comparedSplits: 0,
      maxLeadMs: 0,
      leadChanges: 0,
      panelLeadChanges: 0,
      maxSwingMs: 0,
      deaths: 0,
      deathsByPlayer: {},
    },
    profiles: players.map((nickname) => ({ nickname, eloRank: null, elo: null })) as PooledMatch["profiles"],
    h2h: null,
    vodUrls: [],
    dateSec: nowSec - hoursAgo * 3600,
    scoredAt: Date.now(),
  });
  const writePool = (entries: PooledMatch[]): void => {
    const pool = Object.fromEntries(entries.map((e) => [String(e.metrics.matchId), e]));
    writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION, pool }, null, 2));
  };

  // Too old: outside the 48h window, never considered at all (not even a VOD check).
  {
    writePool([pooled(1, ["KnownOne", "Stranger"], 0, 400_000, FAST_TRACK_WINDOW_MS / 3_600_000 + 1)]);
    let asked = 0;
    await fastTrackTick(nowMs, { checkVods: async () => ((asked += 1), true), startRender: fakeStartRender });
    assert.equal(asked, 0, "outside the 48h window: never even a VOD check");
    assert.equal(readFastTrackState().lastDate, null, "and nothing fast-tracked");
  }

  // Not good enough: a no-name match, however close.
  {
    writePool([pooled(2, ["Stranger", "Stranger2"], 0, 400_000, 1)]);
    let asked = 0;
    await fastTrackTick(nowMs, { checkVods: async () => ((asked += 1), true), startRender: fakeStartRender });
    assert.equal(asked, 0, "not a known pair: never reaches the VOD check");
  }

  // Good enough, but the VODs cannot be found: skipped, not fatal, no state written.
  {
    writePool([pooled(3, ["KnownOne", "Stranger"], 0, 400_000, 1)]);
    await fastTrackTick(nowMs, { checkVods: async () => false, startRender: fakeStartRender });
    assert.equal(readFastTrackState().lastDate, null, "a VOD-less match is skipped, not fast-tracked");
  }

  // A VOD check that throws is also just a skip for that candidate, not a crash of the tick.
  {
    writePool([pooled(4, ["KnownOne", "Stranger"], 0, 400_000, 1)]);
    await assert.doesNotReject(
      fastTrackTick(nowMs, {
        checkVods: async () => {
          throw new Error("yt-dlp exploded");
        },
        startRender: fakeStartRender,
      }),
    );
    assert.equal(readFastTrackState().lastDate, null);
  }

  // Newest first: of two really-good candidates, the fresher one is picked.
  {
    writePool([
      pooled(5, ["KnownOne", "Stranger"], 0, 400_000, 40), // older
      pooled(6, ["KnownOne", "Stranger2"], 0, 400_000, 2), // newer
    ]);
    const checked: number[] = [];
    startedRenders.length = 0;
    await fastTrackTick(nowMs, {
      checkVods: async (id) => {
        checked.push(id);
        return true;
      },
      startRender: fakeStartRender,
    });
    assert.deepEqual(checked, [6], "the newer match is tried first, and it is the only one needed");
    const state = readFastTrackState();
    assert.equal(state.lastDate, "2026-10-18");
    assert.equal(state.hits.at(-1)?.matchId, 6);
    assert.deepEqual(startedRenders, [6], "a render was actually requested");
  }

  // Already spent today: a second, otherwise-perfect candidate does not start a second render.
  {
    writePool([pooled(7, ["KnownOne", "Stranger3"], 0, 400_000, 1)]);
    let asked = 0;
    startedRenders.length = 0;
    await fastTrackTick(nowMs, { checkVods: async () => ((asked += 1), true), startRender: fakeStartRender });
    assert.equal(asked, 0, "the day's one fast-track is already spent");
    assert.deepEqual(startedRenders, [], "nothing new started");
  }

  // A later UTC day frees the budget again.
  {
    writePool([pooled(8, ["KnownOne", "Stranger4"], 0, 400_000, 1)]);
    const tomorrow = nowMs + 24 * 3_600_000;
    await fastTrackTick(tomorrow, { checkVods: async () => true, startRender: fakeStartRender });
    assert.equal(readFastTrackState().lastDate, "2026-10-19", "a new UTC day, a new budget");
  }

  // Blocked and already-processed candidates never reach the VOD check either — a third, fresh
  // UTC day so neither case is masked by the previous day's spent budget.
  {
    const thirdDay = nowMs + 2 * 24 * 3_600_000 + 3_600_000; // 2026-10-20
    const savedBlocked = config.blockedPlayers;
    config.blockedPlayers = ["Stranger5"];
    writePool([pooled(9, ["KnownOne", "Stranger5"], 0, 400_000, 1)]);
    let asked = 0;
    try {
      await fastTrackTick(thirdDay, {
        checkVods: async () => ((asked += 1), true),
        startRender: fakeStartRender,
      });
    } finally {
      config.blockedPlayers = savedBlocked;
    }
    assert.equal(asked, 0, "a blocked player's match is never even VOD-checked");
    assert.equal(readFastTrackState().lastDate, "2026-10-19", "today's budget is still unspent (not today)");

    mkdirSync(path.join(media, "10"), { recursive: true });
    writePool([pooled(10, ["KnownOne", "Stranger6"], 0, 400_000, 1)]);
    let asked2 = 0;
    await fastTrackTick(thirdDay, {
      checkVods: async () => ((asked2 += 1), true),
      startRender: fakeStartRender,
    });
    assert.equal(asked2, 0, "a match with a working directory already is never re-fast-tracked");
  }

  console.log("fastTrack: all checks passed");
} finally {
  await rm(media, { recursive: true, force: true });
}
