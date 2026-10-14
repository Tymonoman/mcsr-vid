// Contract test for src/playoffs/series.ts (with the series path of src/pipeline/chapters.ts and
// description.ts it writes through), from the docs: CLAUDE.md "Playoffs", the `npm run series`
// row, "exportUpscale1440" and `nightlyUpload`'s 23:00 series slot; handbook/claude-md-reference.md
// "A series is one video, and game 1's directory is the series", "Publish kit" and
// "exportUpscale1440". series.test.ts pins the happy path on one fixture; this file covers the
// promises it does not, end to end through `renderSeries`/`assembleSeries` where it can.
//
// The promises the docs make, as checked below:
//  S1  A series is one video and game 1's directory is the series: whichever game's id starts it,
//      `series-<g1>.mp4` lands in game 1's directory, and `findExportedVideo` hands that file to
//      the upload even with game 1's own export still beside it.
//  S2  The exports are joined in game order (`ffmpeg -f concat -c copy`, a seam here) and
//      `series.json` beside the video names the games and their lengths.
//  S3  The join deletes the games' own exports, reversibly: the board still counts every game as
//      exported (held by the series); `prune: false` keeps them; a re-join takes each held game
//      back out at its recorded offset for its recorded length.
//  S4  Games 2..n are hidden once joined; game 1 (the series) never is.
//  S5  Chapters name each game's world ("0:00 game 1 · village seed", `seedPhrase`), never the
//      bracket seed or a score; a game with no known world keeps a bare header.
//  S6  Each game's own split/Result chapters follow its header, offset to where that game starts
//      in the joined video (its chapter plus its own export's match start, a 3 s card's 6 s
//      included), and the merged list keeps YouTube's 10 s minimum; every game keeps its header.
//  S7  `series.json` carries each game's match start, copied at the join, so `gameMatchStarts`
//      finds every match start in the joined video.
//  S8  No surface prints a series score: the series' title, description, chapters and tags are
//      byte-identical whoever won which game; the title carries no game number.
//  S9  `exportStale` reads the record: a sync fix on game 3 makes the series stale and names game
//      3; the join refuses until game 3 is re-exported, then follows.
//  S10 Games exported at different resolutions are never `-c copy` joined, and the refusal names
//      them — on a first join nothing is deleted, hidden or written either.
//  S11 A series publishes at its own slot, 23:00 UTC (ranked 19:00): a joined series' directory
//      takes the series hour, and so does a playoff game 1 not joined yet.
//  S12 `npm run series` renders every game missing an export, one at a time, then joins; a game
//      that fails stops the run, keeps what was exported, joins nothing.
//  S13 A series joins itself once its *last* game's export lands — a joined series' last game is
//      the one that reached `firstTo` — and a game the API indexed late joins on its arrival.
//
// Hermetic: a temp media directory per scenario, the API stubbed at global fetch, ffmpeg/ffprobe
// stubbed at `JoinSeams`, the render/export at `SeriesRunners`. The bracket is the saved S11 one
// (src/fixtures/playoffs-11.json) with every nickname replaced by a neutral "RunnerX"; every game,
// and so every winner, is synthetic.
// Run: npx tsx src/playoffs/series.contract.test.ts
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, DEFAULTS } from "../config.js";
import type { MatchInfo, PlayoffBracket } from "../api/types.js";

config.youtubePlaylistUrl = "https://www.youtube.com/playlist?list=PLcontract";

// Every scenario's media directory, removed on exit so a failed assert cleans up too.
const tempDirs: string[] = [];
process.on("exit", () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
config.supportUrl = "";

/* --- Deviation reporting: keep the doc's assertion, report and continue ------------------------ */

const deviations: string[] = [];
async function deviation(clause: string, check: () => void | Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    deviations.push(clause);
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

/* --- The bracket, anonymised, and a synthetic series in slot 9 --------------------------------- */

const envelope = JSON.parse(readFileSync(new URL("../fixtures/playoffs-11.json", import.meta.url), "utf8"));
const real: PlayoffBracket = envelope.data.data;
const bracket: PlayoffBracket = {
  ...real,
  players: real.players.map((p, i) => ({ ...p, nickname: `Runner${String.fromCharCode(65 + i)}` })),
};
const slot9 = bracket.matches.find((m) => m.id === 9)!;
const A = bracket.players[0]!; // "#1 seed"
const P = bracket.players[15]!; // "LCQ"
const start = slot9.startTime!;

const byId = new Map<number, MatchInfo>();
let history: MatchInfo[] = [];
const feed = (m: MatchInfo) => {
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
  assert.equal(url.hostname, "api.mcsrranked.com", `unexpected host: ${url}`);
  if (url.pathname === "/playoffs" || url.pathname === "/playoffs/11")
    return ok({ data: bracket, next: null, prev: 10 });
  if (url.pathname.startsWith("/playoffs/"))
    return new Response(JSON.stringify({ status: "error", data: "not found" }), { status: 404 });
  if (/^\/users\/[^/]+\/matches$/.test(url.pathname)) return ok(history.map(feed));
  const user = /^\/users\/([^/]+)$/.exec(url.pathname);
  if (user) {
    const p = bracket.players.find((x) => x.uuid === decodeURIComponent(user[1]!))!;
    return ok({
      uuid: p.uuid,
      nickname: p.nickname,
      eloRate: 2000,
      eloRank: 1,
      country: null,
      statistics: {},
    });
  }
  const m = /^\/matches\/(\d+)$/.exec(url.pathname);
  if (m && byId.has(Number(m[1]))) return ok(byId.get(Number(m[1])));
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const {
  assembleSeries,
  gameMatchStarts,
  readSeriesRecord,
  renderSeries,
  seriesOutputPath,
  seriesProgress,
  seriesState,
} = await import("./series.js");
const { _resetPlayoffsForTest, playoffBoard } = await import("./playoffs.js");
const { buildSeriesDescription } = await import("../pipeline/description.js");
const { exportStale } = await import("../pipeline/syncFile.js");
const { hiddenMatchIds } = await import("../dashboard/matchShelf.js");
const { findExportedVideo } = await import("../youtube/youtubeStore.js");
const { publishHourFor, publishSlotFor } = await import("../youtube/publishSlot.js");

const dir = (id: number) => path.join(config.mediaDir, String(id));
const final = (id: number) => path.join(dir(id), `final-${id}.mp4`);
const textOf = (id: number, kind: string) =>
  readFileSync(path.join(dir(id), `match-${id}.${kind}.txt`), "utf8");
const future = (sec: number) => new Date(Date.now() + sec * 1000);

/**
 * A fresh media directory holding one series of slot 9, a game per winner, ids `base+1..`. The
 * worlds, splits, results' lengths, export lengths and match starts are the same in every
 * scenario; only the ids, the winners and what is exported differ.
 *   game 1: village seed, Nether at 1:47, result 8:00, export 600 s, a 7 s card (no record = 10 s)
 *   game 2: buried treasure seed, seated the other way, Nether at 1:35, result 7:30, export 560 s,
 *           a 3 s card (final-<id>.json says match start at 6 s)
 *   game 3: world unknown, no splits, result 8:20, export 700 s
 *   game 4: shipwreck seed, seated the other way, no splits, result 6:40, export 650 s
 */
function series(base: number, winners: Array<string | null>, exported = winners.map(() => false)): number[] {
  config.mediaDir = mkdtempSync(path.join(tmpdir(), `series-contract-${base}-`));
  tempDirs.push(config.mediaDir);
  const ids = winners.map((_, i) => base + 1 + i);
  const seats = [
    [A, P],
    [P, A],
    [A, P],
    [P, A],
  ];
  const seedTypes = ["VILLAGE", "BURIED_TREASURE", null, "SHIPWRECK"];
  const resultMs = [480_000, 450_000, 500_000, 400_000];
  const timelines = [
    [
      { uuid: A.uuid, time: 107_000, type: "story.enter_the_nether" },
      { uuid: P.uuid, time: 131_000, type: "story.enter_the_nether" },
    ],
    [
      { uuid: A.uuid, time: 120_000, type: "story.enter_the_nether" },
      { uuid: P.uuid, time: 95_000, type: "story.enter_the_nether" },
    ],
    [],
    [],
  ];
  history = ids.map(
    (id, i) =>
      ({
        id,
        type: 3,
        season: 12,
        date: start + 300 + 900 * i,
        players: seats[i]!.map((p) => ({ uuid: p.uuid, nickname: p.nickname })),
        spectators: [],
        result: { uuid: winners[i], time: resultMs[i] },
        forfeited: false,
        changes: [],
        vod: [],
        rank: { season: null, allTime: null },
        tag: null,
        timelines: timelines[i],
        completions: [],
        seedType: seedTypes[i],
        bastionType: null,
      }) as unknown as MatchInfo,
  );
  for (const [i, m] of history.entries()) {
    byId.set(m.id, m);
    mkdirSync(dir(m.id), { recursive: true });
    // Both VODs on record, so the stream links never go looking for one.
    writeFileSync(
      path.join(dir(m.id), "vods.json"),
      JSON.stringify([
        { uuid: A.uuid, url: "https://www.twitch.tv/videos/1", startsAt: m.date - 1000 },
        { uuid: P.uuid, url: "https://www.twitch.tv/videos/2", startsAt: m.date - 900 },
      ]),
    );
    if (i === 1)
      writeFileSync(path.join(dir(m.id), `final-${m.id}.json`), JSON.stringify({ matchStartSec: 6 }));
    if (exported[i]) writeFileSync(final(m.id), "export");
  }
  return ids;
}

const LENGTHS = [600, 560, 700, 650];
const joins: string[][] = [];
const extracts: Array<[string, number, number, string]> = [];
const seams = (ids: number[]) => ({
  join: async (files: readonly string[], out: string) => {
    joins.push([...files]);
    writeFileSync(out, "joined");
  },
  probe: async (file: string) => LENGTHS[ids.findIndex((id) => file.endsWith(`final-${id}.mp4`))]!,
  extract: async (from: string, startSec: number, durationSec: number, out: string) => {
    extracts.push([from, startSec, durationSec, out]);
    writeFileSync(out, "extracted");
  },
  probeResolution: async () => ({ width: 1920, height: 1080 }),
});
const runners = (log: string[], failExportOf: number | null = null) => ({
  renderGame: async (id: number) => {
    log.push(`render ${id}`);
    return null;
  },
  exportGame: async (id: number) => {
    log.push(`export ${id}`);
    if (id === failExportOf) return "encoder exited 1";
    writeFileSync(final(id), "export");
    return null;
  },
  log: () => {},
});

/* --- S1..S7: one series rendered from game 3's id, end to end ---------------------------------- */

// A decided series: first to 3, taken 3–0 (synthetic).
const [g1, g2, g3] = series(300, [A.uuid, A.uuid, A.uuid]) as [number, number, number];
{
  joins.length = 0;
  const log: string[] = [];
  // Started from the *last* game's id, as the board's "Render the series" may be.
  const result = await renderSeries(g3, runners(log), seams([g1, g2, g3]));
  assert.equal(result.kind, "joined");
  // S12: every game missing an export, one at a time, in game order.
  assert.deepEqual(log, [
    `render ${g1}`,
    `export ${g1}`,
    `render ${g2}`,
    `export ${g2}`,
    `render ${g3}`,
    `export ${g3}`,
  ]);

  // S1: the series is game 1's, whoever asked.
  const seriesPath = seriesOutputPath(dir(g1), g1);
  assert.equal(result.kind === "joined" && result.path, seriesPath);
  assert.ok(existsSync(seriesPath), "series-<g1>.mp4 in game 1's directory");
  for (const id of [g2, g3])
    assert.deepEqual(
      readdirSync(dir(id)).filter((f) => f.startsWith("series")),
      [],
      `no series file or record in game ${id}'s directory`,
    );

  // S2: joined once, in game order; the record names the games and their lengths.
  assert.deepEqual(joins, [[final(g1), final(g2), final(g3)]]);
  const record = (await readSeriesRecord(dir(g1)))!;
  assert.deepEqual(
    record.games.map((g) => [g.matchId, g.gameNo, g.durationSec]),
    [
      [g1, 1, 600],
      [g2, 2, 560],
      [g3, 3, 700],
    ],
  );
  assert.deepEqual([record.round, record.bestOf, record.firstTo], ["Round of 16", 5, 3]);

  // S7: each game's match start copied at the join (game 2's 3 s card: 6 s; the rest 10 s), so a
  // reader of the joined video (the Short's proxy cut, the pick preview) finds every match start.
  assert.deepEqual(
    record.games.map((g) => g.matchStartSec),
    [10, 6, 10],
  );
  assert.deepEqual(gameMatchStarts(record.games), [10, 606, 1170]);

  // S3: the games' exports are gone — and the board still counts them, because the series holds them.
  assert.ok(
    [g1, g2, g3].every((id) => !existsSync(final(id))),
    "the join deleted every game's export",
  );
  _resetPlayoffsForTest();
  const board = await playoffBoard(start + 3600);
  const slot = board.slots.find((s) => s.id === 9)!;
  assert.deepEqual(
    slot.games.map((g) => g.matchId),
    [g1, g2, g3],
  );
  const state = (await seriesState(slot))!;
  assert.deepEqual(state.exported, [true, true, true], "held by the series counts as exported");
  assert.equal(state.joined, true);
  assert.equal(state.progress, "done");

  // S4: games 2 and 3 are inside game 1's video; game 1 is the series and stays listed.
  assert.deepEqual([...hiddenMatchIds()].sort(), [g2, g3]);

  // S5 + S6: a header per game naming its world, each game's own splits and Result after it,
  // offset to where that game starts in the joined video (game 2: 600 + 6 + 95 s = 11:41).
  const chapters = textOf(g1, "chapters");
  assert.equal(
    chapters,
    [
      "0:00 game 1 · village seed",
      "1:57 Nether Enter",
      "8:10 Result",
      "10:00 game 2 · buried treasure seed",
      "11:41 Nether Enter",
      "17:36 Result",
      "19:20 game 3",
      "27:50 Result",
    ].join("\n"),
  );
  for (const line of chapters.split("\n")) {
    // The world, never the bracket's seed: no "#1 seed", no "1st seed", no "LCQ".
    if (/seed/i.test(line))
      assert.match(line, /· (village|buried treasure) seed$/, `a bracket seed in: ${line}`);
    assert.ok(!/#|\blcq\b|\b\d+(st|nd|rd|th) seed/i.test(line), `a bracket seed in: ${line}`);
  }
  // The description carries the same chapter block, and game 1's link first (it pairs the upload).
  const description = textOf(g1, "description");
  assert.ok(description.includes(chapters), "the description's chapters are the chapters file");
  assert.ok(description.indexOf(`/matches/${g1}`) < description.indexOf(`/matches/${g2}`));

  // S11: a joined series publishes at the series hour, a ranked match at its own.
  assert.equal(DEFAULTS.seriesPublishHourUtc, 23);
  assert.equal(DEFAULTS.publishHourUtc, 19);
  assert.equal(publishHourFor(dir(g1)), 23, "the series' directory takes 23:00 UTC");
  const ranked = path.join(config.mediaDir, "1");
  mkdirSync(ranked, { recursive: true });
  assert.equal(publishHourFor(ranked), 19, "a plain match directory keeps 19:00 UTC");
}

/* --- S3: a re-join takes the held games back out at their recorded offsets --------------------- */
{
  joins.length = 0;
  extracts.length = 0;
  // Game 2 re-exported after the join (a sync fix's Re-encode): the join must follow.
  writeFileSync(final(g2), "re-export");
  utimesSync(final(g2), future(5), future(5));
  const seriesPath = seriesOutputPath(dir(g1), g1);
  const again = await assembleSeries(g2, seams([g1, g2, g3]));
  assert.equal(again.kind, "joined");
  assert.deepEqual(
    extracts,
    [
      [seriesPath, 0, 600, final(g1)],
      [seriesPath, 1160, 700, final(g3)],
    ],
    "games 1 and 3 copied out of the series at their chapter offsets, for their recorded lengths",
  );
  assert.deepEqual(joins, [[final(g1), final(g2), final(g3)]]);
  assert.ok(
    [g1, g2, g3].every((id) => !existsSync(final(id))),
    "and deleted again after the join",
  );
}

/* --- S9: a sync fix on game 3 makes the series stale and names game 3 -------------------------- */
{
  const seriesPath = seriesOutputPath(dir(g1), g1);
  utimesSync(seriesPath, future(10), future(10));
  writeFileSync(
    path.join(dir(g3), "sync.json"),
    JSON.stringify({ left: 1, right: 2, confidence: 1, detail: "", source: "manual" }),
  );
  utimesSync(path.join(dir(g3), "sync.json"), future(20), future(20));
  const stale = exportStale(dir(g1), seriesPath);
  assert.equal(stale.stale, true, "the published series is out of sync once game 3's sync moved");
  assert.equal(stale.staleMatchId, g3, "and the message names game 3");
  joins.length = 0;
  const refused = await assembleSeries(g1, seams([g1, g2, g3]));
  assert.deepEqual(refused, { kind: "stale", firstGameId: g1, stale: [g3] });
  assert.equal(joins.length, 0, "a stale game is never joined as it was");
  // "The join deletes the games' own exports — a series is fifty minutes of 1080p60 and the disk
  // holds one copy — and takes a game back out of the series … whenever a re-join needs it." A
  // refused join needs nothing taken out yet: games 1 and 2 should still live in the series only.
  await deviation(
    'handbook "A series is one video": the disk holds one copy; a game is taken back out of the series "whenever a re-join needs it"',
    () =>
      assert.ok(
        [g1, g2].every((id) => !existsSync(final(id))),
        "a join refused as stale still copied games 1 and 2 back out of the series (a second copy on disk until game 3 is re-exported)",
      ),
  );
  // Re-exported, the join follows.
  writeFileSync(final(g3), "resynced");
  utimesSync(final(g3), future(30), future(30));
  const fixed = await assembleSeries(g1, seams([g1, g2, g3]));
  assert.equal(fixed.kind, "joined");
  utimesSync(seriesPath, future(40), future(40));
  assert.equal(exportStale(dir(g1), seriesPath).stale, false, "fresh again once re-joined");
}

/* --- S8: the series' text is the same whoever won which game ------------------------------------ */
{
  const textFiles = (id: number) => ["title", "description", "chapters", "tags"].map((k) => textOf(id, k));
  const first = textFiles(g1);
  const firstDir = config.mediaDir;
  // The same three games, the other runner winning every one of them.
  const [h1, h2, h3] = series(500, [P.uuid, P.uuid, P.uuid]) as [number, number, number];
  const r = await renderSeries(h1, runners([]), seams([h1, h2, h3]));
  assert.equal(r.kind, "joined");
  const second = textFiles(h1).map((t) => t.replace(/\b50([123])\b/g, "30$1"));
  assert.deepEqual(
    second,
    first,
    "a different winner of any game changes no title, description, chapter or tag",
  );
  const [title] = first;
  assert.ok(!/\bgame\s*\d/i.test(title!), `no game number on a series title: ${title}`);
  for (const text of first) {
    const withoutTimes = text.replace(/\b\d+:\d\d(:\d\d)?\b/g, "");
    assert.ok(!/\b\d\s*[–-]\s*\d\b/.test(withoutTimes), `a score-shaped pair in:\n${text}`);
    assert.ok(
      !/\b(won|wins|winner|swept|sweep|clinch\w*|eliminat\w*|advances?)\b/i.test(text),
      `a result word in:\n${text}`,
    );
  }
  config.mediaDir = firstDir;
}

/* --- S1: the upload takes the series even with game 1's own export beside it (prune: false) ---- */
{
  const [k1, k2, k3] = series(700, [A.uuid, A.uuid, A.uuid], [true, true, true]) as [number, number, number];
  const r = await assembleSeries(k2, { ...seams([k1, k2, k3]), prune: false });
  assert.equal(r.kind, "joined");
  assert.ok(
    [k1, k2, k3].every((id) => existsSync(final(id))),
    "prune: false keeps every game's export",
  );
  assert.deepEqual(
    findExportedVideo(k1, [A.nickname, P.nickname]),
    { path: seriesOutputPath(dir(k1), k1) },
    "game 1's directory uploads the series, not game 1 alone",
  );
}

/* --- S10: mixed resolutions — refused on a first join, nothing touched ------------------------- */
{
  const [m1, m2, m3] = series(400, [A.uuid, A.uuid, A.uuid], [true, true, true]) as [number, number, number];
  joins.length = 0;
  const r = await assembleSeries(m1, {
    ...seams([m1, m2, m3]),
    probeResolution: async (file: string) =>
      file.endsWith(`final-${m2}.mp4`) ? { width: 2560, height: 1440 } : { width: 1920, height: 1080 },
  });
  assert.equal(r.kind, "mixed-resolution");
  assert.ok(
    r.kind === "mixed-resolution" && r.mismatched.some((x) => x.matchId === m2 && x.width === 2560),
    "the refusal names the 1440p game",
  );
  assert.equal(joins.length, 0, "never -c copy joined");
  assert.ok(
    [m1, m2, m3].every((id) => existsSync(final(id))),
    "no export deleted on a refusal",
  );
  assert.ok(!existsSync(path.join(dir(m1), "series.json")), "no record written");
  assert.ok(!existsSync(seriesOutputPath(dir(m1), m1)), "no series video");
  assert.equal(hiddenMatchIds().size, 0, "no game hidden behind a series that does not exist");
  assert.ok(!existsSync(path.join(dir(m1), `match-${m1}.title.txt`)), "game 1's text not rewritten");
}

/* --- S12: a game that fails stops the run; the exported games are kept ------------------------- */
{
  // Decided (3–0): an undecided series answers "undecided" before it looks at any export (S13).
  const [f1, f2, f3] = series(600, [A.uuid, A.uuid, A.uuid]) as [number, number, number];
  joins.length = 0;
  const log: string[] = [];
  const r = await renderSeries(f1, runners(log, f2), seams([f1, f2, f3]));
  assert.equal(r.kind, "incomplete");
  assert.deepEqual(
    log,
    [`render ${f1}`, `export ${f1}`, `render ${f2}`, `export ${f2}`],
    "game 3 never started",
  );
  assert.equal(joins.length, 0, "nothing joined");
  assert.ok(existsSync(final(f1)), "game 1's export kept for the next run");
  assert.ok(!existsSync(seriesOutputPath(dir(f1), f1)));
  const progress = seriesProgress(f1)!;
  assert.ok(
    progress.done && progress.stage.startsWith("failed:"),
    `the board shows the failure: ${progress.stage}`,
  );
  // And the join on its own says which games it still waits for, deleting nothing.
  const waiting = await assembleSeries(f1, seams([f1, f2, f3]));
  assert.deepEqual(waiting, { kind: "incomplete", firstGameId: f1, missing: [f2, f3] });
  assert.ok(existsSync(final(f1)), "an incomplete series deletes no export");
}

/* --- S11: game 1 not joined yet goes out at the series' hour ----------------------------------- */
{
  const [s1] = series(800, [A.uuid, P.uuid, A.uuid]) as [number, number, number];
  _resetPlayoffsForTest();
  const now = Date.UTC(2026, 9, 14, 12, 0, 0);
  const slot = await publishSlotFor(s1, now);
  assert.equal(
    slot.at.toISOString(),
    "2026-10-14T23:00:00.000Z",
    "a playoff game 1 takes the 23:00 UTC slot",
  );
  // A ranked match the same day keeps 19:00 UTC.
  const ranked = JSON.parse(
    readFileSync(new URL("../fixtures/match-13560037.json", import.meta.url), "utf8"),
  );
  byId.set(ranked.id, ranked);
  assert.equal((await publishSlotFor(ranked.id, now)).at.toISOString(), "2026-10-14T19:00:00.000Z");
}

/* --- S13: only a decided series is one video; a game the API indexed late still joins ---------- */
{
  // Four games, 3–1, first to 3 (synthetic). When the first three exports land the API has
  // indexed only those three: 2–1, nobody has reached firstTo, the series is not over.
  const ids = series(900, [A.uuid, A.uuid, P.uuid, A.uuid], [true, true, true, false]);
  const [d1, d2, d3, d4] = ids as [number, number, number, number];
  const all = history;
  history = all.slice(0, 3);
  const early = await assembleSeries(d1, seams(ids));
  await deviation(
    'handbook "A series is one video": a series joins itself "once its last game\'s export lands"; chip-truth: a joined series\' last game "is the one that reached firstTo"',
    () =>
      assert.notEqual(
        early.kind,
        "joined",
        "a 2–1 series (first to 3) was joined — exports deleted, games 2..3 hidden, game 1's text rewritten as the series — before anyone reached firstTo",
      ),
  );
  assert.deepEqual(early, { kind: "undecided", firstGameId: d1 }, "the 2–1 series waits, nothing missing");
  // Game 4 indexed and exported: the series becomes the four games, in order, whatever happened above.
  history = all;
  writeFileSync(final(d4), "export");
  utimesSync(final(d4), future(50), future(50));
  joins.length = 0;
  const done = await assembleSeries(d4, seams(ids));
  assert.equal(done.kind, "joined");
  assert.deepEqual(joins.at(-1), ids.map(final), "joined in game order, the late game last");
  const record = (await readSeriesRecord(dir(d1)))!;
  assert.deepEqual(
    record.games.map((g) => [g.matchId, g.durationSec]),
    [
      [d1, 600],
      [d2, 560],
      [d3, 700],
      [d4, 650],
    ],
  );
  assert.deepEqual([...hiddenMatchIds()].sort(), [d2, d3, d4], "the late game hidden behind game 1 too");
  assert.ok(
    ids.every((id) => !existsSync(final(id))),
    "every export deleted once joined",
  );
  assert.ok(
    textOf(d1, "chapters").includes("31:00 game 4 · shipwreck seed"),
    "the late game's chapter, after game 3's (600 + 560 + 700 s)",
  );
}

/* --- S6: every game keeps its header when the previous game's last chapter crowds it ----------- */
{
  const opts = (prevChapterAt: number) => ({
    season: 11,
    round: "Round of 16",
    bestOf: 5,
    left: { nickname: P.nickname, label: "LCQ", seasonEloRate: 2137 },
    right: { nickname: A.nickname, label: "#1 seed", seasonEloRate: 2688 },
    games: [
      {
        matchId: 1,
        gameNo: 1,
        startSec: 0,
        seed: "village seed",
        pageUrl: "https://example.test/matches/1",
        streams: [],
        chapters: [{ label: "Result", timeSec: prevChapterAt }],
      },
      {
        matchId: 2,
        gameNo: 2,
        startSec: 600,
        seed: "desert temple seed",
        pageUrl: "https://example.test/matches/2",
        streams: [],
        // A split inside 10 s of its own header: the sub-chapter is the one YouTube's gap drops.
        chapters: [{ label: "Nether Enter", timeSec: 605 }],
      },
    ],
    bracketUrl: "https://example.test/bracket",
  });
  const comfortable = buildSeriesDescription(opts(580));
  assert.ok(comfortable.includes("9:40 Result\n10:00 game 2 · desert temple seed\n"), comfortable);
  assert.ok(!comfortable.includes("Nether Enter"), "a sub-chapter within 10 s of its own header is dropped");
  // The docs: the re-filter exists "since a sub-chapter can land within that gap of its own
  // header or of the next game's" — the sub-chapter gives way, and every game keeps the header
  // that names its world. A Result 5 s before the next game's header must not cost that header.
  // Not a live bug today: a game's tail is never under 15 s (postRoll), so a real export's Result
  // lands at least 15 s before the next header. This gap is hand-built; it is reachable only when
  // a game's tail is under 10 s, or its last chapter is not the Result.
  await deviation(
    'handbook "A series is one video": chapters name each game\'s world; the 10 s re-filter drops the sub-chapter that lands within the gap "of the next game\'s" header (reachable only with a game tail under 10 s or a non-Result last chapter; postRoll keeps real tails at 15 s+)',
    () => {
      const crowded = buildSeriesDescription(opts(595));
      assert.ok(
        crowded.includes("10:00 game 2 · desert temple seed"),
        "game 2's header was dropped, game 1's Result at 9:55 kept (greedy filterChapterGap keeps the earlier chapter)",
      );
    },
  );
}

if (deviations.length) console.log(`series.contract: ${deviations.length} deviation(s) reported`);
console.log("series.contract: all checks passed");
