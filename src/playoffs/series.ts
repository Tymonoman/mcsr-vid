/**
 * A playoff series as one video.
 *
 * Every game of a series is rendered by the ordinary pipeline — its own sync, overlay, intro card
 * ("Season 11 Playoffs · Round of 16 · Game 2") and finished export — and the series is those
 * exports joined in order with one `ffmpeg -f concat -c copy`: every export is the same
 * h264 1080p60 + aac, so the join is a copy, not an encode. The result lives in game 1's
 * directory as `series-<g1>.mp4`, and game 1's directory *is* the series to everything
 * downstream: the title, the description (a chapter and a link line per game), the thumbnail
 * strip, the upload, the publish kit and the channel pairing (game 1's `/matches/<id>` link
 * comes first) all read it as they read a match. The other games' directories are hidden from
 * the list once joined, and stay where a re-export or a sync fix reaches them.
 *
 * `series.json` beside the video records the games and their lengths; `exportStale` reads it so
 * a sync fix on game 3 marks the series stale, and a re-run here re-joins from the newer export.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { buildSeriesDescription, buildTags, type SeriesDescriptionGame } from "../pipeline/description.js";
import { describeError } from "../errorText.js";
import { exportOutputPath } from "../pipeline/exportFast.js";
import { setHidden } from "../dashboard/matchShelf.js";
import { getMatch, getUser, matchPageUrl, playoffsBracketUrl } from "../api/mcsrApi.js";
import { readSplitStills } from "../pipeline/overlayRender.js";
import { exportStale, readSyncOffsets } from "../pipeline/syncFile.js";
import {
  playoffPhrase,
  playoffSeriesTail,
  seriesOf,
  type PlayoffBoardSlot,
  type PlayoffGame,
  type PlayoffSeed,
  type PlayoffSeries,
} from "./playoffs.js";
import { buildShortDescription } from "../shorts/shortHook.js";
import { distinctShortMoments, SHORT_WINDOW_SEC } from "../shorts/shortMoment.js";
import { readManifest } from "../thumbnails/thumbnailVariants.js";
import { buildTitle, formatTitle, withHook } from "../pipeline/title.js";
import { readChatTimes } from "../api/twitchChat.js";
import type { MatchInfo } from "../api/types.js";
import { estimatedRunSec, matchStartIntoVodSec } from "../pipeline/vodAcquisition.js";
import { withDiscoveredVods } from "../pipeline/vodDiscovery.js";

export const SERIES_FILE = "series.json";

export const seriesOutputPath = (outDir: string, firstGameId: number): string =>
  path.join(outDir, `series-${firstGameId}.mp4`);

export interface SeriesGame {
  matchId: number;
  gameNo: number;
  winnerUuid: string | null;
  /** The game's export, in seconds — its chapter is the sum of the ones before it. */
  durationSec: number;
}

/** `series.json`: what was joined, so a reader can find the games without the bracket. */
export interface SeriesRecord {
  season: number;
  slotId: number;
  round: string;
  bestOf: number;
  firstTo: number;
  seeds: [PlayoffSeed, PlayoffSeed];
  games: SeriesGame[];
  assembledAt: string;
  /** Which game the series' Short was cut from, when one was. */
  shortFromMatchId?: number;
}

export async function readSeriesRecord(outDir: string): Promise<SeriesRecord | null> {
  const file = path.join(outDir, SERIES_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as SeriesRecord;
  } catch {
    return null;
  }
}

const probeDuration = (file: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.on("error", reject);
    proc.on("close", () => resolve(parseFloat(out.trim()) || 0));
  });

/** The concat demuxer's list file: one absolute path per line, quoted the way it wants. */
export const concatList = (files: readonly string[]): string =>
  files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n";

async function concatVideos(files: readonly string[], outPath: string): Promise<void> {
  const list = `${outPath}.txt`;
  await writeFile(list, concatList(files), "utf8");
  const part = outPath.replace(/\.mp4$/, ".part.mp4");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        part,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let tail = "";
    proc.stderr.on("data", (d: Buffer) => (tail = (tail + d.toString()).slice(-2000)));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg concat exited ${code}:\n${tail}`)),
    );
  });
  await rename(part, outPath);
}

export type AssembleResult =
  | { kind: "not-a-series"; matchId: number }
  | { kind: "incomplete"; firstGameId: number; missing: number[] }
  | { kind: "stale"; firstGameId: number; stale: number[] }
  | { kind: "joined" | "current"; firstGameId: number; path: string; games: SeriesGame[] };

/** Chapter start of each game: the sum of the exports before it. */
export function chapterStarts(durations: readonly number[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const d of durations) {
    starts.push(at);
    at += d;
  }
  return starts;
}

/**
 * Joins the series this game belongs to, once every game of it has an export. Idempotent: a
 * series file newer than every game's export is left alone and only the text is rewritten.
 * Games 2..n are hidden from the list here, since their videos are inside game 1's.
 */
/** Test seams: the join, the probe and the extraction are ffmpeg/ffprobe by default. */
export interface JoinSeams {
  join?: (files: readonly string[], outPath: string) => Promise<void>;
  probe?: (file: string) => Promise<number>;
  extract?: (seriesPath: string, startSec: number, durationSec: number, outPath: string) => Promise<void>;
}

/**
 * A game's export taken back out of the joined series: a copy from the recorded offset for the
 * recorded length. Exact, because the join placed each game's first frame — a keyframe, the
 * start of its own file — at that offset.
 */
async function extractFromSeries(
  seriesPath: string,
  startSec: number,
  durationSec: number,
  outPath: string,
): Promise<void> {
  const part = outPath.replace(/\.mp4$/, ".part.mp4");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-y",
        "-ss",
        startSec.toFixed(3),
        "-i",
        seriesPath,
        "-t",
        durationSec.toFixed(3),
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        "-movflags",
        "+faststart",
        part,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let tail = "";
    proc.stderr.on("data", (d: Buffer) => (tail = (tail + d.toString()).slice(-2000)));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg extract exited ${code}:\n${tail}`)),
    );
  });
  await rename(part, outPath);
}

/** The game's sync.json mtime in ms, or null. */
const syncAtMs = (matchId: number): number | null => {
  const file = path.join(matchDir(matchId), "sync.json");
  return existsSync(file) ? statSync(file).mtimeMs : null;
};

/**
 * Whether the joined series still holds this game as it should be: the series exists, the
 * record names the game at this position, and the game's sync has not moved since the join.
 * Such a game's export is recoverable from the series (`extractFromSeries`) and need not be
 * re-encoded — which is what lets the join delete the games' exports (a series is fifty
 * minutes of 1080p60 and the disk holds one copy of it, not two).
 */
export function heldBySeries(
  record: SeriesRecord | null,
  seriesPath: string,
  game: { matchId: number; gameNo: number },
): boolean {
  if (!record || !existsSync(seriesPath)) return false;
  const held = record.games[game.gameNo - 1];
  if (!held || held.matchId !== game.matchId) return false;
  const syncAt = syncAtMs(game.matchId);
  return syncAt === null || syncAt <= statSync(seriesPath).mtimeMs;
}

/**
 * Joins the series this game belongs to, once every game of it has an export — on disk, or
 * held by the joined series already (see `heldBySeries`). Idempotent: a series file newer than
 * every game's export is left alone and only the text is rewritten. The games' exports are
 * deleted after a join (the series holds them; `prune: false` keeps them), and games 2..n are
 * hidden from the list, since their videos are inside game 1's.
 */
export async function assembleSeries(
  anyGameId: number,
  opts: {
    log?: (line: string) => void;
    force?: boolean;
    adoptShort?: boolean;
    prune?: boolean;
  } & JoinSeams = {},
): Promise<AssembleResult> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const join = opts.join ?? concatVideos;
  const probe = opts.probe ?? probeDuration;
  const extract = opts.extract ?? extractFromSeries;
  const match = await getMatch(anyGameId);
  const series = await seriesOf(match);
  if (!series || series.games.length === 0) return { kind: "not-a-series", matchId: anyGameId };
  const first = series.games[0]!;
  const outDir = matchDir(first.matchId);
  const outPath = seriesOutputPath(outDir, first.matchId);
  const previous = await readSeriesRecord(outDir);
  const finals = series.games.map((g) => exportOutputPath(matchDir(g.matchId), g.matchId));

  // A game whose export the join deleted comes back out of the series, as long as nothing
  // about it moved; one whose sync moved since is the caller's to re-export.
  const missing: number[] = [];
  const stale: number[] = [];
  let recovered = 0;
  for (const [i, g] of series.games.entries()) {
    const final = finals[i]!;
    if (existsSync(final)) {
      if (exportStale(matchDir(g.matchId), final).stale) stale.push(g.matchId);
      continue;
    }
    if (!heldBySeries(previous, outPath, g)) {
      (syncAtMs(g.matchId) !== null && previous?.games.some((h) => h.matchId === g.matchId)
        ? stale
        : missing
      ).push(g.matchId);
      continue;
    }
    const starts = chapterStarts(previous!.games.map((h) => h.durationSec));
    log(`series ${first.matchId}: game ${g.gameNo} taken back out of the series`);
    await extract(outPath, starts[i]!, previous!.games[i]!.durationSec, final);
    recovered++;
  }
  if (missing.length > 0) return { kind: "incomplete", firstGameId: first.matchId, missing };
  if (stale.length > 0) {
    log(
      `series ${first.matchId}: not joined — sync changed after the export of ${stale.map((id) => `#${id}`).join(", ")}`,
    );
    return { kind: "stale", firstGameId: first.matchId, stale };
  }

  const newestExport = Math.max(...finals.map((f) => statSync(f).mtimeMs));
  // Recovered exports are newer than the series by construction and change nothing about it.
  const current =
    !opts.force &&
    existsSync(outPath) &&
    previous !== null &&
    (recovered === series.games.length || statSync(outPath).mtimeMs > newestExport);
  const durations = current
    ? previous!.games.map((g) => g.durationSec)
    : await Promise.all(finals.map(probe));
  if (!current) {
    log(`series: joining ${finals.length} games into ${outPath}`);
    await join(finals, outPath);
  }

  const record: SeriesRecord = {
    season: series.bracket.season,
    slotId: series.slot.id,
    round: series.slot.name,
    bestOf: series.slot.maxRoundScore * 2 - 1,
    firstTo: series.slot.maxRoundScore,
    seeds: series.seeds,
    games: series.games.map((g, i) => ({
      matchId: g.matchId,
      gameNo: g.gameNo,
      winnerUuid: g.winnerUuid,
      durationSec: durations[i]!,
    })),
    assembledAt: current && previous ? previous.assembledAt : new Date().toISOString(),
    ...(previous?.shortFromMatchId !== undefined ? { shortFromMatchId: previous.shortFromMatchId } : {}),
  };
  await writeFile(path.join(outDir, SERIES_FILE), JSON.stringify(record, null, 2), "utf8");
  await writeSeriesText(first.matchId, series, record);
  for (const g of series.games.slice(1)) setHidden(g.matchId, true);
  if (opts.prune !== false) {
    for (const final of finals) await rm(final, { force: true });
    log(`series ${first.matchId}: the games' exports deleted — the series holds them`);
  }
  // The series' Short from the best game that already has one — the nightly cuts a Short per
  // game, so by the time the last game lands there is one to pick. Cutting a missing one is
  // `renderSeries`' job.
  if (opts.adoptShort && record.shortFromMatchId === undefined) {
    const from = await bestShortGame(series.games.filter((g) => existsSync(shortPath(g.matchId))));
    if (from !== null) await adoptSeriesShort(first.matchId, from);
  }
  return {
    kind: current ? "current" : "joined",
    firstGameId: first.matchId,
    path: outPath,
    games: record.games,
  };
}

const shortPath = (matchId: number): string => path.join(matchDir(matchId), `short-${matchId}.mp4`);

/**
 * Each player's stream deep-linked to the game's start, from the VODs the download recorded, in
 * the order given (game 1's seats), so the lines read the same from game to game whatever way
 * round a room seated them.
 */
async function streamLinks(
  match: MatchInfo,
  order: readonly string[],
): Promise<Array<{ nickname: string; url: string }>> {
  const withVods = await withDiscoveredVods(match).catch(() => match);
  const seated = [...match.players].sort((a, b) => order.indexOf(a.uuid) - order.indexOf(b.uuid));
  return seated.flatMap((p) => {
    const vod = withVods.vod.find((v) => v.uuid === p.uuid);
    if (!vod) return [];
    const at = Math.max(0, Math.round(matchStartIntoVodSec(match, vod)));
    return [{ nickname: p.nickname, url: `${vod.url}?t=${at}s` }];
  });
}

/**
 * Game 1's title, description, chapters and tags, rewritten for the whole series. Generated
 * files only: an `.edited.txt` sibling still wins everywhere (src/pipeline/title.ts `metaPaths`).
 */
async function writeSeriesText(
  firstGameId: number,
  series: PlayoffSeries,
  record: SeriesRecord,
): Promise<void> {
  const outDir = matchDir(firstGameId);
  const first = await getMatch(firstGameId);
  const [left, right] = first.players;
  if (!left || !right) throw new Error(`Match ${firstGameId} does not have two players.`);
  const seedOf = (uuid: string) => series.seeds.find((s) => s.uuid === uuid);
  const leftSeed = seedOf(left.uuid);
  const rightSeed = seedOf(right.uuid);
  if (!leftSeed || !rightSeed) throw new Error(`Match ${firstGameId}: its players are not the slot's seeds.`);

  const starts = chapterStarts(record.games.map((g) => g.durationSec));
  const games: SeriesDescriptionGame[] = [];
  for (const [i, g] of record.games.entries()) {
    const m = await getMatch(g.matchId);
    games.push({
      matchId: g.matchId,
      gameNo: g.gameNo,
      startSec: starts[i]!,
      pageUrl: matchPageUrl(g.matchId, left.nickname, m.season),
      streams: await streamLinks(m, [left.uuid, right.uuid]),
    });
  }
  const description = buildSeriesDescription({
    season: record.season,
    round: record.round,
    bestOf: record.bestOf,
    left: leftSeed,
    right: rightSeed,
    games,
    bracketUrl: playoffsBracketUrl(record.season),
    playlistUrl: config.youtubePlaylistUrl,
    supportUrl: config.supportUrl,
  });
  await writeFile(path.join(outDir, `match-${firstGameId}.description.txt`), description, "utf8");
  await writeFile(
    path.join(outDir, `match-${firstGameId}.chapters.txt`),
    description.split("\n\n")[1] ?? "",
    "utf8",
  );

  const [userLeft, userRight] = await Promise.all([getUser(left.uuid), getUser(right.uuid)]);
  const tags = buildTags(first, userLeft, userRight);
  // The tournament's own terms after the names, before the format ones YouTube weights lower:
  // the season as the broadcast says it, the round, and the generic pair.
  tags.splice(
    2,
    0,
    `mcsr ranked season ${record.season} playoffs`,
    record.round.toLowerCase(),
    "mcsr ranked playoffs",
    "playoffs",
  );
  await writeFile(path.join(outDir, `match-${firstGameId}.tags.txt`), `${tags.join("\n")}\n`, "utf8");

  const title = buildTitle({
    leftNickname: left.nickname,
    rightNickname: right.nickname,
    suffix: playoffSeriesTail(record.season, record.round),
  });
  // The same hook the strip committed to, as the pipeline's own title file carries it.
  const hook = (await readManifest(outDir))?.hookText ?? undefined;
  await writeFile(
    path.join(outDir, `match-${firstGameId}.title.txt`),
    formatTitle(withHook(title, hook)),
    "utf8",
  );
}

/* --- The Short ---------------------------------------------------------------------------- */

/**
 * Which game the series' Short should come from: the one whose best window scores highest
 * (src/shorts/shortMoment.ts, chat included). The operator's judgement can replace it — cut any game's
 * Short by hand and run `adoptSeriesShort` with that game — but the first answer is this one.
 */
export async function bestShortGame(games: readonly PlayoffGame[]): Promise<number | null> {
  let best: { matchId: number; score: number } | null = null;
  for (const g of games) {
    const m = await getMatch(g.matchId);
    const [l, r] = m.players;
    if (!l || !r) continue;
    const top = distinctShortMoments(
      m,
      {
        leftUuid: l.uuid,
        rightUuid: r.uuid,
        runMs: estimatedRunSec(m) * 1000,
        windowSec: SHORT_WINDOW_SEC,
        chatAtSec: readChatTimes(matchDir(g.matchId)),
      },
      1,
    )[0];
    if (top && (best === null || top.score > best.score)) best = { matchId: g.matchId, score: top.score };
  }
  return best?.matchId ?? null;
}

/**
 * Makes a game's rendered Short the series' own: copied into game 1's directory under game 1's
 * name, with a description that links the series video, not the game. `short-<g1>.*` is what the
 * Short panel, the kit and the upload read for the series.
 */
export async function adoptSeriesShort(firstGameId: number, fromMatchId: number): Promise<void> {
  const outDir = matchDir(firstGameId);
  const fromDir = matchDir(fromMatchId);
  const src = (ext: string) => path.join(fromDir, `short-${fromMatchId}${ext}`);
  const dst = (ext: string) => path.join(outDir, `short-${firstGameId}${ext}`);
  if (!existsSync(src(".mp4")))
    throw new Error(`No Short rendered for game ${fromMatchId} (${src(".mp4")}).`);
  await mkdir(outDir, { recursive: true });
  await copyFile(src(".mp4"), dst(".mp4"));
  await copyFile(src(".title.txt"), dst(".title.txt"));
  const cut = existsSync(src(".cut.json")) ? JSON.parse(await readFile(src(".cut.json"), "utf8")) : {};
  await writeFile(dst(".cut.json"), JSON.stringify({ ...cut, fromMatchId }, null, 2), "utf8");

  const record = await readSeriesRecord(outDir);
  const first = await getMatch(firstGameId);
  const [l, r] = first.players;
  await writeFile(
    dst(".description.txt"),
    buildShortDescription(
      firstGameId,
      l?.nickname ?? "",
      r?.nickname ?? "",
      config.youtubePlaylistUrl,
      config.supportUrl,
      record ? playoffPhrase(record.season, record.round) : undefined,
      first.season,
      "series",
    ),
    "utf8",
  );
  if (record) {
    await writeFile(
      path.join(outDir, SERIES_FILE),
      JSON.stringify({ ...record, shortFromMatchId: fromMatchId }, null, 2),
      "utf8",
    );
  }
}

/* --- Rendering a whole series ------------------------------------------------------------- */

/** How each step is run; the server and the CLI hand in their own, the test hands in stubs. */
export interface SeriesRunners {
  /** The pipeline for one game; resolves to the failure text, or null. */
  renderGame: (matchId: number) => Promise<string | null>;
  /** `export:fast` for one game; failure text or null. */
  exportGame: (matchId: number) => Promise<string | null>;
  /** `npm run short -- <id> --pick=0`; failure text or null. */
  cutShort: (matchId: number) => Promise<string | null>;
  log: (line: string) => void;
}

export interface SeriesProgress {
  firstGameId: number;
  /** "game 2 of 4 · render", "joining", "short", "done", "failed: …". */
  stage: string;
  startedAt: string;
  done: boolean;
}

const runs = new Map<number, SeriesProgress>();

/** The series runs this process has started, by game 1's id — for the board. */
export const seriesProgress = (firstGameId: number): SeriesProgress | undefined => runs.get(firstGameId);
export const seriesRunning = (): boolean => [...runs.values()].some((r) => !r.done);

/**
 * Renders every game of the series that is not exported yet, joins them, and cuts the Short
 * from the best game. One game at a time — the lab has four cores and one GPU — and a game's
 * failure stops the run where it is, with the games before it kept.
 */
export async function renderSeries(
  anyGameId: number,
  runners: SeriesRunners,
  seams: JoinSeams = {},
): Promise<AssembleResult> {
  const match = await getMatch(anyGameId);
  const series = await seriesOf(match);
  if (!series || series.games.length === 0) return { kind: "not-a-series", matchId: anyGameId };
  const first = series.games[0]!;
  const progress: SeriesProgress = {
    firstGameId: first.matchId,
    stage: "starting",
    startedAt: new Date().toISOString(),
    done: false,
  };
  runs.set(first.matchId, progress);
  const step = (stage: string) => {
    progress.stage = stage;
    runners.log(`series ${first.matchId}: ${stage}`);
  };
  const fail = (stage: string): AssembleResult => {
    progress.stage = `failed: ${stage}`;
    progress.done = true;
    runners.log(`series ${first.matchId}: failed — ${stage}`);
    return { kind: "incomplete", firstGameId: first.matchId, missing: series.games.map((g) => g.matchId) };
  };
  try {
    const record = await readSeriesRecord(matchDir(first.matchId));
    const seriesPath = seriesOutputPath(matchDir(first.matchId), first.matchId);
    for (const g of series.games) {
      const dir = matchDir(g.matchId);
      const final = exportOutputPath(dir, g.matchId);
      // Exported and current, or held by the joined series as it is: nothing to do.
      if (existsSync(final) ? !exportStale(dir, final).stale : heldBySeries(record, seriesPath, g)) continue;
      const label = `game ${g.gameNo} of ${series.games.length}`;
      // The pipeline, unless its overlay *and* its sync are on disk: with the stills present it
      // reuses them and only re-syncs, and the export must not place the clips on the coarse
      // estimate because the render happened to be there.
      if ((await readSplitStills(dir)) === null || readSyncOffsets(dir) === null) {
        step(`${label} · render`);
        const err = await runners.renderGame(g.matchId);
        if (err) return fail(`${label} render: ${err}`);
      }
      step(`${label} · export`);
      const err = await runners.exportGame(g.matchId);
      if (err) return fail(`${label} export: ${err}`);
    }
    step("joining");
    const joined = await assembleSeries(first.matchId, { log: runners.log, ...seams });
    if (joined.kind !== "joined" && joined.kind !== "current") return fail(`join: ${JSON.stringify(joined)}`);

    if ((await readSeriesRecord(matchDir(first.matchId)))?.shortFromMatchId === undefined) {
      step("short");
      const from = await bestShortGame(series.games);
      if (from !== null) {
        const err = existsSync(shortPath(from)) ? null : await runners.cutShort(from);
        if (err) runners.log(`series ${first.matchId}: Short from game ${from} failed — ${err}`);
        else await adoptSeriesShort(first.matchId, from);
      }
    }
    progress.stage = "done";
    progress.done = true;
    return joined;
  } catch (err) {
    return fail(describeError(err));
  }
}

/* --- For the board -------------------------------------------------------------------------- */

export interface SeriesState {
  firstGameId: number;
  /** Per game, in order: whether its export exists. */
  exported: boolean[];
  /** The joined video exists in game 1's directory. */
  joined: boolean;
  assembledAt: string | null;
  shortFromMatchId: number | null;
  /** This process's run of it, if any — "game 2 of 4 · render", "done", "failed: …". */
  progress: string | null;
}

/** What the board shows on a slot: which games are exported, whether the series is joined, and the run in flight. */
export async function seriesState(slot: PlayoffBoardSlot): Promise<SeriesState | null> {
  const first = slot.games[0];
  if (!first) return null;
  const record = await readSeriesRecord(matchDir(first.matchId));
  return {
    firstGameId: first.matchId,
    exported: slot.games.map(
      (g) =>
        existsSync(exportOutputPath(matchDir(g.matchId), g.matchId)) ||
        heldBySeries(record, seriesOutputPath(matchDir(first.matchId), first.matchId), g),
    ),
    joined: existsSync(seriesOutputPath(matchDir(first.matchId), first.matchId)),
    assembledAt: record?.assembledAt ?? null,
    shortFromMatchId: record?.shortFromMatchId ?? null,
    progress: seriesProgress(first.matchId)?.stage ?? null,
  };
}
