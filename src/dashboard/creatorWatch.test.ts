// Self-check for creatorWatch.ts: which matches count as a hit, what gets queued and when,
// the once-ever resolution (never re-spends a VOD check on a match already recorded), and the
// one-creator-match-a-night cap. Nothing here touches the network: `listMatches`/`checkVods` are
// fakes; the media directory is a scratch one.
// Run: npx tsx src/dashboard/creatorWatch.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { FeedMatch } from "../api/types.js";
import { hiddenMatchIds, nightlyQueue, setHidden, setNightlyQueue } from "./matchShelf.js";
import {
  CHECK_INTERVAL_MS,
  creatorWatchSince,
  creatorWatchTick,
  dueNicknames,
  isWatchCandidate,
  readCreatorWatchState,
  type CreatorWatchDeps,
} from "./creatorWatch.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-creatorwatch-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
const savedWatch = config.creatorWatch;
const savedList = config.creatorWatchlist;
const savedBlocked = config.blockedPlayers;

const player = (nickname: string) => ({
  uuid: `u-${nickname}`,
  nickname,
  roleType: 0,
  eloRate: null,
  eloRank: null,
  country: null,
});
const feedMatch = (id: number, a: string, b: string): FeedMatch => ({
  id,
  type: 2,
  season: 12,
  category: null,
  gameMode: null,
  date: 1_700_000_000,
  players: [player(a), player(b)],
  spectators: [],
  seed: null,
  result: { uuid: `u-${a}`, time: 9 * 60_000 },
  forfeited: false,
  decayed: false,
  rank: { season: null, allTime: null },
  changes: [],
  vod: [],
  tag: null,
  replayExist: false,
  beginner: false,
  botSource: null,
  seedType: null,
  bastionType: null,
});

try {
  /* --- Pure pieces ---------------------------------------------------------------------------- */

  // dueNicknames: unchecked, or checked CHECK_INTERVAL_MS or more ago, are due; a fresher check is not.
  const now = Date.parse("2026-10-11T12:00:00Z");
  assert.deepEqual(
    dueNicknames(
      ["Grian", "fresh", "exactlyDue"],
      {
        fresh: new Date(now - 1000).toISOString(),
        exactlyDue: new Date(now - CHECK_INTERVAL_MS).toISOString(),
      },
      now,
    ),
    ["Grian", "exactlyDue"],
  );
  console.log("OK: dueNicknames skips a name checked less than 15 minutes ago");

  // isWatchCandidate: new, unprocessed, unhidden, unqueued and unblocked only.
  const ctx = (over: Partial<Parameters<typeof isWatchCandidate>[1]> = {}) => ({
    seen: new Set<number>(),
    processed: new Set<number>(),
    hidden: new Set<number>(),
    queued: new Set<number>(),
    ...over,
  });
  const m = feedMatch(1, "Grian", "Modrik");
  assert.equal(isWatchCandidate(m, ctx()), true);
  assert.equal(isWatchCandidate(m, ctx({ seen: new Set([1]) })), false, "already resolved once");
  assert.equal(
    isWatchCandidate(m, ctx({ processed: new Set([1]) })),
    false,
    "already has a working directory",
  );
  assert.equal(isWatchCandidate(m, ctx({ hidden: new Set([1]) })), false, "hidden on the dashboard");
  assert.equal(isWatchCandidate(m, ctx({ queued: new Set([1]) })), false, "already queued");
  config.blockedPlayers = ["Modrik"];
  assert.equal(isWatchCandidate(m, ctx()), false, "a blocked player is in the match");
  config.blockedPlayers = savedBlocked;
  console.log("OK: isWatchCandidate reads new/processed/hidden/queued/blocked");

  /* --- The tick end to end --------------------------------------------------------------------- */

  const calls = { list: [] as string[], vod: [] as number[] };
  const feeds: Record<string, FeedMatch[]> = {};
  const vods: Record<number, boolean | Error> = {};
  const deps: CreatorWatchDeps = {
    listMatches: async (nick) => {
      calls.list.push(nick);
      return feeds[nick] ?? [];
    },
    checkVods: async (id) => {
      calls.vod.push(id);
      const v = vods[id] ?? false;
      if (v instanceof Error) throw v;
      return v;
    },
  };

  config.creatorWatch = false;
  config.creatorWatchlist = ["Grian"];
  feeds.Grian = [feedMatch(100, "Grian", "Modrik")];
  vods[100] = true;
  await creatorWatchTick(now, deps);
  assert.deepEqual(calls.list, [], "off by default: not even the list call runs");
  assert.deepEqual(nightlyQueue(), []);
  console.log("OK: creatorWatch off is a no-op");

  config.creatorWatch = true;
  config.creatorWatchlist = [];
  await creatorWatchTick(now, deps);
  assert.deepEqual(calls.list, [], "no names to watch: still nothing");
  console.log("OK: an empty watchlist is a no-op even when the feature is on");

  config.creatorWatchlist = ["Grian", "Couriway"];
  feeds.Couriway = [feedMatch(200, "Couriway", "Etoiles")]; // no VOD for this one (vods[200] unset => false)
  setNightlyQueue([999]); // an operator's own pick, already queued — never touched or removed
  await creatorWatchTick(now, deps);
  assert.deepEqual(calls.list.sort(), ["Couriway", "Grian"]);
  assert.deepEqual(nightlyQueue(), [100, 999], "the hit goes to the FRONT, the existing entry stays");
  let state = readCreatorWatchState();
  assert.equal(state.hits.length, 2);
  assert.deepEqual(
    state.hits
      .map((h) => [h.matchId, h.queued, h.reason])
      .sort((a, b) => (a[0] as number) - (b[0] as number)),
    [
      [100, true, undefined],
      [200, false, "no Twitch VOD"],
    ],
  );
  assert.equal(state.checked.Grian, new Date(now).toISOString());
  console.log("OK: a found-VOD hit queues to the front; a VOD-less one is recorded, not queued");

  // Immediately again, same matches still in the feed: both names were just checked, so the list
  // call itself is skipped — and even if it weren't, both matches are already resolved ("seen").
  calls.list.length = 0;
  calls.vod.length = 0;
  await creatorWatchTick(now + 1000, deps);
  assert.deepEqual(calls.list, [], "checked under 15 minutes ago");
  assert.deepEqual(readCreatorWatchState().hits.length, 2, "nothing new recorded");
  console.log("OK: a name just checked is skipped on the very next tick");

  // 15 minutes later, a third brand-new match from a creator with findable VODs — but a creator
  // match is already queued for tonight, so this one is a recorded miss, not a second queue entry.
  const laterSameDay = now + CHECK_INTERVAL_MS;
  feeds.Grian = [feedMatch(100, "Grian", "Modrik"), feedMatch(300, "Grian", "Someone")];
  vods[300] = true;
  await creatorWatchTick(laterSameDay, deps);
  assert.deepEqual(nightlyQueue(), [100, 999], "still just the one creator match tonight");
  state = readCreatorWatchState();
  const hit300 = state.hits.find((h) => h.matchId === 300);
  assert.equal(hit300?.queued, false);
  assert.match(hit300?.reason ?? "", /already queued/);
  console.log("OK: at most one creator match queued a night, even with VODs found");

  // A new UTC day: the cap resets, and a fresh match gets its turn at the front.
  const nextDay = Date.parse("2026-10-12T12:00:00Z");
  feeds.Grian = [
    feedMatch(100, "Grian", "Modrik"),
    feedMatch(300, "Grian", "Someone"),
    feedMatch(400, "Grian", "Fourth"),
  ];
  vods[400] = true;
  await creatorWatchTick(nextDay, deps);
  assert.deepEqual(nightlyQueue(), [400, 100, 999], "the new day's hit takes the front in turn");
  console.log("OK: the one-a-night cap resets on a new UTC day");

  // A blocked player's match, and one already processed, are not even recorded — the dashboard's
  // own gates (and the house rule that a block outranks everything) stay the one source of truth.
  mkdirSync(path.join(media, "500"), { recursive: true }); // "already processed"
  config.blockedPlayers = ["Aquacorde"];
  feeds.Couriway = feeds.Couriway.concat(feedMatch(500, "Grian", "x"), feedMatch(600, "Aquacorde", "Grian"));
  vods[500] = true;
  vods[600] = true;
  const beforeCount = readCreatorWatchState().hits.length;
  await creatorWatchTick(nextDay + CHECK_INTERVAL_MS, deps);
  const after = readCreatorWatchState();
  assert.equal(after.hits.length, beforeCount, "neither match adds a hit");
  assert.equal(
    after.hits.some((h) => h.matchId === 500),
    false,
    "already has a working directory",
  );
  assert.equal(
    after.hits.some((h) => h.matchId === 600),
    false,
    "a blocked player is in it",
  );
  config.blockedPlayers = savedBlocked;
  console.log("OK: an already-processed or blocked-player match is never recorded as a hit");

  // A hidden match is likewise left alone.
  setHidden(700, true);
  assert.ok(hiddenMatchIds().has(700));
  feeds.Couriway = feeds.Couriway.concat(feedMatch(700, "Couriway", "x"));
  await creatorWatchTick(nextDay + 2 * CHECK_INTERVAL_MS, deps);
  assert.equal(
    readCreatorWatchState().hits.some((h) => h.matchId === 700),
    false,
  );
  console.log("OK: a hidden match is never recorded as a hit");

  /* --- creatorWatchSince: the morning report's own window -------------------------------------- */
  const since = creatorWatchSince(laterSameDay);
  assert.ok(since.every((h) => Date.parse(h.at) >= laterSameDay));
  assert.ok(
    since.some((h) => h.matchId === 400),
    "the next-day hit is in the window",
  );
  assert.ok(!since.some((h) => h.matchId === 100), "the first day's hit is before the window");
  console.log("OK: creatorWatchSince filters to hits at or after the given instant");

  /* --- Review fixes, 11 Oct 2026 ----------------------------------------------------------------- */

  // #4 dueNicknames: a corrupted stored timestamp (not a parseable date) must count as due, not
  // "not due forever" — NaN comparisons are always false, so this silently froze a nickname.
  assert.deepEqual(
    dueNicknames(["bad"], { bad: "not-a-date" }, now),
    ["bad"],
    "an unparseable stored timestamp must count as due",
  );
  console.log("OK: dueNicknames treats a corrupt stored timestamp as due, not stuck forever");

  // #3 An unexpected feed shape inside the per-match loop (isWatchCandidate / the player-name
  // mapping throwing) must not abort the whole tick — an earlier nickname's progress already
  // made this same tick must still reach disk, and the bad entry is recorded with why rather than
  // silently dropped or retried forever.
  const shapeTime = Date.parse("2026-11-01T00:00:00Z");
  config.creatorWatchlist = ["ShapeOk", "ShapeBad"];
  feeds.ShapeOk = [feedMatch(810, "ShapeOk", "Whoever")];
  vods[810] = true;
  // Malformed on purpose — a shape no real FeedMatch has, simulating an API response this code
  // did not expect; isWatchCandidate's own `m.players.map` throws on it.
  feeds.ShapeBad = [{ ...feedMatch(811, "ShapeBad", "Whoever"), players: null } as unknown as FeedMatch];
  await creatorWatchTick(shapeTime, deps);
  const afterShape = readCreatorWatchState();
  assert.equal(
    afterShape.checked.ShapeOk,
    new Date(shapeTime).toISOString(),
    "ShapeOk's own checked timestamp landed despite ShapeBad throwing later in the same tick",
  );
  assert.ok(
    afterShape.hits.some((h) => h.matchId === 810),
    "ShapeOk's own hit (resolved before the bad one) survived — the tick's progress was written",
  );
  assert.ok(
    afterShape.hits.some((h) => h.matchId === 811 && /could not evaluate/.test(h.reason ?? "")),
    "the malformed entry is recorded with why, not silently dropped",
  );
  // And it does not recur: resolved once, ever, like every other miss.
  await creatorWatchTick(shapeTime + CHECK_INTERVAL_MS, deps);
  assert.equal(
    readCreatorWatchState().hits.filter((h) => h.matchId === 811).length,
    1,
    "a malformed entry already resolved is not re-evaluated on a later tick",
  );
  console.log("OK: a malformed feed entry logs its own miss and does not lose the tick's other progress");

  /* --- #1 Phantom match directories: a VOD probe must never leave a directory behind unless the
     match is actually going to be queued -------------------------------------------------------- */
  const dirFor = (id: number) => path.join(media, String(id));
  const dirVods: Record<number, boolean | Error> = {};
  const dirFeeds: Record<string, FeedMatch[]> = {};
  const dirDeps: CreatorWatchDeps = {
    listMatches: async (nick) => dirFeeds[nick] ?? [],
    checkVods: async (id) => {
      // withDiscoveredVods's real side effect: a directory + vods.json appear the moment ANY vod
      // is found, regardless of whether both are — simulated here to pin the cleanup against it.
      mkdirSync(dirFor(id), { recursive: true });
      writeFileSync(path.join(dirFor(id), "vods.json"), "[]");
      const v = dirVods[id] ?? false;
      if (v instanceof Error) throw v;
      return v;
    },
  };
  config.creatorWatchlist = ["DirTest"];
  let dirT = Date.parse("2026-11-02T00:00:00Z");

  dirFeeds.DirTest = [feedMatch(820, "DirTest", "x")];
  dirVods[820] = new Error("boom");
  await creatorWatchTick(dirT, dirDeps);
  assert.equal(existsSync(dirFor(820)), false, "a thrown VOD check leaves no directory behind");

  dirT += CHECK_INTERVAL_MS;
  dirFeeds.DirTest = [feedMatch(821, "DirTest", "x")];
  dirVods[821] = false;
  await creatorWatchTick(dirT, dirDeps);
  assert.equal(existsSync(dirFor(821)), false, "a one-VOD miss leaves no directory behind");

  dirT += CHECK_INTERVAL_MS;
  dirFeeds.DirTest = [feedMatch(822, "DirTest", "x")];
  dirVods[822] = true;
  await creatorWatchTick(dirT, dirDeps);
  assert.deepEqual(
    readdirSync(dirFor(822)),
    ["vods.json"],
    "the match that actually claims tonight's slot keeps the vods.json the render will reuse",
  );

  dirT += CHECK_INTERVAL_MS;
  dirFeeds.DirTest = [feedMatch(823, "DirTest", "x")];
  dirVods[823] = true;
  await creatorWatchTick(dirT, dirDeps);
  assert.equal(
    existsSync(dirFor(823)),
    false,
    "both VODs found but the night's one slot is already taken — still no directory",
  );
  console.log("OK: a VOD-probe directory is removed unless the match is actually queued");

  /* --- #2 Reentrancy guard ------------------------------------------------------------------------ */
  const reentryTime = Date.parse("2026-11-03T00:00:00Z");
  const reentry = { list: [] as string[] };
  let triggered = false;
  const reentryDeps: CreatorWatchDeps = {
    listMatches: async (nick) => {
      reentry.list.push(nick);
      if (!triggered) {
        triggered = true;
        // The overlap a stalled yt-dlp/API round trip can cause in production: a second tick
        // starts while this one is still awaiting its own listMatches call.
        await creatorWatchTick(reentryTime, reentryDeps);
      }
      return [];
    },
    checkVods: async () => false,
  };
  config.creatorWatchlist = ["ReA", "ReB"];
  await creatorWatchTick(reentryTime, reentryDeps);
  assert.deepEqual(reentry.list, ["ReA", "ReB"], "an overlapping call while one is in flight is a no-op");
  console.log("OK: creatorWatchTick guards against overlapping calls, same shape as shortFlow.ts's ticking");

  console.log("creatorWatch: all checks passed");
} finally {
  config.creatorWatch = savedWatch;
  config.creatorWatchlist = savedList;
  config.blockedPlayers = savedBlocked;
  rmSync(media, { recursive: true, force: true });
}
