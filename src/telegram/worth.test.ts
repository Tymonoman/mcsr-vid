// Self-check for worth.ts: which matches count as worth rendering, how they are ranked and told,
// what a gather costs in API calls, and how the six-hour copy in the state file behaves. Nothing
// here touches the network or /media: the gather's outside calls are fakes, the media directory a
// scratch one.
// Run: npx tsx src/telegram/worth.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { FeedMatch, MatchInfo } from "../api/types.js";
import { setHidden } from "../dashboard/matchShelf.js";
import { dismissSuggestion, scanKnowledge } from "../dashboard/suggest.js";
import { computeMetrics } from "../pipeline/matchScore.js";
import { readTelegramState, setStateDryRun } from "./state.js";
import {
  findWorth,
  gatherWorth,
  MAX_SCORED,
  takenNow,
  WATCH_ROSTER,
  WORTH_TTL_MS,
  worthCandidates,
  worthEntry,
  worthInterest,
  worthStory,
  type WorthDeps,
} from "./worth.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-worth-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
const stateFile = path.join(media, ".telegram.json");

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;

try {
  /* --- The story and the score, pinned on real matches ------------------------------------- */
  // Both runners killed the dragon: the finish margin is the gap. 12730175 is the benchmark video,
  // a 1.0 s finish with nobody ever ahead by much; 13448958 adds three lead changes and a death.
  const story = (id: number) => worthStory(computeMetrics(fixture(id)));
  const interest = (id: number) => Math.round(worthInterest(computeMetrics(fixture(id))) * 1e4) / 1e4;
  assert.equal(story(12730175), "no lead change, finish 1.0 s apart");
  assert.equal(story(13448958), "lead changes 3x, 1 death, finish 8.9 s apart");
  assert.equal(story(13617328), "lead changes once, finish 7.7 s apart");
  // The other runner never killed the dragon: the gap is the last split both reached, named.
  assert.equal(story(12929221), "lead changes 2x, 1 death, 14.4 s apart at End enter");
  // Nobody is named, and no result is told.
  for (const id of [12730175, 12929221, 13448958, 13549300]) {
    const s = story(id);
    const m = computeMetrics(fixture(id));
    assert.ok(!m.players.some((p) => s.includes(p)), s);
    assert.ok(!/win|won|lost|beat/i.test(s), s);
  }
  // 0.5 close (by stage and gap) + 0.3 lead changes (three is the most) + 0.2 real deaths (three is the most).
  assert.equal(interest(13448958), 0.7184); // 0.5 × (1 − 8.9/30) + 0.3 + 0.2/3
  assert.equal(interest(12929221), 0.5899); // 0.5 × 0.85 × (1 − 14.4/60) + 0.2 + 0.2/3
  assert.equal(interest(12730175), 0.4828); // a 1 s finish alone
  assert.ok(
    interest(13549300) > interest(12898432),
    "a 0.3 s finish with lead changes beats a flat 3.5 s one",
  );
  const entry = worthEntry(fixture(13673240));
  assert.deepEqual(entry, {
    matchId: 13673240,
    players: "Infume vs Feinberg",
    playedAt: new Date(fixture(13673240).date * 1000).toISOString(),
    runMs: 493570,
    story: "lead changes 3x, finish 12.1 s apart",
    score: 0.6,
  });

  /* --- What the scans' cache lends: logins, followers, dismissals; and what is taken ------- */
  dismissSuggestion(557); // writes a cache at the current version
  const cacheFile = path.join(media, ".suggest-cache.json");
  const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
  cache.twitchLogins = { Pinne: "skycrab", Jabo_: "owjabo", Nolink: null };
  cache.twitchFollowers = { skycrab: { count: 32113, fetchedAt: 1 }, owjabo: { count: 372, fetchedAt: 1 } };
  writeFileSync(cacheFile, JSON.stringify(cache));
  const known = scanKnowledge();
  assert.deepEqual(known.twitchOf("pinne"), { login: "skycrab", followers: 32113 }); // any case
  assert.deepEqual(known.twitchOf("Jabo_"), { login: "owjabo", followers: 372 });
  assert.equal(known.twitchOf("Nolink"), null); // checked: no linked Twitch
  assert.equal(known.twitchOf("Stranger"), null); // never seen
  assert.ok(known.dismissed.has(557));

  mkdirSync(path.join(media, "555")); // a match directory: rendered
  setHidden(556, true); // hidden on the dashboard
  const taken = takenNow();
  assert.deepEqual([555, 556, 557, 558].map(taken), [true, true, true, false]);

  /* --- Who counts, in what order ------------------------------------------------------------ */
  const NOW = Date.parse("2026-09-30T20:00:00Z");
  const player = (nickname: string) => ({
    uuid: `u-${nickname}`,
    nickname,
    roleType: 0,
    eloRate: null,
    eloRank: null,
    country: null,
  });
  const feedMatch = (
    id: number,
    a: string,
    b: string,
    o: { hoursAgo?: number; runMs?: number; forfeited?: boolean; draw?: boolean; vodsFor?: string[] } = {},
  ): FeedMatch => ({
    id,
    type: 2,
    season: 12,
    category: null,
    gameMode: null,
    date: Math.round(NOW / 1000 - (o.hoursAgo ?? 2) * 3600),
    players: [player(a), player(b)],
    spectators: [],
    seed: null,
    result: { uuid: o.draw ? null : `u-${a}`, time: o.runMs ?? 9 * 60_000 },
    forfeited: o.forfeited ?? false,
    decayed: false,
    rank: { season: null, allTime: null },
    changes: [],
    vod: (o.vodsFor ?? [a, b]).map((n) => ({
      uuid: `u-${n}`,
      url: `https://www.twitch.tv/videos/${id}`,
      startsAt: 0,
    })),
    tag: null,
    replayExist: false,
    beginner: false,
    botSource: null,
    seedType: null,
    bastionType: null,
  });
  const names = new Set(["beefsalad", ...WATCH_ROSTER.map((n) => n.toLowerCase())]);
  const pure = {
    roster: WATCH_ROSTER,
    isKnown: (n: string) => names.has(n.toLowerCase()),
    isTaken: (id: number) => id === 7,
  };
  const three = {
    ...feedMatch(11, "doogile", "Feinberg"),
    players: [player("doogile"), player("Feinberg"), player("Infume")],
  };
  const pool = [
    feedMatch(2, "doogile", "BeefSalad", { hoursAgo: 1 }), // one roster seat, newest
    feedMatch(1, "doogile", "Feinberg", { hoursAgo: 2 }), // a roster pair
    feedMatch(1, "doogile", "Feinberg", { hoursAgo: 2 }), // …read again in the other player's list
    feedMatch(10, "Infume", "silverrruns", { hoursAgo: 30 }), // a roster pair, older
    feedMatch(3, "doogile", "Jabo_"), // nobody knows the opponent
    feedMatch(4, "doogile", "Feinberg", { hoursAgo: 4 * 24 }), // outside the three days
    feedMatch(5, "doogile", "Feinberg", { forfeited: true }),
    feedMatch(6, "doogile", "Feinberg", { draw: true }),
    feedMatch(7, "doogile", "Feinberg"), // taken
    feedMatch(8, "doogile", "Feinberg", { runMs: 5 * 60_000 }), // under six minutes
    three, // a third seat
  ];
  assert.deepEqual(
    worthCandidates(pool, NOW, pure).map((m) => m.id),
    [1, 10, 2], // roster pairs first, newest first within; each match once
  );

  /* --- What a gather costs, and what it leaves out ----------------------------------------- */
  // Scored matches are real fixtures, so scores differ: the fake `fetchMatch` hands out one per id.
  const fixtureIds = [12730175, 12929221, 13448958, 13549300, 13673240, 13446429, 12898432, 12902901];
  const calls = { list: [] as string[], match: [] as number[], discover: [] as number[] };
  const mkDeps = (feeds: Record<string, FeedMatch[]>, over: Partial<WorthDeps> = {}): WorthDeps => ({
    ...pure,
    notes: [],
    listMatches: async (n) => {
      calls.list.push(n);
      const feed = feeds[n];
      if (!feed) throw new Error(`429 for ${n}`);
      return feed;
    },
    fetchMatch: async (id) => {
      calls.match.push(id);
      return { ...fixture(fixtureIds[id % fixtureIds.length]!), id };
    },
    discover: async (m) => {
      calls.discover.push(m.id);
      return [];
    },
    ...over,
  });
  const reset = () => ((calls.list.length = 0), (calls.match.length = 0), (calls.discover.length = 0));
  const pairs = ["Feinberg", "Infume", "silverrruns", "Pinne", "lowk3y_"];
  const rosterFeeds = (per: Record<string, FeedMatch[]>) => ({
    doogile: [],
    Feinberg: [],
    Infume: [],
    Pinne: [],
    lowk3y_: [],
    silverrruns: [],
    ...per,
  });

  // Twelve matches with both VODs attached: one list call per roster player, one match call per
  // scored candidate and never more than MAX_SCORED, discovery not asked — the slots are full.
  const twelve = Array.from({ length: 12 }, (_, i) =>
    feedMatch(100 + i, "doogile", pairs[i % pairs.length]!, { hoursAgo: 1 + i }),
  );
  let deps = mkDeps(rosterFeeds({ doogile: twelve }));
  let found = await findWorth(NOW, deps);
  assert.equal(calls.list.length, WATCH_ROSTER.length);
  assert.equal(calls.match.length, MAX_SCORED);
  assert.deepEqual(calls.match, [100, 101, 102, 103, 104, 105, 106, 107]); // the newest roster pairs first
  assert.equal(calls.discover.length, 0);
  assert.equal(found.matches.length, MAX_SCORED);
  assert.deepEqual(
    found.matches.map((m) => m.score),
    [...found.matches.map((m) => m.score)].sort((a, b) => b - a),
  ); // best story first
  assert.deepEqual(found.notes, []);

  // Fewer attached pairs than slots: discovery fills what is left, for matches exactly one VOD short
  // — never for a match with no VOD at all — and finds are ranked with the rest.
  reset();
  const mixed = [
    feedMatch(200, "doogile", "Feinberg", { hoursAgo: 1 }), // attached pair
    feedMatch(201, "doogile", "Infume", { hoursAgo: 2, vodsFor: ["doogile"] }), // one short, found
    feedMatch(202, "doogile", "Pinne", { hoursAgo: 3, vodsFor: ["Pinne"] }), // one short, not found
    feedMatch(203, "doogile", "lowk3y_", { hoursAgo: 4, vodsFor: [] }), // none attached: never asked
  ];
  deps = mkDeps(rosterFeeds({ doogile: mixed }), {
    discover: async (m) => {
      calls.discover.push(m.id);
      return m.id === 201 ? [{ uuid: "u-Infume", url: "https://www.twitch.tv/videos/9", startsAt: 0 }] : [];
    },
  });
  found = await findWorth(NOW, deps);
  assert.deepEqual(calls.discover, [201, 202]);
  assert.deepEqual([...calls.match].sort(), [200, 201]);
  assert.deepEqual(found.matches.map((m) => m.matchId).sort(), [200, 201]);

  // Discovery is bounded by the slots the attached pairs leave: six pairs, eight slots, two lookups
  // however many matches are one VOD short.
  reset();
  const shortOnes = Array.from({ length: 6 }, (_, i) =>
    feedMatch(250 + i, "doogile", pairs[i % pairs.length]!, { hoursAgo: 20 + i, vodsFor: ["doogile"] }),
  );
  const sixPairs = Array.from({ length: 6 }, (_, i) =>
    feedMatch(260 + i, "doogile", pairs[i % pairs.length]!, { hoursAgo: 1 + i }),
  );
  await findWorth(NOW, mkDeps(rosterFeeds({ doogile: [...shortOnes, ...sixPairs] })));
  assert.equal(calls.discover.length, MAX_SCORED - 6);
  assert.deepEqual(calls.discover, [250, 251]); // the best-ranked of the short ones

  // A roster player whose list cannot be read costs a note, not the gather; every list failing is an error.
  reset();
  deps = mkDeps({ doogile: [feedMatch(300, "doogile", "Feinberg")], Feinberg: [] });
  found = await findWorth(NOW, deps);
  assert.equal(found.matches.length, 1);
  assert.equal(found.notes.length, 4); // Infume, Pinne, lowk3y_, silverrruns
  assert.ok(found.notes[0]!.startsWith("Infume's matches could not be read"), found.notes[0]);
  await assert.rejects(findWorth(NOW, mkDeps({})), /429 for doogile/);

  // A match that cannot be fetched is left out with a note; the others stand. Channels that could not
  // be listed (the live `discover` records them) are told too.
  reset();
  deps = mkDeps(
    rosterFeeds({ doogile: [feedMatch(400, "doogile", "Feinberg"), feedMatch(401, "doogile", "Infume")] }),
    {
      fetchMatch: async (id) => {
        if (id === 400) throw new Error("boom");
        return { ...fixture(13673240), id };
      },
      notes: ["twitch.tv/feinberg could not be listed"],
    },
  );
  found = await findWorth(NOW, deps);
  assert.deepEqual(
    found.matches.map((m) => m.matchId),
    [401],
  );
  assert.deepEqual(found.notes, ["#400 could not be read (boom)", "twitch.tv/feinberg could not be listed"]);

  // Nothing qualifies: an empty list, not an error.
  found = await findWorth(NOW, mkDeps(rosterFeeds({})));
  assert.deepEqual(found, { matches: [], notes: [] });

  /* --- The six-hour copy in the state file ------------------------------------------------- */
  reset();
  const feeds = rosterFeeds({ doogile: twelve.slice(0, 3) });
  deps = mkDeps(feeds);
  const first = await gatherWorth(NOW, {}, deps);
  assert.equal(calls.list.length, 6);
  assert.equal(readTelegramState().worth?.at, NOW);
  assert.equal(first.matches.length, 3);

  // Within the TTL a second report spends nothing …
  const again = await gatherWorth(NOW + WORTH_TTL_MS - 1000, {}, deps);
  assert.equal(calls.list.length, 6);
  assert.deepEqual(again, first);
  // … and leaves out what was taken since (rendered, hidden or dismissed).
  const gone = first.matches[0]!.matchId;
  deps.isTaken = (id) => id === gone;
  const after = await gatherWorth(NOW + 1000, {}, deps);
  assert.equal(calls.list.length, 6);
  assert.deepEqual(
    after.matches.map((m) => m.matchId),
    first.matches.map((m) => m.matchId).filter((id) => id !== gone),
  );
  deps.isTaken = pure.isTaken;

  // `fresh` (the /worth command) gathers anew, and so does a copy past the TTL or from the future.
  await gatherWorth(NOW + 1000, { fresh: true }, deps);
  assert.equal(calls.list.length, 12);
  await gatherWorth(NOW + WORTH_TTL_MS + 2000, {}, deps);
  assert.equal(calls.list.length, 18);
  await gatherWorth(NOW - 3600_000, {}, deps); // the clock went back: the copy is not trusted
  assert.equal(calls.list.length, 24);

  // A gather that had to leave something out is kept too: its notes are shown with it, and
  // gathering again on every report for a channel that will not list would cost 14 calls and a
  // yt-dlp round each time. /worth (fresh) is the retry.
  const flaky = mkDeps(feeds, { notes: ["twitch.tv/x could not be listed"] });
  const flakyAt = NOW + 10 * WORTH_TTL_MS;
  const listsBefore = calls.list.length;
  const gathered = await gatherWorth(flakyAt, {}, flaky);
  assert.deepEqual(gathered.notes, ["twitch.tv/x could not be listed"]);
  assert.equal(readTelegramState().worth?.at, flakyAt);
  const reread = await gatherWorth(flakyAt + 1000, {}, flaky);
  assert.equal(calls.list.length, listsBefore + WATCH_ROSTER.length); // one gather's lists, not two
  assert.deepEqual(reread.notes, ["twitch.tv/x could not be listed"]); // the copy tells it too

  // A gather that throws (every list failed) leaves the last copy as it was.
  await assert.rejects(gatherWorth(flakyAt + 2000, { fresh: true }, mkDeps({})), /429 for doogile/);
  assert.equal(readTelegramState().worth?.at, flakyAt);

  // --dry-run: the state file is read, never written.
  setStateDryRun(true);
  const before = readFileSync(stateFile, "utf8");
  await gatherWorth(NOW + 20 * WORTH_TTL_MS, { fresh: true }, deps);
  assert.equal(readFileSync(stateFile, "utf8"), before);
  setStateDryRun(false);

  console.log("worth: all checks passed");
} finally {
  rmSync(media, { recursive: true, force: true });
}
