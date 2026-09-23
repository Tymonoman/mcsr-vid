// Self-check for series.ts: a Round of 16 slot from the saved S11 bracket with three synthesised
// games, the API stubbed at global fetch, ffmpeg and ffprobe stubbed at the seams. What is pinned:
// the games render and export in order and only the missing ones, the join lands in game 1's
// directory and is left alone when it is current, game 1's text is the series' (chapters per
// game, game 1's link first, no score anywhere), the other games are hidden, and no game's Short
// is copied in: a series' Short is picked and cut in game 1's directory like any match's.
// Run: npx tsx src/series.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { FeedMatch, MatchInfo, PlayoffBracket } from "../api/types.js";

config.mediaDir = mkdtempSync(path.join(tmpdir(), "series-"));
config.youtubePlaylistUrl = "https://www.youtube.com/playlist?list=PL1";
config.supportUrl = "";

const envelope = JSON.parse(readFileSync(new URL("../fixtures/playoffs-11.json", import.meta.url), "utf8"));
const bracket: PlayoffBracket = envelope.data.data;
const slot = bracket.matches.find((m) => m.id === 9)!;
const edcr = bracket.players[0]!;
const lauveer = bracket.players[15]!;
const start = slot.startTime!;

const game = (id: number, date: number, winner: string, seated = [edcr, lauveer]): MatchInfo =>
  ({
    id,
    type: 3,
    season: 12,
    date,
    players: seated.map((p) => ({ uuid: p.uuid, nickname: p.nickname })),
    spectators: [],
    result: { uuid: winner, time: 480_000 },
    forfeited: false,
    changes: [],
    vod: [],
    rank: { season: null, allTime: null },
    tag: null,
    timelines: [],
    completions: [],
    seedType: null,
    bastionType: null,
  }) as unknown as MatchInfo;

// Game 2 seated the other way round, as rooms are: the series text still reads in game 1's order.
const g1 = game(101, start + 300, edcr.uuid);
const g2 = game(102, start + 900, lauveer.uuid, [lauveer, edcr]);
const g3 = game(103, start + 1500, edcr.uuid);
const games: Record<number, MatchInfo> = { 101: g1, 102: g2, 103: g3 };
const feed = (m: MatchInfo): FeedMatch => {
  const { timelines: _t, completions: _c, ...rest } = m;
  return rest;
};

const ok = (payload: unknown) =>
  new Response(JSON.stringify({ status: "success", data: payload }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname === "/playoffs/11") return ok({ data: bracket, next: null, prev: 10 });
  const hist = /^\/users\/([^/]+)\/matches$/.exec(url.pathname);
  if (hist) return ok([g3, g2, g1].map(feed));
  const user = /^\/users\/([^/]+)$/.exec(url.pathname);
  if (user) {
    const p = bracket.players.find((x) => x.uuid === user[1])!;
    return ok({
      uuid: p.uuid,
      nickname: p.nickname,
      eloRate: 2000,
      eloRank: 1,
      country: "us",
      statistics: {},
    });
  }
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m) return ok(games[Number(m[1])]);
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const { assembleSeries, chapterStarts, concatList, readSeriesRecord, renderSeries, seriesShortGame } =
  await import("./series.js");
const { buildSeriesDescription } = await import("../pipeline/description.js");
const { formatChapterTime } = await import("../pipeline/chapters.js");

/* --- Pure parts --------------------------------------------------------------------------- */

assert.deepEqual(chapterStarts([600, 500.5, 700]), [0, 600, 1100.5]);
assert.equal(concatList(["/m/a.mp4", "/m/it's.mp4"]), "file '/m/a.mp4'\nfile '/m/it'\\''s.mp4'\n");
assert.equal(formatChapterTime(59 * 60 + 59), "59:59");
assert.equal(formatChapterTime(3600), "1:00:00");
assert.equal(formatChapterTime(3600 + 65), "1:01:05");

const desc = buildSeriesDescription({
  season: 11,
  round: "Round of 16",
  bestOf: 5,
  left: { nickname: "edcr", label: "#1 seed", seasonEloRate: 2688 },
  right: { nickname: "lauveer", label: "LCQ", seasonEloRate: 2137 },
  games: [
    {
      matchId: 101,
      gameNo: 1,
      startSec: 0,
      pageUrl: "https://x/matches/101",
      streams: [{ nickname: "edcr", url: "https://t/1?t=5s" }],
    },
    { matchId: 102, gameNo: 2, startSec: 612.4, pageUrl: "https://x/matches/102", streams: [] },
    { matchId: 103, gameNo: 3, startSec: 3700, pageUrl: "https://x/matches/103", streams: [] },
  ],
  bracketUrl: "https://magmamcsr.com/events/playoffs/s11/bracket",
  playlistUrl: "https://www.youtube.com/playlist?list=PL1",
});
assert.match(
  desc,
  /^edcr vs lauveer, mcsr ranked season 11 playoffs, round of 16, best of 5\. every game of the series/,
);
assert.ok(desc.includes("edcr came in as the #1 seed at 2688 elo, lauveer from the lcq at 2137."));
assert.ok(
  desc.includes("0:00 game 1\n10:12 game 2\n1:01:40 game 3"),
  "a chapter per game, hours past sixty minutes",
);
assert.ok(
  desc.indexOf("/matches/101") < desc.indexOf("/matches/102"),
  "game 1's link pairs the upload: it comes first",
);
assert.ok(desc.includes("game 1: https://x/matches/101 · edcr's stream https://t/1?t=5s"));
assert.ok(
  !/\b\d+\s*[–-]\s*\d+\b/.test(desc.replace(/\d+:\d\d(:\d\d)?/g, "")),
  `a score-shaped pair in:\n${desc}`,
);
assert.ok(!/won|winner|sweep/i.test(desc));

/* --- Rendering a series: order, skipping, the join, the text, the hiding ------------------- */

const dir = (id: number) => path.join(config.mediaDir, String(id));
const final = (id: number) => path.join(dir(id), `final-${id}.mp4`);
for (const id of [101, 102, 103]) {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(
    path.join(dir(id), "vods.json"),
    JSON.stringify([
      { uuid: edcr.uuid, url: "https://www.twitch.tv/videos/1", startsAt: games[id]!.date - 1000 },
      { uuid: lauveer.uuid, url: "https://www.twitch.tv/videos/2", startsAt: games[id]!.date - 900 },
    ]),
  );
}
// Game 2 is already exported: it must be neither rendered nor exported again.
writeFileSync(final(102), "x");

const log: string[] = [];
const joins: string[][] = [];
const extracted: number[] = [];
const seams = {
  join: async (files: readonly string[], out: string) => {
    joins.push([...files]);
    writeFileSync(out, "joined");
  },
  probe: async (file: string) =>
    file.endsWith("final-101.mp4") ? 600 : file.endsWith("final-102.mp4") ? 500 : 700,
  extract: async (_series: string, startSec: number, _dur: number, out: string) => {
    extracted.push(startSec);
    writeFileSync(out, "extracted");
  },
};
const result = await renderSeries(
  101,
  {
    renderGame: async (id) => {
      log.push(`render ${id}`);
      return null;
    },
    exportGame: async (id) => {
      log.push(`export ${id}`);
      writeFileSync(final(id), "x");
      return null;
    },
    log: () => {},
  },
  seams,
);
assert.equal(result.kind, "joined");
assert.deepEqual(
  log,
  ["render 101", "export 101", "render 103", "export 103"],
  "in order; the exported game skipped",
);
assert.deepEqual(joins, [[final(101), final(102), final(103)]]);
assert.ok(existsSync(path.join(dir(101), "series-101.mp4")), "the series is game 1's");
assert.ok(
  [101, 102, 103].every((id) => !existsSync(final(id))),
  "the games' exports are deleted: the series holds them",
);

const record = (await readSeriesRecord(dir(101)))!;
assert.deepEqual(
  record.games.map((g) => [g.matchId, g.gameNo, g.durationSec]),
  [
    [101, 1, 600],
    [102, 2, 500],
    [103, 3, 700],
  ],
);
assert.equal(record.round, "Round of 16");
assert.equal(record.firstTo, 3);
assert.equal(record.shortFromMatchId, undefined, "a run cuts no Short: the pick and the hook come first");

const title = readFileSync(path.join(dir(101), "match-101.title.txt"), "utf8").split("\n")[0];
// lauveer left, edcr right: a private room's seats are ordered by uuid (src/api/mcsrApi.ts).
assert.equal(
  title,
  "<HOOK> | lauveer vs edcr | MCSR Ranked Season 11 Playoffs | Round of 16",
  "no game number on a series",
);
const description = readFileSync(path.join(dir(101), "match-101.description.txt"), "utf8");
assert.ok(description.includes("0:00 game 1\n10:00 game 2\n18:20 game 3"));
assert.ok(
  description.includes(
    // Game 2's room seated them the other way round; the line keeps game 1's order.
    "game 2: https://magmamcsr.com/ranked/player/lauveer/matches/102?season=12 · lauveer's stream https://www.twitch.tv/videos/2?t=420s · edcr's stream https://www.twitch.tv/videos/1?t=520s",
  ),
  description,
);
assert.equal(
  readFileSync(path.join(dir(101), "match-101.chapters.txt"), "utf8"),
  "0:00 game 1\n10:00 game 2\n18:20 game 3",
);
const tags = readFileSync(path.join(dir(101), "match-101.tags.txt"), "utf8").split("\n");
assert.deepEqual(tags.slice(0, 6), [
  "lauveer",
  "edcr",
  "mcsr ranked season 11 playoffs",
  "round of 16",
  "mcsr ranked playoffs",
  "playoffs",
]);
const shelf = JSON.parse(readFileSync(path.join(config.mediaDir, ".dashboard.json"), "utf8"));
assert.deepEqual(shelf.hidden, [102, 103], "games 2 and 3 are inside game 1's video");

// Current: every game held by the series, nothing newer — the join is not redone, and nothing
// is rendered either.
const again = await assembleSeries(101, {
  ...seams,
  join: async () => assert.fail("re-joined a current series"),
});
assert.equal(again.kind, "current");
log.length = 0;
const nothing = await renderSeries(
  101,
  {
    renderGame: async (id) => {
      log.push(`render ${id}`);
      return null;
    },
    exportGame: async (id) => {
      log.push(`export ${id}`);
      return null;
    },
    log: () => {},
  },
  seams,
);
assert.equal(nothing.kind, "current");
assert.deepEqual(log, [], "a current series renders nothing");

// A newer export of one game re-joins: the other two come back out of the series at their
// recorded offsets, the three are joined, the exports go again.
await new Promise((r) => setTimeout(r, 20));
writeFileSync(final(103), "xx");
joins.length = 0;
extracted.length = 0;
const rejoined = await assembleSeries(101, seams);
assert.equal(rejoined.kind, "joined");
assert.equal(joins.length, 1);
assert.deepEqual(extracted, [0, 600], "games 1 and 2 extracted at their chapter offsets");
assert.ok(!existsSync(final(103)));

// A game whose sync moved after the join is stale, and the series says which one.
writeFileSync(
  path.join(dir(102), "sync.json"),
  JSON.stringify({ left: 1, right: 1, confidence: 1, detail: "", source: "manual" }),
);
await new Promise((r) => setTimeout(r, 20));
const { utimesSync } = await import("node:fs");
const later = new Date(Date.now() + 5000);
utimesSync(path.join(dir(102), "sync.json"), later, later);
const staleNow = await assembleSeries(101, seams);
assert.deepEqual(staleNow, { kind: "stale", firstGameId: 101, stale: [102] });
const { exportStale } = await import("../pipeline/syncFile.js");
assert.equal(exportStale(dir(101), path.join(dir(101), "series-101.mp4")).staleMatchId, 102);
// Its export re-done, the join follows and the series is fresh again.
writeFileSync(final(102), "resynced");
utimesSync(final(102), new Date(Date.now() + 10000), new Date(Date.now() + 10000));
const fixed = await assembleSeries(101, seams);
assert.equal(fixed.kind, "joined");
utimesSync(path.join(dir(101), "series-101.mp4"), new Date(Date.now() + 20000), new Date(Date.now() + 20000));
assert.equal(exportStale(dir(101), path.join(dir(101), "series-101.mp4")).stale, false);

/* --- No game's Short is copied in; the series' Short game is its cut's, else its pick's ------- */

writeFileSync(path.join(dir(103), "short-103.mp4"), "s");
writeFileSync(path.join(dir(103), "short-103.title.txt"), "Can the LCQ take down the #1 seed? #minecraft #mcsr\n");
const kept = await assembleSeries(101, seams);
assert.equal(kept.kind, "current");
assert.ok(!existsSync(path.join(dir(101), "short-101.mp4")), "a game's own Short is never adopted by the series");
assert.equal(await seriesShortGame(101), null, "nothing picked, nothing cut");
writeFileSync(path.join(dir(101), "short-101.pick.json"), JSON.stringify({ gameMatchId: 102 }));
assert.equal(await seriesShortGame(101), 102, "the pick names the game");
writeFileSync(path.join(dir(101), "short-101.cut.json"), JSON.stringify({ gameMatchId: 103 }));
assert.equal(await seriesShortGame(101), 103, "and the cut, once there is one, is what went out");
// A Short copied in before 23 Sept 2026 recorded where it came from as `fromMatchId`.
writeFileSync(path.join(dir(101), "short-101.cut.json"), JSON.stringify({ pick: 0, startMs: 1, fromMatchId: 102 }));
assert.equal(await seriesShortGame(101), 102);

console.log("series: all checks passed");
