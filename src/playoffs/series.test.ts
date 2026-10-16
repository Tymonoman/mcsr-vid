// Self-check for series.ts: a Round of 16 slot from the saved S11 bracket with three synthesised
// games, the API stubbed at global fetch, ffmpeg and ffprobe stubbed at the seams. What is pinned:
// the games render and export in order and only the missing ones, the join lands in game 1's
// directory and is left alone when it is current, game 1's text is the series' (chapters per
// game, game 1's link first, no score anywhere), the other games are hidden, and no game's Short
// is copied in: a series' Short is picked and cut in game 1's directory like any match's.
// Run: npx tsx src/series.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// A 3-0 in a first-to-3 slot: only a decided series joins.
const g1 = game(101, start + 300, edcr.uuid);
const g2 = game(102, start + 900, edcr.uuid, [lauveer, edcr]);
const g3 = game(103, start + 1500, edcr.uuid);
// The worlds' seed types name the chapters; game 3's is unknown and its chapter stays bare.
g1.seedType = "VILLAGE";
g2.seedType = "DESERT_TEMPLE";
// Game 1's own split (7 Oct 2026, per-split series chapters): a real sub-chapter, not just the
// header, must appear in the assembled series' chapter list, offset into the joined video.
g1.timelines = [
  { uuid: edcr.uuid, time: 130_000, type: "story.enter_the_nether" },
  { uuid: lauveer.uuid, time: 107_000, type: "story.enter_the_nether" },
];
const games: Record<number, MatchInfo> = { 101: g1, 102: g2, 103: g3 };
// What the players' histories return: the whole series, or (below) one still being played.
let history = [g3, g2, g1];
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
  if (hist) return ok(history.map(feed));
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

const {
  assembleSeries,
  chapterStarts,
  concatList,
  gameMatchStarts,
  hookFactsMatchId,
  readSeriesRecord,
  renderSeries,
  seriesProgress,
  seriesShortGame,
} = await import("./series.js");
const {
  buildSeriesDescription,
  CLOSER,
  CLOSER_VARIANTS,
  SUBSCRIBE_LINE,
  SUBSCRIBE_LINE_VARIANTS,
  variantIndex,
} = await import("../pipeline/description.js");
const { formatChapterTime } = await import("../pipeline/chapters.js");

/* --- Pure parts --------------------------------------------------------------------------- */

assert.deepEqual(chapterStarts([600, 500.5, 700]), [0, 600, 1100.5]);
// Each game's match start in the joined video: its chapter plus its own export's (a 7 s card's
// 10 s, a record from before 24 Sept 2026 the same; a 3 s card's 6 s).
const joined = (durationSec: number, matchStartSec?: number) => ({
  matchId: 1,
  gameNo: 1,
  winnerUuid: null,
  durationSec,
  ...(matchStartSec === undefined ? {} : { matchStartSec }),
});
assert.deepEqual(gameMatchStarts([joined(600), joined(500.5, 10), joined(700, 6)]), [10, 610, 1106.5]);
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
      chapters: [],
    },
    {
      matchId: 102,
      gameNo: 2,
      startSec: 612.4,
      seed: "desert temple seed",
      pageUrl: "https://x/matches/102",
      streams: [],
      chapters: [],
    },
    { matchId: 103, gameNo: 3, startSec: 3700, pageUrl: "https://x/matches/103", streams: [], chapters: [] },
  ],
  bracketUrl: "https://magmamcsr.com/events/playoffs/s11/bracket",
  playlistUrl: "https://www.youtube.com/playlist?list=PL1",
});
assert.match(
  desc,
  /^edcr vs lauveer, mcsr ranked season 11 playoffs, round of 16, best of 5\. every game of the series/,
);
assert.ok(desc.includes("edcr came in as the 1st seed at 2688 elo, lauveer from the lcq at 2137."));
assert.ok(!desc.split("\n\n")[0]!.includes("#"), `no hash in series description opening:\n${desc}`);
assert.equal(desc.split("\n\n")[1], SUBSCRIBE_LINE, "the ask follows the opening, as on a match's");

const desc9 = buildSeriesDescription({
  season: 11,
  round: "Round of 16",
  bestOf: 5,
  left: { nickname: "edcr", label: "#9 seed", seasonEloRate: 2688 },
  right: { nickname: "lauveer", label: "LCQ", seasonEloRate: 2137 },
  games: [],
  bracketUrl: "https://magmamcsr.com/events/playoffs/s11/bracket",
});
assert.ok(desc9.includes("edcr came in as the 9th seed at 2688 elo, lauveer from the lcq at 2137."));
assert.ok(
  !desc9.split("\n\n")[0]!.includes("#"),
  `no hash in 9th-seed series description opening:\n${desc9}`,
);
assert.ok(
  desc.includes("0:00 game 1\n10:12 game 2 · desert temple seed\n1:01:40 game 3"),
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

// copyVariety: off (above, `desc`/`desc9` never set it) is byte for byte today's closer and
// subscribe line; on picks game 1's own variant. Game 1's id here is one whose two picks are both
// non-canonical (101's closer is index 0 since variantIndex's 15 Oct 2026 remix).
{
  const g1Id = 6;
  const closerIdx = variantIndex(g1Id, 0, CLOSER_VARIANTS.length);
  const subscribeIdx = variantIndex(g1Id, 1, SUBSCRIBE_LINE_VARIANTS.length);
  assert.notEqual(closerIdx, 0, "the fixture must exercise a non-canonical closer variant");
  assert.notEqual(subscribeIdx, 0, "the fixture must exercise a non-canonical subscribe variant");
  const varied = buildSeriesDescription({
    season: 11,
    round: "Round of 16",
    bestOf: 5,
    left: { nickname: "edcr", label: "#1 seed", seasonEloRate: 2688 },
    right: { nickname: "lauveer", label: "LCQ", seasonEloRate: 2137 },
    games: [],
    bracketUrl: "https://magmamcsr.com/events/playoffs/s11/bracket",
    matchId: g1Id,
    copyVariety: true,
  });
  assert.equal(varied.split("\n\n")[1], SUBSCRIBE_LINE_VARIANTS[subscribeIdx]);
  assert.equal(varied.split("\n\n").at(-2), CLOSER_VARIANTS[closerIdx]);
  assert.ok(!varied.includes(SUBSCRIBE_LINE) && !varied.includes(CLOSER));
}

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

const shelfHidden = (): number[] => {
  const file = path.join(config.mediaDir, ".dashboard.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).hidden ?? []) : [];
};

// A series still being played (2-0 of a first-to-3) is not the series: nothing is joined,
// retitled, hidden or pruned, whoever asks — a Render, an export's settle, `--join-only`.
{
  history = [g2, g1];
  writeFileSync(final(101), "x");
  const calls: number[] = [];
  const undecided = await assembleSeries(101, {
    join: async () => assert.fail("joined a series nobody has taken yet"),
    probe: async () => 600,
    extract: async (_s: string, at: number) => void calls.push(at),
  });
  assert.deepEqual(undecided, { kind: "undecided", firstGameId: 101 });
  assert.ok(
    !existsSync(path.join(dir(101), "series.json")) && !existsSync(path.join(dir(101), "series-101.mp4")),
  );
  assert.ok(existsSync(final(101)) && existsSync(final(102)), "the games' exports are kept");
  assert.ok(!shelfHidden().includes(102), "game 2 stays on the list");
  assert.ok(!existsSync(path.join(dir(101), "match-101.title.txt")), "game 1 is not retitled as the series");
  // Every game rendered and exported but no seed through: renderSeries waits, it has not failed.
  const waiting = await renderSeries(
    101,
    { renderGame: async () => "rendered", exportGame: async () => "exported", log: () => {} },
    { join: async () => assert.fail("joined a series nobody has taken yet"), probe: async () => 600 },
  );
  assert.deepEqual(waiting, { kind: "undecided", firstGameId: 101 });
  assert.equal(seriesProgress(101)?.stage, "waiting: series not decided");
  assert.equal(seriesProgress(101)?.done, true, "settled: the board offers the button again");
  // The bracket's own score decides it when a game is not among those found (a short forfeit).
  const { _resetPlayoffsForTest } = await import("./playoffs.js");
  slot.participants[0]!.roundScore = 3;
  _resetPlayoffsForTest();
  await assert.rejects(
    assembleSeries(101, {
      join: async () => {
        throw new Error("joining");
      },
      probe: async () => 600,
      probeResolution: async () => null,
    }),
    /joining/,
    "the bracket says decided: the join runs",
  );
  slot.participants[0]!.roundScore = 0;
  _resetPlayoffsForTest();
  rmSync(final(101));
  history = [g3, g2, g1];
  console.log("OK: an undecided series is not joined");
}

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
  // What real ffprobe reads off these placeholder exports: no size. Left to the default, a box
  // without ffprobe (CI's runner) failed the spawn and the run came back "incomplete".
  probeResolution: async () => null,
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
assert.ok(
  description.includes(
    // Game 1's own split (its timelines, above) follows its header, offset into the joined
    // video (10s lead-in + 107s to Nether Enter); games 2 and 3 have no timeline data and keep
    // just their header and Result, never the bracket's seed or a score.
    "0:00 game 1 · village seed\n1:57 Nether Enter\n8:10 Result\n10:00 game 2 · desert temple seed\n" +
      "18:10 Result\n18:20 game 3\n26:30 Result\n",
  ),
  `a chapter per game plus each game's own split/Result chapters, offset into the series:\n${description}`,
);
assert.ok(
  description.includes(
    // Game 2's room seated them the other way round; the line keeps game 1's order.
    "game 2: https://magmamcsr.com/ranked/player/lauveer/matches/102?season=12 · lauveer's stream https://www.twitch.tv/videos/2?t=420s · edcr's stream https://www.twitch.tv/videos/1?t=520s",
  ),
  description,
);
assert.ok(description.includes("as the 1st seed"));
assert.ok(
  !description.split("\n\n")[0]!.includes("#"),
  `no hash in assembled series description opening:\n${description}`,
);
assert.equal(
  readFileSync(path.join(dir(101), "match-101.chapters.txt"), "utf8"),
  "0:00 game 1 · village seed\n1:57 Nether Enter\n8:10 Result\n10:00 game 2 · desert temple seed\n" +
    "18:10 Result\n18:20 game 3\n26:30 Result",
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

// Current: every game held by the series, nothing newer — the join is not redone, nothing is
// rendered, and no game is copied back out of the series only to be pruned again.
extracted.length = 0;
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
assert.deepEqual(extracted, [], "a current series takes no game back out of the joined video");

// An export in flight (`final-<id>.part.mp4`, export:fast's temp file) is the newer copy of its
// game: the join waits for its own settle and never extracts the old one over it.
{
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(final(103), "newer"); // would otherwise re-join
  const part = path.join(dir(102), "final-102.part.mp4");
  writeFileSync(part, "encoding");
  const joinsBefore = joins.length;
  const inFlight = await assembleSeries(101, seams);
  assert.deepEqual(inFlight, { kind: "incomplete", firstGameId: 101, missing: [102] });
  assert.deepEqual(extracted, [], "nothing taken out of the series while a game re-encodes");
  assert.equal(joins.length, joinsBefore);
  assert.equal(readFileSync(part, "utf8"), "encoding", "the encoder's file is untouched");
  assert.ok(existsSync(final(103)), "nothing pruned");
  rmSync(part);
  rmSync(final(103));
  console.log("OK: a game re-encoding holds the join");
}

// Game 1's upload reading series-101.mp4: a newer export that would re-join waits, so the file
// is not renamed under the upload. Nothing extracted, joined or pruned; the newer export stays
// for the next settle or the series button to join.
{
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(final(103), "newer");
  const before = readFileSync(path.join(dir(101), "series-101.mp4"), "utf8");
  const joinsBefore = joins.length;
  extracted.length = 0;
  const waiting = await assembleSeries(101, { ...seams, uploading: (id) => id === 101 });
  assert.deepEqual(waiting, { kind: "uploading", firstGameId: 101 });
  assert.equal(joins.length, joinsBefore, "never re-joined under a running upload");
  assert.deepEqual(extracted, []);
  assert.equal(readFileSync(path.join(dir(101), "series-101.mp4"), "utf8"), before);
  assert.ok(existsSync(final(103)), "the newer export is kept for the join after the upload");
  rmSync(final(103));
  console.log("OK: a running upload of the series holds the re-join");
}

// A blocked player's match refuses outright — before any render, export or disk write
// (config.blockedPlayers). The dashboard's own route also refuses up front so the HTTP response
// carries it; this is what `npm run series` gets, since both call this one function.
{
  const savedBlocked = config.blockedPlayers;
  config.blockedPlayers = ["edcr"]; // one of this series' own two seeds
  const calls: string[] = [];
  const blocked = await renderSeries(
    101,
    {
      renderGame: async (id) => {
        calls.push(`render ${id}`);
        return null;
      },
      exportGame: async (id) => {
        calls.push(`export ${id}`);
        return null;
      },
      log: () => {},
    },
    seams,
  );
  assert.deepEqual(blocked, { kind: "blocked", matchId: 101 });
  assert.deepEqual(calls, [], "nothing is rendered or exported for a blocked player's series");
  // The join itself refuses too — `npm run series -- --join-only` and every export's settle call
  // it directly: a newer export that would re-join is neither joined, extracted nor pruned.
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(final(103), "newer");
  const joinsBefore = joins.length;
  extracted.length = 0;
  assert.deepEqual(await assembleSeries(101, seams), { kind: "blocked", matchId: 101 });
  assert.equal(joins.length, joinsBefore, "a blocked player's series is never joined");
  assert.deepEqual(extracted, []);
  assert.ok(existsSync(final(103)), "and its exports are left alone");
  rmSync(final(103));
  config.blockedPlayers = savedBlocked;
  console.log("OK: renderSeries and assembleSeries refuse a blocked player's series outright");
}

// A newer export of one game re-joins: the other two come back out of the series at their
// recorded offsets, the three are joined, the exports go again. Game 2's `.part.mp4` left by a
// failed or killed export hours ago is no encode in flight: it must not wedge the re-join.
await new Promise((r) => setTimeout(r, 20));
writeFileSync(final(103), "xx");
const leftover = path.join(dir(102), "final-102.part.mp4");
writeFileSync(leftover, "killed mid-encode");
const { utimesSync } = await import("node:fs");
utimesSync(leftover, new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000));
joins.length = 0;
extracted.length = 0;
const rejoined = await assembleSeries(101, seams);
assert.equal(rejoined.kind, "joined");
assert.equal(joins.length, 1);
assert.deepEqual(extracted, [0, 600], "games 1 and 2 extracted at their chapter offsets");
assert.ok(!existsSync(final(103)));
rmSync(leftover);
console.log("OK: a stale .part from a dead export does not hold the re-join");

// A game whose sync moved after the join is stale, and the series says which one.
writeFileSync(
  path.join(dir(102), "sync.json"),
  JSON.stringify({ left: 1, right: 1, confidence: 1, detail: "", source: "manual" }),
);
await new Promise((r) => setTimeout(r, 20));
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

/* --- exportUpscale1440: games exported at different resolutions refuse the join ------------- */
{
  // A fresh export of game 1, newer than the series file, forces a rejoin attempt; games 2 and 3
  // come back out of the series as before, recovered from it rather than re-exported.
  writeFileSync(final(101), "yy");
  utimesSync(final(101), new Date(Date.now() + 30000), new Date(Date.now() + 30000));
  const resByFile: Record<string, { width: number; height: number }> = {
    [final(101)]: { width: 2560, height: 1440 },
    [final(102)]: { width: 1920, height: 1080 },
    [final(103)]: { width: 1920, height: 1080 },
  };
  const joinsBefore = joins.length;
  const mixed = await assembleSeries(101, {
    ...seams,
    probeResolution: async (file: string) => resByFile[file] ?? null,
  });
  assert.deepEqual(mixed, {
    kind: "mixed-resolution",
    firstGameId: 101,
    mismatched: [
      { matchId: 101, width: 2560, height: 1440 },
      { matchId: 102, width: 1920, height: 1080 },
      { matchId: 103, width: 1920, height: 1080 },
    ],
  });
  assert.equal(joins.length, joinsBefore, "a mixed-resolution series is never -c copy joined");
  assert.ok(existsSync(path.join(dir(101), "series-101.mp4")), "the old joined video is left alone");
  console.log("OK: assembleSeries refuses to -c copy a series exported at mixed resolutions");
  // The refusal returns before pruning, so games 2 and 3's recovered exports are left on disk —
  // clean them back up so the tests below see the same "freshly joined, finals pruned" state
  // the mixed-resolution check interrupted.
  for (const id of [101, 102, 103]) rmSync(final(id), { force: true });
}

/* --- No game's Short is copied in; the series' Short game is its cut's, else its pick's ------- */

writeFileSync(path.join(dir(103), "short-103.mp4"), "s");
writeFileSync(
  path.join(dir(103), "short-103.title.txt"),
  "Can the LCQ take down the #1 seed? #minecraft #mcsr\n",
);
const kept = await assembleSeries(101, seams);
assert.equal(kept.kind, "current");
assert.ok(
  !existsSync(path.join(dir(101), "short-101.mp4")),
  "a game's own Short is never adopted by the series",
);
assert.equal(await seriesShortGame(101), null, "nothing picked, nothing cut");
writeFileSync(path.join(dir(101), "short-101.pick.json"), JSON.stringify({ gameMatchId: 102 }));
assert.equal(await seriesShortGame(101), 102, "the pick names the game");
writeFileSync(path.join(dir(101), "short-101.cut.json"), JSON.stringify({ gameMatchId: 103 }));
assert.equal(await seriesShortGame(101), 103, "and the cut, once there is one, is what went out");
// A Short copied in before 23 Sept 2026 recorded where it came from as `fromMatchId`.
writeFileSync(
  path.join(dir(101), "short-101.cut.json"),
  JSON.stringify({ pick: 0, startMs: 1, fromMatchId: 102 }),
);
assert.equal(await seriesShortGame(101), 102);

/* --- hookFactsMatchId: a series video's hook chips read the clinching game, not game 1 --------
   (8 Oct 2026, chip-truth). Real record, edcr-lauveer Round of 16 (/media/13303619/series.json,
   assembled 22 Sept 2026): 5 games, edcr won games 1/3/5, so game 5 is the one that actually
   decided it — game 1's own margin, pace and lead-change facts are not the video's whole story
   once four more games followed it. */
{
  const realSeries: import("./series.js").SeriesRecord = {
    season: 11,
    slotId: 9,
    round: "Round of 16",
    bestOf: 5,
    firstTo: 3,
    seeds: [
      { uuid: "635f35ee69ed4f0c94ff26ece4818956", nickname: "edcr", label: "#1 seed", seasonEloRate: 2688 },
      { uuid: "410e5776b03a424d8740557bac2d9014", nickname: "lauveer", label: "LCQ", seasonEloRate: 2137 },
    ],
    games: [
      { matchId: 13303619, gameNo: 1, winnerUuid: "635f35ee69ed4f0c94ff26ece4818956", durationSec: 550.4 },
      { matchId: 13303909, gameNo: 2, winnerUuid: "410e5776b03a424d8740557bac2d9014", durationSec: 646.067 },
      { matchId: 13304282, gameNo: 3, winnerUuid: "635f35ee69ed4f0c94ff26ece4818956", durationSec: 614.7 },
      { matchId: 13304568, gameNo: 4, winnerUuid: "410e5776b03a424d8740557bac2d9014", durationSec: 656.017 },
      { matchId: 13304815, gameNo: 5, winnerUuid: "635f35ee69ed4f0c94ff26ece4818956", durationSec: 550.7 },
    ],
    assembledAt: "2026-09-22T09:26:59.484Z",
    shortFromMatchId: 13304815,
  };
  assert.equal(
    hookFactsMatchId(13303619, realSeries),
    13304815,
    "the clinching game (5), not game 1 (its own directory)",
  );
  assert.equal(hookFactsMatchId(13303619, null), 13303619, "no series: the match itself, unchanged");
  assert.equal(
    hookFactsMatchId(13303619, { ...realSeries, games: [] }),
    13303619,
    "a series record with no games recorded falls back to the match itself",
  );
  console.log("OK: hookFactsMatchId reads the game that decided the series, not game 1");
}

console.log("series: all checks passed");
