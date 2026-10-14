// Contract tests for the elo and stats the overlay and thumbnail show, from the docs (CLAUDE.md
// "Known pitfalls", handbook "Known pitfalls" and "Playoffs"). The promise list with shared
// P-numbers is at the top of src/api/mcsrApi.contract.test.ts; this file pins:
//
//  P4  Elo comes from the match, not the user: `user.eloRate` is the rating now (and null after a
//      season rollover), and the same match must show the same number on the overlay and the
//      thumbnail.
//  P5  A playoff game shows the bracket's frozen season-end elo, not the new season's live one.
//  P6  `pickStats` falls back to career totals only when the season bucket has no ranked games.
//  P7  …and the overlay labels itself CAREER then, SEASON otherwise — per player.
//
// Avatars are answered by a stubbed fetch with a 1-pixel PNG; anything else it is asked for fails
// the test, so nothing here reaches the network.
// Run: npx tsx src/pipeline/overlayProps.contract.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeOverlayProps, eloAtMatchStart, pickStats } from "./overlayProps.js";
import { computeThumbnailProps } from "../thumbnails/thumbnailProps.js";
import { _setPlayoffContextForTest } from "../playoffs/playoffs.js";
import type { MatchInfo, StatisticCategoryMap, UserDetails, VersusStats } from "../api/types.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  assert.match(url, /^https:\/\/nmsr\.nickac\.dev\//, `unexpected fetch: ${url}`);
  return new Response(PNG, { headers: { "content-type": "image/png" } });
}) as typeof fetch;

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;

const stat = (ranked: number | null, casual: number | null = 0) => ({ ranked, casual });
/** A statistics bucket with `ranked` ranked games and `casual` casual ones. */
const bucket = (ranked: number, casual = 0): StatisticCategoryMap => ({
  playedMatches: stat(ranked, casual),
  wins: stat(Math.floor(ranked / 2), casual),
  loses: stat(ranked - Math.floor(ranked / 2), 0),
  forfeits: stat(0, 0),
  completions: stat(ranked, casual),
  completionTime: stat(ranked * 600_000, casual * 700_000),
  bestTime: stat(ranked ? 400_000 : null, null),
});
const CAREER = bucket(4000);
const user = (
  uuid: string,
  nickname: string,
  eloRate: number | null,
  season: StatisticCategoryMap | null = bucket(120),
): UserDetails =>
  ({
    uuid,
    nickname,
    roleType: 0,
    eloRate,
    eloRank: 50,
    country: null,
    achievements: { display: [], total: [] },
    timestamp: { firstOnline: 0, lastOnline: 0, lastRanked: 0, nextDecay: null },
    statistics: { season, total: CAREER },
    connections: {},
    seasonResult: null,
    weeklyRaces: [],
  }) as UserDetails;
const versus = {
  players: [],
  results: { ranked: { total: 0 }, casual: { total: 0 } },
  changes: {},
} as VersusStats;

/** What the overlay band and the thumbnail plate each show for one match. */
async function shownElo(match: MatchInfo, left: UserDetails, right: UserDetails) {
  const overlay = await computeOverlayProps(match, left, right, versus);
  const thumb = (await computeThumbnailProps(match, left, right)).props;
  return {
    overlay: [overlay.left.eloRate, overlay.right.eloRate],
    thumbnail: [thumb.left.eloRate, thumb.right.eloRate],
  };
}

/* --- P4: the rating carried into the match, the same everywhere, whatever the live rating ----- */
for (const id of [13560037, 13766294, 13782182]) {
  // Real ranked matches with the API's full record: each player's POST-match rating and the delta.
  const match = fixture(id);
  const [a, b] = match.players as [MatchInfo["players"][0], MatchInfo["players"][0]];
  const pre = (uuid: string) => {
    const c = match.changes.find((x) => x.uuid === uuid)!;
    return c.eloRate! - c.change!;
  };
  const expected = [pre(a.uuid), pre(b.uuid)];

  // The live rating the user endpoint returns at render time has drifted (the fixture's own
  // `players[].eloRate` is one such reading), and goes null outright at a season rollover.
  for (const live of [
    [a.eloRate, b.eloRate],
    [a.eloRate! + 300, b.eloRate! - 300],
    [null, null],
  ]) {
    const shown = await shownElo(match, user(a.uuid, "Left", live[0]!), user(b.uuid, "Right", live[1]!));
    assert.deepEqual(shown.overlay, expected, `${id}: the overlay shows the pre-match rating (live ${live})`);
    assert.deepEqual(
      shown.thumbnail,
      shown.overlay,
      `${id}: the thumbnail shows the same number as the overlay for the same match`,
    );
  }
  // The pair's gap is the match's own, which is what a viewer compares.
  assert.equal(
    eloAtMatchStart(match, a.uuid, 9999) - eloAtMatchStart(match, b.uuid, 0),
    expected[0]! - expected[1]!,
  );
}

/* --- P5: a playoff game shows the frozen season-end rating ------------------------------------ */
{
  // A private-room game: no `changes` at all, and the live rating is already the next season's.
  const L = "1".repeat(32);
  const R = "2".repeat(32);
  const game = {
    ...fixture(13766294),
    id: 9400001,
    type: 3,
    changes: [],
    players: [
      { uuid: L, nickname: "SeedOne", roleType: 0, eloRate: 1500, eloRank: null, country: null },
      { uuid: R, nickname: "SeedTwo", roleType: 0, eloRate: 1400, eloRank: null, country: null },
    ],
    timelines: [],
  } as MatchInfo;
  _setPlayoffContextForTest(game.id, {
    season: 11,
    round: "Round of 16",
    gameNo: 1,
    bestOf: 5,
    firstTo: 3,
    score: [0, 0],
    seeds: [
      { uuid: L, nickname: "SeedOne", label: "#1 seed", seasonEloRate: 2688 },
      { uuid: R, nickname: "SeedTwo", label: "LCQ", seasonEloRate: 2137 },
    ],
  });
  const shown = await shownElo(game, user(L, "SeedOne", 1500), user(R, "SeedTwo", 1400));
  assert.deepEqual(shown.overlay, [2688, 2137], "the overlay shows the bracket's season-end rating");
  assert.deepEqual(shown.thumbnail, [2688, 2137], "and so does the thumbnail");
  // After the rollover the live rating can be null; the frozen one still stands.
  assert.equal(eloAtMatchStart(game, L, null), 2688);
}

/* --- P6: CAREER only when the season bucket has no ranked games -------------------------------- */
{
  const u = (season: StatisticCategoryMap | null) => user("x", "X", 2000, season);
  // Right after a rollover the season bucket is absent or empty.
  assert.equal(pickStats(u(null)).scope, "CAREER", "no season bucket at all");
  assert.equal(pickStats(u({})).scope, "CAREER", "an empty season bucket");
  // Casual games this season are not ranked games: the overlay's numbers are ranked numbers.
  assert.equal(pickStats(u(bucket(0, 40))).scope, "CAREER", "casual-only season falls back");
  assert.equal(
    pickStats(u({ ...bucket(0), playedMatches: stat(null, 3) })).scope,
    "CAREER",
    "a null ranked count is no ranked games",
  );
  // One ranked game is enough to be the season — "only when … no ranked games".
  const one = pickStats(u(bucket(1)));
  assert.equal(one.scope, "SEASON", "a single ranked game keeps the season");
  assert.equal(one.stats.playedMatches!.ranked, 1, "and its numbers are the season's, not the career's");
  // Mid-season the season bucket itself is handed back, never the career totals.
  const mid = u(bucket(120));
  assert.equal(pickStats(mid).stats, mid.statistics.season);
}

/* --- P7: the overlay says which, per player ------------------------------------------------------ */
{
  const match = fixture(13560037);
  const [a, b] = match.players as [MatchInfo["players"][0], MatchInfo["players"][0]];
  // One player has played ranked this season, the other only casual.
  const props = await computeOverlayProps(
    match,
    user(a.uuid, "Left", 2000, bucket(37)),
    user(b.uuid, "Right", 2000, bucket(0, 12)),
    versus,
  );
  assert.equal(props.left.statsScope, "SEASON");
  assert.equal(props.left.gamesPlayed, 37, "the season's games");
  assert.equal(props.right.statsScope, "CAREER", "the fallback is labelled CAREER on screen");
  assert.equal(props.right.gamesPlayed, 4000, "with the career's games, not 0 or the casual 12");
  // Win rate and average come from the same bucket the label names, never a mix.
  assert.equal(props.right.winRatePct, 50);
  assert.equal(props.right.avgMs, 600_000);
}

console.log("overlayProps.contract: all checks passed");
