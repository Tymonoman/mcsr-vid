// Contract test for the nightly, written from the docs (CLAUDE.md "Nightly", "Tonight's queue",
// "Creator watch", "Restart only when idle", "Blocked players"; README "Most days nobody presses a
// button"; handbook/claude-md-reference.md "Nightly" and "Tonight's queue") before the source was
// read. Every assertion below pins one of these promises, through the public exports only:
//
//   N1  At `nightlyRenderHourUtc` (default 3 UTC) the nightly renders; `null` disables it — no
//       timer, no next date, no chain. Re-arming replaces the pending timer (two would render twice).
//   N2  Shipped defaults: one render a night (`nightlyMaxRenders` 1), the MP4 after it
//       (`nightlyRenderExport`), `playoffsFirst` off, creator watch off/empty, blocked players
//       Aquacorde and BeefSalad.
//   N3  With `nightlyMaxRenders` above 1 a CLEAN run starts the next card, within four hours of the
//       hour; a failed or aborted render chains nothing.
//   N4  The Studio worker's blackout covers the nightly's whole window (10 min lead-in, every
//       chained start, and the render that start runs), derived live from the hour.
//   N5  A candidate needs a known player — a favourite, a measured draw >= 0.6 (authoritative
//       either way), or Twitch followers >= `knownFollowerThreshold` (10,000, read live) —
//       unless the operator queued it; a playoff pick always counts.
//   N6  The block list outranks everything: the queue, the playoff exemption, any case.
//   N7  Tonight's queue renders ahead of the ranked pick and bypasses `nightlySkip` and the
//       known-player gate; a hidden queued id is skipped.
//   N8  A queued id gone from the ranked list is resolved from the scan's pool first, else ONE
//       `getMatch`; the polled preview never touches the network; a blocked one resolves to nothing.
//   N9  The nightly drops a queue entry the moment its render starts, and records "started".
//   N10 `nightlyNotifyUrl` gets one line on done / failed / aborted.
//   N11 "Skip tonight" (the strip records `nextScheduledRunDateUtc()`) skips exactly the scheduled
//       run it names — whatever the hour, across midnight — and clears.
//   N12 A pending Put on YouTube counts as busy for the nightly, the same as a render or an export
//       (CLAUDE.md "Re-render a match's thumbnails beside the live set").
//
// Not reachable through the public surface: the positive half of N3 (a "done" verdict needs a
// real pipeline — Remotion, ffmpeg, yt-dlp); the disk guard end to end (it reads the real
// filesystem's free space — pinned at `pickNightlyCandidate` level in nightly.test.ts); "a test
// server arms its own nightly" (server.ts).
//
// Hermetic: a scratch mediaDir per section, `fetch` replaced (the MCSR API and the notify URL never
// leave the process), no Chromium, no ffmpeg. Real match JSON comes from src/fixtures.
// Run: npx tsx src/dashboard/nightly.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, matchDir } from "../config.js";
import { capacity } from "./archive.js";
import { abortJob } from "./jobs.js";
import { CACHE_VERSION } from "./suggest.js";
import {
  nightlyQueue,
  setHidden,
  setNightlyQueue,
  setNightlySkip,
  setSkipNightOf,
  skipNightOf,
} from "./matchShelf.js";
import {
  isKnownPick,
  msUntilNextRun,
  nextScheduledRunDateUtc,
  nightlyArmedAtMs,
  nightlyChainRunning,
  nightlyEligible,
  pickContext,
  pickNightlyCandidate,
  previewPick,
  readNightlyState,
  resolveQueuedPick,
  runNightlyOnce,
  scheduleNightly,
  shouldChainNextRender,
  type NightlyPick,
} from "./nightly.js";
import { inBlackoutWindow } from "../youtube/studioWorker.js";
import { onVideo } from "../youtube/youtubeStore.js";

const HOUR = 3_600_000;
const MIDDAY = Date.parse("2026-10-14T12:00:00Z"); // 14:00 Warsaw: outside the NAS window, so no sweep
const NOTIFY = "http://notify.invalid/nightly";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

const deviations: string[] = [];
/** Keeps the docs' assertion as written; a mismatch is reported, not bent to the code. */
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    deviations.push(clause);
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const scratch: string[] = [];
function freshMedia(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mcsr-nightly-contract-"));
  assert.ok(dir.startsWith(tmpdir()), "refusing to run outside tmpdir");
  scratch.push(dir);
  config.mediaDir = dir;
  return dir;
}

const pick = (matchId: number, players: [string, string], bucket = "close"): NightlyPick => ({
  metrics: { matchId, players },
  bucket,
});
const ids = (p: NightlyPick | null): number | null => p?.metrics.matchId ?? null;

// --- fetch: the notify URL is captured, the MCSR API answers from fixtures or not at all ---------
const notified: string[] = [];
const apiCalls: string[] = [];
let api: (url: string) => Promise<Response> = async () => {
  throw new Error("offline in the test");
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(NOTIFY)) {
    notified.push(String(init?.body ?? ""));
    return new Response("ok");
  }
  apiCalls.push(url);
  return api(url);
}) as typeof fetch;
const fromFixtures = async (url: string): Promise<Response> => {
  const id = /\/matches\/(\d+)$/.exec(url)?.[1];
  const file = id ? path.join(FIXTURES, `match-${id}.json`) : "";
  if (!id || !existsSync(file)) return new Response("{}", { status: 404, statusText: "Not Found" });
  return new Response(JSON.stringify({ status: "success", data: JSON.parse(readFileSync(file, "utf8")) }));
};

const waitFor = async (cond: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), `timed out waiting for ${what}`);
};

const saved = { ...config };
try {
  /* --- N2: the shipped defaults (MCSR_CONFIG points nowhere, so config is DEFAULTS) ----------- */
  // A default that changes what tonight renders is the operator's call, never the code's: these
  // are the values the docs promise a box with no config file runs with.
  assert.equal(config.nightlyRenderHourUtc, 3, "the nightly fires at 03:00 UTC by default");
  assert.equal(config.nightlyMaxRenders, 1, "one render a night unless the operator raises it");
  assert.equal(config.nightlyRenderExport, true, "the night ends on a finished MP4, then the pick");
  assert.equal(config.playoffsFirst, false, "the bracket goes first only when the operator says so");
  assert.equal(config.creatorWatch, false, "creator watch is off by default");
  assert.deepEqual(config.creatorWatchlist, [], "and watches nobody");
  assert.deepEqual(config.blockedPlayers, ["Aquacorde", "BeefSalad"], "the two runners who withdrew");
  console.log("OK: N2 shipped defaults");

  /* --- N1: null disables; a re-arm replaces the timer ----------------------------------------- */
  {
    config.nightlyRenderHourUtc = null;
    assert.equal(nightlyArmedAtMs(), null, "disabled: the Settings panel shows nothing armed");
    assert.equal(nextScheduledRunDateUtc(MIDDAY), null, "disabled: there is no night to skip");
    assert.equal(shouldChainNextRender(1, 9, MIDDAY, null), false, "disabled: Run now is one render");

    // An hour 12 hours away, so the armed timer can never fire inside this test.
    const hour = (new Date().getUTCHours() + 12) % 24;
    config.nightlyRenderHourUtc = hour;
    const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const quiet = console.error;
    console.error = () => {};
    try {
      const before = timers();
      scheduleNightly({ notifyUrl: "" });
      assert.equal(timers(), before + 1, "armed: one timer");
      scheduleNightly({ notifyUrl: "" });
      assert.equal(timers(), before + 1, "re-armed: still one — two timers would render twice");
      const armed = nightlyArmedAtMs();
      assert.ok(armed !== null && armed - Date.now() > 11 * HOUR, "armed for the configured hour");
      config.nightlyRenderHourUtc = null;
      scheduleNightly({ notifyUrl: "" });
      assert.equal(timers(), before, "the Settings tab's null disarms the pending timer, no restart");
    } finally {
      config.nightlyRenderHourUtc = null;
      scheduleNightly({ notifyUrl: "" });
      console.error = quiet;
      config.nightlyRenderHourUtc = saved.nightlyRenderHourUtc;
    }
    console.log("OK: N1 null disables the nightly and a re-arm replaces its timer");
  }

  /* --- N3/N4: the chain window, and the Studio blackout that must cover it --------------------- */
  {
    // Across midnight: a 22:00 night may still chain at 01:59, not at 02:00.
    const night22 = Date.parse("2026-10-13T22:00:00Z");
    assert.equal(shouldChainNextRender(1, 2, night22 + 3 * HOUR + 59 * 60_000, 22), true, "01:59 is inside");
    assert.equal(shouldChainNextRender(1, 2, night22 + 4 * HOUR, 22), false, "02:00 is the morning");
    for (let hour = 0; hour < 24; hour++) {
      const base = Date.parse("2026-10-14T00:00:00Z") + hour * HOUR;
      // Chrome and ffmpeg share the lab's four cores: every minute a chained render may start, and
      // the ~21 min that render runs, must be inside the worker's blackout — derived from the hour.
      for (let m = 0; m < 4 * 60; m += 7) {
        const t = base + m * 60_000;
        assert.equal(shouldChainNextRender(1, 2, t, hour), true, `hour ${hour}: +${m} min may chain`);
        assert.equal(inBlackoutWindow(new Date(t), hour), true, `hour ${hour}: +${m} min is blacked out`);
        assert.equal(inBlackoutWindow(new Date(t + 21 * 60_000), hour), true, `hour ${hour}: its render too`);
      }
      assert.equal(inBlackoutWindow(new Date(base - 10 * 60_000), hour), true, `hour ${hour}: the lead-in`);
      assert.equal(shouldChainNextRender(1, 2, base + 4 * HOUR, hour), false, `hour ${hour}: 4 h closes it`);
    }
    console.log("OK: N3/N4 the chain window crosses midnight and the Studio blackout covers it");
  }

  /* --- N5: the known-player gate reads the scan's own cache ------------------------------------ */
  {
    const media = freshMedia();
    writeFileSync(
      path.join(media, ".suggest-cache.json"),
      JSON.stringify({
        version: CACHE_VERSION,
        twitchLogins: { StreamerTenK: "streamer_tenk", StreamerUnder: "streamer_under", romuxii: "romuxii" },
        twitchFollowers: {
          streamer_tenk: { count: 10_000, fetchedAt: 0 },
          streamer_under: { count: 9_999, fetchedAt: 0 },
          romuxii: { count: 50_000, fetchedAt: 0 },
        },
      }),
    );
    // The threshold is "10,000 followers", so exactly 10,000 is known and one fewer is not.
    assert.equal(isKnownPick(pick(1, ["StreamerTenK", "Nobody"])), true, "10,000 followers is known");
    assert.equal(isKnownPick(pick(2, ["StreamerUnder", "Nobody"])), false, "9,999 is not");
    // A Settings-tab change applies live (no restart): the gate reads the threshold each time.
    config.knownFollowerThreshold = 5_000;
    assert.equal(isKnownPick(pick(2, ["StreamerUnder", "Nobody"])), true, "the threshold is read live");
    config.knownFollowerThreshold = saved.knownFollowerThreshold;
    // A measured draw is authoritative either way (1 Oct 2026): it promotes a name with no
    // follower data and vetoes a follower count the channel's numbers say does not convert.
    assert.equal(isKnownPick(pick(3, ["hackingnoises", "Nobody"])), true, "draw 2.08, no Twitch data");
    assert.equal(isKnownPick(pick(4, ["romuxii", "Nobody"])), false, "draw 0.43 beats 50,000 followers");
    assert.equal(isKnownPick(pick(5, ["Nobody", "Feinberg"])), true, "a favourite on either side");
    // The bracket is the season's top 16, whose Twitch following is often unmeasured.
    assert.equal(isKnownPick(pick(6, ["SeedOne", "SeedTwo"], "playoffs")), true, "a playoff pick counts");
    console.log("OK: N5 the known-player gate: favourite, draw, followers (live), playoffs");
  }

  /* --- N6: the block outranks the queue and the playoff exemption, in any case ------------------ */
  {
    const eligible = nightlyEligible([7001, 7002, 7003], async () => true);
    assert.equal(
      await eligible(pick(7001, ["beefsalad", "Feinberg"], "queued")),
      false,
      "queued, with a favourite, and still never rendered: the shipped list, compared in any case",
    );
    assert.equal(
      await eligible(pick(7003, ["AQUACORDE", "SeedTwo"], "playoffs")),
      false,
      "a playoff pick 'always counts' as known — never as unblocked",
    );
    assert.equal(
      await eligible(pick(7002, ["NoNameA", "NoNameB"], "queued")),
      true,
      "queued no-names render",
    );
    assert.equal(
      await nightlyEligible([], async () => true)(pick(7004, ["SeedOne", "SeedTwo"], "playoffs")),
      true,
      "an unqueued playoff game of unknowns is eligible",
    );
    assert.equal(
      await nightlyEligible([], async () => true)(pick(7005, ["NoNameA", "NoNameB"])),
      false,
      "an unqueued no-name match is not",
    );
    console.log("OK: N6 the block list outranks the queue and the playoff exemption, any case");
  }

  /* --- N7: the queue through the shelf: ahead of the ranking, past nightlySkip, not past hidden -- */
  {
    freshMedia();
    setNightlySkip(7102, true); // the operator's "not at night" on a favourite's card
    setNightlyQueue([7101, 7104]);
    setHidden(7101, true); // queued, then hidden: hidden wins
    setNightlySkip(7104, true); // skipped after queueing: the queue still wins
    const ctx = { ...(await pickContext()), freeMatches: 9 };
    const ranked = [pick(7102, ["Feinberg", "NoNameA"]), pick(7103, ["Infume", "NoNameB"])];
    const resolve = async (id: number) => (id === 7101 ? pick(7101, ["Infume", "NoNameC"], "queued") : null);
    const ranked7104 = [...ranked, pick(7104, ["NoNameD", "NoNameE"])];
    assert.equal(
      ids(
        await pickNightlyCandidate(
          ranked7104,
          ctx,
          nightlyEligible(ctx.queue ?? [], async () => true),
          resolve,
        ),
      ),
      7104,
      "hidden queued id skipped; the next queued no-name renders ahead of two favourites, nightlySkip or not",
    );
    setNightlyQueue([7101]);
    const ctx2 = { ...(await pickContext()), freeMatches: 9 };
    assert.equal(
      ids(
        await pickNightlyCandidate(
          ranked,
          ctx2,
          nightlyEligible(ctx2.queue ?? [], async () => true),
          resolve,
        ),
      ),
      7103,
      "with the queue spent, the favourite marked 'not at night' is passed over for the next card",
    );
    console.log("OK: N7 the queue goes first, past nightlySkip and the known gate, never past hidden");
  }

  /* --- N8: a queued id off the list — pool first, else one getMatch; the preview never fetches -- */
  {
    const media = freshMedia();
    api = fromFixtures;
    apiCalls.length = 0;
    // 13617328 is a real ranked match (two players with no follower data in this cache).
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES, "match-13617328.json"), "utf8")) as {
      players: { nickname: string }[];
    };
    const resolved = await resolveQueuedPick(13617328);
    assert.deepEqual(
      resolved,
      pick(13617328, [fixture.players[0]!.nickname, fixture.players[1]!.nickname], "queued"),
      "the operator's pick is resolved, not silently dropped",
    );
    await resolveQueuedPick(13617328);
    assert.deepEqual(
      apiCalls.filter((u) => u.endsWith("/matches/13617328")),
      ["https://api.mcsrranked.com/matches/13617328"],
      "at most one request per such id",
    );
    // 13549300 is a real match with a runner on the shipped block list.
    assert.equal(await resolveQueuedPick(13549300), null, "a blocked match resolves to nothing");
    assert.equal(await resolveQueuedPick(990404), null, "an unreadable id is skipped, not thrown");

    // The run end to end: only the blocked id and an unreadable one are queued. Nothing starts,
    // and neither is dropped from the queue — an entry leaves only when its render starts.
    setNightlyQueue([13549300, 990404]);
    const run = await runNightlyOnce("", {
      renderInFlight: () => false,
      ranked: async () => [],
      now: () => MIDDAY,
    });
    assert.match(run.skipped ?? "", /no known player/, "nothing eligible says why");
    assert.equal(run.matchId, undefined, "the blocked queued match was not rendered");
    assert.deepEqual(nightlyQueue(), [13549300, 990404], "nothing started, nothing dropped");

    // The polled preview: pool only, the block applied, no network at all.
    writeFileSync(
      path.join(media, ".suggest-cache.json"),
      JSON.stringify({
        version: CACHE_VERSION,
        pool: {
          "9101": { metrics: { matchId: 9101, players: ["BeefSalad", "Feinberg"] } },
          "9102": { metrics: { matchId: 9102, players: ["PoolOne", "PoolTwo"] } },
        },
      }),
    );
    apiCalls.length = 0;
    const roomy = { processedIds: [], hiddenIds: new Set<number>(), freeMatches: 9 };
    const rankedList = [pick(9110, ["SeedOne", "SeedTwo"], "playoffs"), pick(9111, ["Feinberg", "x"])];
    assert.equal(
      ids(await previewPick(rankedList, { ...roomy, queue: [9101, 9999, 9102] })),
      9102,
      "blocked pooled 9101 left out, unpooled 9999 left out, pooled 9102 shown",
    );
    assert.equal(
      ids(await previewPick(rankedList, { ...roomy, queue: [9101] })),
      9110,
      "with nothing queued that may render, the playoff game of unknowns leads",
    );
    assert.deepEqual(apiCalls, [], "the preview never calls the network");
    console.log("OK: N8 a queued id resolves from the pool or one getMatch; the preview never fetches");
  }

  /* --- N9/N10/N3: a real run — the queue entry goes, "started" is recorded, the push is one line,
     and a failed or aborted render chains nothing even with nightlyMaxRenders 2 ------------------ */
  {
    freshMedia();
    const free = (await capacity()).working?.matchesLeft ?? 0;
    assert.ok(free >= 2, `the scratch disk has room for the run (${free} matches free)`);
    // afterSettled polls a render every 30 s; shortened so the test does not sit out the wait.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
      realSetTimeout(fn, ms === 30_000 ? 5 : ms, ...rest)) as unknown as typeof setTimeout;
    try {
      config.nightlyMaxRenders = 2;
      // The chain check reads the real clock against the configured hour: make it this hour.
      config.nightlyRenderHourUtc = new Date().getUTCHours();
      assert.equal(shouldChainNextRender(1, 2, Date.now(), config.nightlyRenderHourUtc), true, "window open");
      notified.length = 0;
      apiCalls.length = 0;
      api = async () => {
        throw new Error("offline in the test");
      };
      let rankedCalls = 0;
      const deps = {
        renderInFlight: () => false,
        ranked: async () => {
          rankedCalls++;
          return [pick(990003, ["Feinberg", "NoNameA"])];
        },
        resolveQueued: async (id: number) => pick(id, ["QueueLeft", "QueueRight"], "queued"),
        now: () => MIDDAY,
      };

      setNightlyQueue([990001]);
      const started = await runNightlyOnce(NOTIFY, deps);
      assert.deepEqual(started, { matchId: 990001, players: ["QueueLeft", "QueueRight"] }, "the queued pick");
      assert.deepEqual(nightlyQueue(), [], "dropped from the queue the moment its render starts");
      assert.equal(readNightlyState()?.outcome, "started", "a restart mid-render leaves 'started'");
      assert.equal(readNightlyState()?.matchId, 990001);
      await waitFor(() => notified.length === 1, "the failed render's push");
      assert.match(notified[0]!, /^Rendered #990001 QueueLeft vs QueueRight — failed: .*offline in the test/);
      assert.ok(!notified[0]!.includes("\n"), `one line: ${JSON.stringify(notified[0])}`);
      assert.equal(readNightlyState()?.outcome, "failed", "state and push agree");
      assert.equal(readNightlyState()?.export, "skipped", "a failed render is not encoded");
      assert.equal(rankedCalls, 1, "a failed render does not chain, even with a second render allowed");
      assert.equal(nightlyChainRunning(), false, "and the chain flag is down for restart-when-idle");

      // Aborted (Stop on the dashboard) is not a clean run either.
      let release!: () => void;
      api = () => new Promise((_, reject) => (release = () => reject(new Error("socket closed"))));
      setNightlyQueue([990004]);
      rankedCalls = 0;
      assert.equal((await runNightlyOnce(NOTIFY, deps)).matchId, 990004);
      abortJob(990004);
      release();
      await waitFor(() => notified.length === 2, "the aborted render's push");
      assert.equal(
        notified[1],
        "Rendered #990004 QueueLeft vs QueueRight — aborted",
        "one line, the verdict",
      );
      assert.equal(readNightlyState()?.outcome, "aborted");
      assert.equal(rankedCalls, 1, "an aborted render does not chain");
      assert.equal(nightlyChainRunning(), false);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      config.nightlyMaxRenders = saved.nightlyMaxRenders;
      config.nightlyRenderHourUtc = saved.nightlyRenderHourUtc;
    }
    console.log("OK: N9/N10/N3 the run drops its queue entry, pushes one line, chains only a clean run");
  }

  /* --- N11: "Skip tonight" names exactly the scheduled run it skips, at any hour --------------- */
  {
    freshMedia();
    const cases: [string, number][] = [
      ["2026-10-14T01:00:00Z", 3], // pressed before tonight's 03:00
      ["2026-10-13T22:00:00Z", 3], // pressed the evening before
      ["2026-10-13T23:30:00Z", 0], // a midnight nightly, pressed half an hour before it
      ["2026-10-14T00:30:00Z", 23], // just after midnight, for the 23:00 run
      ["2026-10-14T03:00:00Z", 3], // pressed on the hour: that run has fired, so tomorrow's
    ];
    for (const [press, hour] of cases) {
      config.nightlyRenderHourUtc = hour;
      const pressMs = Date.parse(press);
      setSkipNightOf(nextScheduledRunDateUtc(pressMs)); // what the strip's PUT records
      const fireMs = pressMs + msUntilNextRun(pressMs, hour);
      const out = await runNightlyOnce("", {
        scheduled: true,
        now: () => fireMs,
        renderInFlight: () => false,
        ranked: async () => [],
      });
      assert.equal(out.skipped, "skipped by the operator", `${press}, hour ${hour}: that run is skipped`);
      assert.equal(skipNightOf(), null, `${press}, hour ${hour}: once, then cleared`);
    }
    config.nightlyRenderHourUtc = saved.nightlyRenderHourUtc;
    console.log("OK: N11 Skip tonight skips the very run the strip named, across midnight");
  }

  /* --- N12: a pending Put on YouTube is busy for the nightly ------------------------------------ */
  {
    freshMedia();
    mkdirSync(matchDir(990010));
    let finishPut!: () => void;
    const put = onVideo(990010, () => new Promise<void>((r) => (finishPut = r)));
    const out = await runNightlyOnce("", { ranked: async () => [], now: () => MIDDAY });
    finishPut();
    await put;
    deviation("A re-render or a pending put counts as busy for restart-when-idle and the nightly", () => {
      assert.equal(out.busy, true, `observed ${JSON.stringify(out)}`);
    });
    console.log("OK: N12 checked (a pending put against the nightly's busy check)");
  }

  if (deviations.length) console.log(`nightly.contract: ${deviations.length} deviation(s) noted for triage`);
  console.log("nightly.contract: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  Object.assign(config, saved);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
}
