// Contract test for creator watch, written from the docs (CLAUDE.md "Tonight's queue ... Creator
// watch"; handbook/claude-md-reference.md "Creator watch") before the source was read. The promises:
//
//   C1  Off and empty by default: with the shipped config the tick spends no API call at all.
//   C2  Each watched nickname costs one `getUserMatches` call for its few most recent RANKED
//       matches, at most once per 15 minutes; a failing name costs the rest of the tick nothing.
//   C3  A new match with both Twitch VODs goes to the FRONT of tonight's queue, ahead of the
//       operator's own picks — and from there the nightly renders it, known players or not, even
//       with only the probe's vods.json in its directory.
//   C4  The block list still wins: a blocked runner's match is never probed or queued (any case),
//       and a match queued before its runner was blocked is still never rendered.
//   C5  At most one creator match a night, even when two watched creators both have one.
//   C6  Every outcome is resolved once, ever (a match two watched creators share is probed once),
//       into `.creator-watch.json` — atomic write, defensive read.
//
// The live VOD check (`liveDeps().checkVods`) shells out to yt-dlp, so C3-C6 inject `checkVods`;
// the list call (C1, C2) goes through the real `liveDeps()` against a mocked fetch.
// Run: npx tsx src/dashboard/creatorWatch.contract.test.ts
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, matchDir } from "../config.js";
import type { FeedMatch } from "../api/types.js";
import { nightlyQueue, setNightlyQueue } from "./matchShelf.js";
import { nightlyEligible, pickContext, pickNightlyCandidate, type NightlyPick } from "./nightly.js";
import {
  CHECK_INTERVAL_MS,
  creatorWatchTick,
  liveDeps,
  readCreatorWatchState,
  type CreatorWatchDeps,
} from "./creatorWatch.js";

const scratch: string[] = [];
function freshMedia(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mcsr-creatorwatch-contract-"));
  assert.ok(dir.startsWith(tmpdir()), "refusing to run outside tmpdir");
  scratch.push(dir);
  config.mediaDir = dir;
  return dir;
}

const player = (nickname: string) => ({
  uuid: `u-${nickname}`,
  nickname,
  roleType: 0,
  eloRate: null,
  eloRank: null,
  country: null,
});
// No result in the test data: the watch never reads one, and nothing here should name a winner.
const feedMatch = (id: number, a: string, b: string): FeedMatch =>
  ({ id, type: 2, players: [player(a), player(b)], vod: [] }) as unknown as FeedMatch;

/** Fakes for the two calls, recording what each was asked; `checkVods` leaves the probe's
 *  vods.json behind the way the pipeline's own discovery does. */
function fakes(feeds: Record<string, FeedMatch[] | Error>, vods: Record<number, boolean>) {
  const listed: string[] = [];
  const probed: number[] = [];
  const deps: CreatorWatchDeps = {
    listMatches: async (nick) => {
      listed.push(nick);
      const feed = feeds[nick] ?? [];
      if (feed instanceof Error) throw feed;
      return feed;
    },
    checkVods: async (id) => {
      probed.push(id);
      mkdirSync(matchDir(id), { recursive: true });
      writeFileSync(path.join(matchDir(id), "vods.json"), "[]");
      return vods[id] ?? false;
    },
  };
  return { deps, listed, probed };
}

const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  fetched.push(String(input instanceof Request ? input.url : input));
  return new Response(JSON.stringify({ status: "success", data: [] }));
}) as typeof fetch;

const saved = { ...config };
const quiet = console.error;
try {
  /* --- C1: the shipped config spends nothing ---------------------------------------------------- */
  {
    freshMedia();
    assert.equal(config.creatorWatch, false);
    assert.deepEqual(config.creatorWatchlist, []);
    await creatorWatchTick(); // the live deps, the real clock: exactly what server.ts's tick calls
    assert.deepEqual(fetched, [], "off by default: not one request");
    assert.equal(existsSync(path.join(config.mediaDir, ".creator-watch.json")), false, "and nothing written");
    console.log("OK: C1 off and empty by default costs no API call");
  }

  /* --- C2: one ranked list call per name per 15 minutes; a bad name costs nothing else --------- */
  {
    freshMedia();
    config.creatorWatch = true;
    config.creatorWatchlist = ["Some Creator"];
    const t0 = Date.parse("2026-10-14T10:00:00Z");
    await creatorWatchTick(t0, liveDeps());
    assert.equal(fetched.length, 1, "one list call for one name");
    const url = new URL(fetched[0]!);
    assert.equal(url.pathname, "/users/Some%20Creator/matches", "the watched nickname's own matches");
    assert.equal(url.searchParams.get("type"), "2", "ranked matches only");
    assert.ok(Number(url.searchParams.get("count")) <= 5, "a few most recent, not a page of 100");
    await creatorWatchTick(t0 + CHECK_INTERVAL_MS - 1, liveDeps());
    assert.equal(fetched.length, 1, "not again inside 15 minutes");
    await creatorWatchTick(t0 + CHECK_INTERVAL_MS, liveDeps());
    assert.equal(fetched.length, 2, "and again once they are up");

    // A typo'd or dead account logs one line; the next name is still checked, and the bad one is
    // not hammered every tick either.
    config.creatorWatchlist = ["NoSuchAccount", "WatchedA"];
    const t1 = Date.parse("2026-10-14T11:00:00Z");
    const { deps, listed, probed } = fakes(
      { NoSuchAccount: new Error("404 Not Found"), WatchedA: [feedMatch(5101, "WatchedA", "NoNameA")] },
      { 5101: true },
    );
    console.error = () => {};
    await creatorWatchTick(t1, deps);
    await creatorWatchTick(t1 + 60_000, deps);
    console.error = quiet;
    assert.deepEqual(listed, ["NoSuchAccount", "WatchedA"], "both asked once, neither again a minute later");
    assert.deepEqual(probed, [5101], "the good name's match was still probed");
    assert.deepEqual(nightlyQueue(), [5101], "and queued");
    console.log("OK: C2 one ranked list call per name per 15 min; a failing name costs the tick nothing");
  }

  /* --- C3: found -> the FRONT of tonight's queue -> the nightly renders it --------------------- */
  {
    freshMedia();
    config.creatorWatchlist = ["WatchedA"];
    setNightlyQueue([5299]); // the operator's own pick for tonight
    const { deps } = fakes({ WatchedA: [feedMatch(5201, "WatchedA", "NoNameA")] }, { 5201: true });
    await creatorWatchTick(Date.parse("2026-10-14T12:00:00Z"), deps);
    assert.deepEqual(nightlyQueue(), [5201, 5299], "the front, the operator's pick kept behind it");
    assert.deepEqual(
      readdirSync(matchDir(5201)),
      ["vods.json"],
      "the probe's vods.json is kept for the render",
    );

    // The nightly side: neither player is known, no project exists — it renders anyway, first.
    const ctx = { ...(await pickContext()), freeMatches: 9 };
    assert.ok(!ctx.processedIds.includes(5201), "a vods.json alone is not 'processed'");
    const ranked: NightlyPick[] = [
      { metrics: { matchId: 5300, players: ["Feinberg", "Infume"] }, bucket: "known" },
    ];
    const resolve = async (id: number): Promise<NightlyPick | null> =>
      id === 5201 ? { metrics: { matchId: 5201, players: ["WatchedA", "NoNameA"] }, bucket: "queued" } : null;
    const chosen = await pickNightlyCandidate(
      ranked,
      ctx,
      nightlyEligible(ctx.queue ?? [], async () => true),
      resolve,
    );
    assert.equal(
      chosen?.metrics.matchId,
      5201,
      "tonight's render is the creator's match, ahead of two favourites",
    );
    console.log("OK: C3 a found creator match goes to the front of the queue and the nightly renders it");

    /* --- C4 (second half): blocked after it was queued -> still never rendered ----------------- */
    config.blockedPlayers = [...saved.blockedPlayers, "nonamea"]; // the opponent withdraws, any case
    const after = await pickNightlyCandidate(
      ranked,
      ctx,
      nightlyEligible(ctx.queue ?? [], async () => true),
      resolve,
    );
    assert.notEqual(after?.metrics.matchId, 5201, "the block outranks a creator-watch queue entry");
    config.blockedPlayers = saved.blockedPlayers;
  }

  /* --- C4: a blocked runner's match is never probed, recorded or queued (any case) ------------- */
  {
    freshMedia();
    config.creatorWatchlist = ["WatchedA"];
    const { deps, probed } = fakes({ WatchedA: [feedMatch(5401, "WatchedA", "beefsalad")] }, { 5401: true });
    await creatorWatchTick(Date.parse("2026-10-14T12:00:00Z"), deps);
    assert.deepEqual(probed, [], "no VOD discovery spent on a blocked runner's footage");
    assert.deepEqual(nightlyQueue(), [], "not queued");
    assert.equal(existsSync(matchDir(5401)), false, "no directory");
    assert.equal(readCreatorWatchState().hits.length, 0, "and not even a hit line");
    console.log("OK: C4 the block list wins over creator watch, before and after queueing");
  }

  /* --- C5/C6: one a night across two creators; a shared match probed once ---------------------- */
  {
    freshMedia();
    config.creatorWatchlist = ["WatchedA", "WatchedB"];
    const shared = feedMatch(5501, "WatchedA", "WatchedB");
    const { deps, probed } = fakes(
      { WatchedA: [shared], WatchedB: [shared, feedMatch(5502, "WatchedB", "NoNameB")] },
      { 5501: true, 5502: true },
    );
    await creatorWatchTick(Date.parse("2026-10-14T12:00:00Z"), deps);
    assert.deepEqual(probed, [5501, 5502], "the match both creators played is probed once, not twice");
    assert.deepEqual(nightlyQueue(), [5501], "two ready matches, one creator match tonight");
    const hits = readCreatorWatchState().hits;
    assert.equal(hits.filter((h) => h.matchId === 5501).length, 1, "and recorded once");
    assert.match(hits.find((h) => h.matchId === 5502)?.reason ?? "", /already queued/, "the other says why");
    assert.equal(existsSync(matchDir(5502)), false, "the loser of the night leaves no directory behind");
    console.log("OK: C5/C6 one creator match a night across creators; a shared match resolved once");
  }

  /* --- C5: "a night" is the nightly's night, not a UTC calendar day ---------------------------- */
  {
    freshMedia();
    config.creatorWatchlist = ["WatchedA"];
    const { deps } = fakes(
      { WatchedA: [feedMatch(5601, "WatchedA", "NoNameA"), feedMatch(5602, "WatchedA", "NoNameB")] },
      { 5601: true, 5602: false },
    );
    // 23:50 UTC: the first match is found and queued for the 03:00 UTC render.
    await creatorWatchTick(Date.parse("2026-10-13T23:50:00Z"), deps);
    // 00:05 UTC, the same night: a second ready match turns up before that same 03:00 render.
    const { deps: deps2 } = fakes(
      { WatchedA: [feedMatch(5601, "WatchedA", "NoNameA"), feedMatch(5603, "WatchedA", "NoNameC")] },
      { 5603: true },
    );
    await creatorWatchTick(Date.parse("2026-10-14T00:05:00Z"), deps2);
    const creatorQueued = nightlyQueue().filter((id) => id === 5601 || id === 5603);
    assert.ok(
      creatorQueued.length <= 1,
      `two creator matches queued ahead of the same 03:00 UTC render: ${JSON.stringify(nightlyQueue())}`,
    );
    assert.deepEqual(nightlyQueue(), [5601], "the first one keeps the night's slot");
    console.log("OK: C5 checked across UTC midnight");
  }

  /* --- C5: the night after a 00:00-03:00 claim is a new night, not "already queued" ------------ */
  {
    freshMedia();
    config.creatorWatchlist = ["WatchedA"];
    const { deps } = fakes({ WatchedA: [feedMatch(5701, "WatchedA", "NoNameA")] }, { 5701: true });
    // 02:00 UTC: queued for the 03:00 render the same UTC day.
    await creatorWatchTick(Date.parse("2026-10-14T02:00:00Z"), deps);
    assert.deepEqual(nightlyQueue(), [5701]);
    setNightlyQueue([]); // the 03:00 render took it off the queue
    // 21:00 UTC, still 14 Oct: this one belongs to the 15 Oct 03:00 run, whose slot is free.
    const { deps: deps2 } = fakes(
      { WatchedA: [feedMatch(5701, "WatchedA", "NoNameA"), feedMatch(5702, "WatchedA", "NoNameB")] },
      { 5702: true },
    );
    await creatorWatchTick(Date.parse("2026-10-14T21:00:00Z"), deps2);
    assert.deepEqual(nightlyQueue(), [5702], "the next night's slot is not taken by last night's match");
    assert.equal(readCreatorWatchState().hits.find((h) => h.matchId === 5702)?.queued, true);
    console.log("OK: C5 a claim between 00:00 and 03:00 UTC does not take the next night's slot");
  }

  /* --- C6: defensive read, atomic write ----------------------------------------------------------- */
  {
    const media = freshMedia();
    config.creatorWatchlist = ["WatchedA"];
    writeFileSync(path.join(media, ".creator-watch.json"), "{ truncated");
    const { deps, listed } = fakes({ WatchedA: [] }, {});
    await creatorWatchTick(Date.parse("2026-10-14T12:00:00Z"), deps);
    assert.deepEqual(listed, ["WatchedA"], "a corrupt state file reads as 'nothing checked yet'");
    const state = JSON.parse(readFileSync(path.join(media, ".creator-watch.json"), "utf8")) as {
      checked: Record<string, string>;
    };
    assert.equal(state.checked.WatchedA, "2026-10-14T12:00:00.000Z", "and is rewritten whole");
    assert.deepEqual(
      readdirSync(media).filter((f) => f.startsWith(".creator-watch")),
      [".creator-watch.json"],
      "no temp file left behind by the write-then-rename",
    );
    console.log("OK: C6 a corrupt state file is survived and rewritten atomically");
  }

  console.log("creatorWatch.contract: all checks passed");
} finally {
  console.error = quiet;
  globalThis.fetch = realFetch;
  Object.assign(config, saved);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
}
