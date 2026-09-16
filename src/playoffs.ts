/**
 * The MCSR Ranked Playoffs, as the pipeline needs them: which bracket slot a match is a game of
 * and which game of the series it is. Round and game number, and never a series score — "Round of
 * 16 · Game 2 of 5" says where in the bracket a viewer is without saying who has been winning it,
 * which is the same spoiler rule the rest of the channel runs on.
 *
 * The bracket (`/playoffs`) knows the series but not the games. The games are ordinary
 * private-room matches (type 3) between the two participants, with a referee spectating and no
 * elo changes, found through each participant's own history. A game is the slot's when both
 * players are its participants and it was played inside the slot's window; games are numbered by
 * date.
 *
 * Seasons: a bracket is season N's playoffs, but its games are played after the rollover and the
 * API stamps them with season N+1. Every lookup here goes through that offset.
 */
import { config } from "./config.js";
import { describeError } from "./errorText.js";
import {
  McsrApiError,
  getMatch,
  getPlayoffs,
  getUserMatches,
  matchPageUrl,
  playoffsBracketUrl,
} from "./mcsrApi.js";
import type { FeedMatch, MatchInfo, PlayoffBracket, PlayoffSlot } from "./types.js";

export interface PlayoffSeed {
  uuid: string;
  nickname: string;
  /** "#1 seed" … "#12 seed", or "LCQ" for the last-chance qualifiers. */
  label: string;
  /** The frozen season-end rating — what the official broadcast shows. */
  seasonEloRate: number;
}

export interface PlayoffContext {
  /** The bracket's season (the tournament's name), not the season the game is stamped with. */
  season: number;
  /** "Round of 16", "Quarterfinals", "Semifinals", "3rd Place", "Grand Finals". */
  round: string;
  gameNo: number;
  bestOf: number;
  /** In the slot's participant order. */
  seeds: [PlayoffSeed, PlayoffSeed];
}

export interface PlayoffGame {
  matchId: number;
  /** The match page (src/mcsrApi.ts), so the board never hardcodes the site's host. */
  url: string;
  dateSec: number;
  gameNo: number;
}

/** A game may start a little before the slot's listed time, and a Bo7 can run past three hours. */
const BEFORE_START_SEC = 15 * 60;
// ponytail: four Round of 16 slots share one listed start; played back to back on one stream the
// fourth Bo5 could run past this and lose its late games. Raise towards 8 h if that ever happens.
const AFTER_START_SEC = 6 * 60 * 60;
/** An unscheduled slot takes any game inside the tournament: this long from the first listed start. */
const TOURNAMENT_SPAN_SEC = 30 * 24 * 60 * 60;
/** A forfeit inside the first minute is a room reset, not a game. */
const PRACTICE_FORFEIT_MS = 60_000;
/** The last twelve seeds come through the last-chance qualifier, unseeded. */
const LCQ_FROM_SEED = 12;

export const seedLabel = (seedNumber: number): string =>
  seedNumber >= LCQ_FROM_SEED ? "LCQ" : `#${seedNumber + 1} seed`;

export const bestOfSlot = (slot: PlayoffSlot): number => slot.maxRoundScore * 2 - 1;

/** "Round of 16 · Game 2 of 5". */
export const playoffLabel = (ctx: PlayoffContext): string =>
  `${ctx.round} · Game ${ctx.gameNo} of ${ctx.bestOf}`;

/** The title's format half, replacing "MCSR Ranked 1v1" (src/title.ts). */
export const playoffTitleTail = (ctx: PlayoffContext): string =>
  `MCSR Ranked S${ctx.season} Playoffs · ${ctx.round} · Game ${ctx.gameNo}`;

/** The intro card's context line; CSS uppercases it. */
export const playoffIntroLabel = (ctx: PlayoffContext): string =>
  `Season ${ctx.season} Playoffs · ${ctx.round} · Game ${ctx.gameNo}`;

/** The description's paragraph: round, game, seeds, the bracket, the broadcast. No series score. */
export function playoffParagraph(ctx: PlayoffContext): string {
  const [a, b] = ctx.seeds;
  return [
    `Season ${ctx.season} Playoffs, ${playoffLabel(ctx)}: ${a.nickname} (${a.label}, ${a.seasonEloRate} elo) vs ${b.nickname} (${b.label}, ${b.seasonEloRate} elo).`,
    `Bracket: ${playoffsBracketUrl(ctx.season)}`,
    "Official broadcast: https://twitch.tv/mcsrranked · https://youtube.com/@MCSR_Ranked",
  ].join("\n");
}

const seedOf = (bracket: PlayoffBracket, index: number): PlayoffSeed | null => {
  const p = bracket.players[index];
  return p
    ? { uuid: p.uuid, nickname: p.nickname, label: seedLabel(p.seedNumber), seasonEloRate: p.seasonEloRate }
    : null;
};

/** Both seats of a slot, or null while the slot is still waiting on an earlier round. */
export function slotSeeds(bracket: PlayoffBracket, slot: PlayoffSlot): [PlayoffSeed, PlayoffSeed] | null {
  const a = slot.participants[0] && seedOf(bracket, slot.participants[0].player);
  const b = slot.participants[1] && seedOf(bracket, slot.participants[1].player);
  return a && b ? [a, b] : null;
}

/** [from, to] in epoch seconds inside which a game of this slot can have been played. */
export function slotWindow(bracket: PlayoffBracket, slot: PlayoffSlot): [number, number] | null {
  if (slot.startTime !== null) return [slot.startTime - BEFORE_START_SEC, slot.startTime + AFTER_START_SEC];
  const starts = bracket.matches.map((m) => m.startTime).filter((t): t is number => t !== null);
  if (starts.length === 0) return null;
  const first = Math.min(...starts);
  return [first - BEFORE_START_SEC, first + TOURNAMENT_SPAN_SEC];
}

/** Whether this match is a game of this slot: the right two players, inside the window, not a reset. */
export function gameBelongs(bracket: PlayoffBracket, slot: PlayoffSlot, match: FeedMatch): boolean {
  const seeds = slotSeeds(bracket, slot);
  if (!seeds || match.type !== 3 || match.players.length !== 2) return false;
  const uuids = new Set(match.players.map((p) => p.uuid));
  if (!uuids.has(seeds[0].uuid) || !uuids.has(seeds[1].uuid)) return false;
  const window = slotWindow(bracket, slot);
  if (!window || match.date < window[0] || match.date > window[1]) return false;
  return !(match.forfeited && match.result.time < PRACTICE_FORFEIT_MS);
}

/** The slot whose game this match is, or null. A pair meets once per bracket, so the first fits. */
export function slotFor(bracket: PlayoffBracket, match: FeedMatch): PlayoffSlot | null {
  return bracket.matches.find((slot) => gameBelongs(bracket, slot, match)) ?? null;
}

/**
 * The slot's games in date order, numbered. `history` is whatever the participants' histories
 * returned — duplicates (both players list the same game) and unrelated matches are dropped here.
 * The number is a pure function of what this call was given, so a caller packaging one match
 * hands its own copy in and gets a number that counts it (see `gamesOf`).
 */
export function slotGames(
  bracket: PlayoffBracket,
  slot: PlayoffSlot,
  history: readonly FeedMatch[],
): PlayoffGame[] {
  const seeds = slotSeeds(bracket, slot);
  if (!seeds) return [];
  const byId = new Map<number, FeedMatch>();
  for (const m of history) if (gameBelongs(bracket, slot, m)) byId.set(m.id, m);
  return [...byId.values()]
    .sort((x, y) => x.date - y.date)
    .map((m, i) => ({
      matchId: m.id,
      url: matchPageUrl(m.id, seeds[0].nickname),
      dateSec: m.date,
      gameNo: i + 1,
    }));
}

/** Everything the packaging needs about one game, or null when the match is not one of the slot's. */
export function contextOf(
  bracket: PlayoffBracket,
  slot: PlayoffSlot,
  games: readonly PlayoffGame[],
  matchId: number,
): PlayoffContext | null {
  const seeds = slotSeeds(bracket, slot);
  const game = games.find((g) => g.matchId === matchId);
  if (!seeds || !game) return null;
  return {
    season: bracket.season,
    round: slot.name,
    gameNo: game.gameNo,
    bestOf: bestOfSlot(slot),
    seeds,
  };
}

/* --- Fetching, cached per process ------------------------------------------------------------ */

/** The season a bracket's games are stamped with (see the module comment). */
export const gameSeasonOf = (bracket: PlayoffBracket): number => bracket.season + 1;

const cacheTtlMs = (): number => config.suggestCacheTtlMin * 60_000;
/** ponytail: 20 pages of 50 reaches back a season for the busiest practiser; a deeper history is not a playoff. */
const MAX_HISTORY_PAGES = 20;

const brackets = new Map<string, { atMs: number; bracket: Promise<PlayoffBracket | null> }>();
const histories = new Map<string, { atMs: number; matches: Promise<FeedMatch[]> }>();
const contexts = new Map<number, PlayoffContext>();

/**
 * A bracket by season, or the current one. Null for a season with no playoffs (404), remembered
 * like a hit so a stretch of old private matches does not ask the API the same question each.
 */
export function loadBracket(season?: number): Promise<PlayoffBracket | null> {
  const key = season === undefined ? "current" : String(season);
  const hit = brackets.get(key);
  if (hit && Date.now() - hit.atMs < cacheTtlMs()) return hit.bracket;
  const bracket = getPlayoffs(season).catch((err: unknown) => {
    if (err instanceof McsrApiError && err.status === 404) return null;
    brackets.delete(key);
    throw err;
  });
  brackets.set(key, { atMs: Date.now(), bracket });
  return bracket;
}

/** One player's private matches of `season` back to `sinceSec`, newest first, paged by `before`. */
export function loadHistory(uuid: string, season: number, sinceSec: number): Promise<FeedMatch[]> {
  const key = `${uuid}:${season}:${sinceSec}`;
  const hit = histories.get(key);
  if (hit && Date.now() - hit.atMs < cacheTtlMs()) return hit.matches;
  const matches = (async () => {
    const all: FeedMatch[] = [];
    let before: number | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const batch = await getUserMatches(uuid, { type: 3, season, count: 50, before });
      all.push(...batch);
      const last = batch[batch.length - 1];
      if (!last || batch.length < 50 || last.date < sinceSec) break;
      before = last.id;
    }
    return all;
  })().catch((err: unknown) => {
    histories.delete(key);
    throw err;
  });
  histories.set(key, { atMs: Date.now(), matches });
  return matches;
}

/**
 * The slot's detected games. `include` is folded into the history and `fresh` drops the cached
 * histories first — both for the packaging path: a game that finished after the last warm is in
 * neither a half-hour-old cache nor, for a minute or two, the API's own history, and a game
 * numbered from a history that does not contain it is numbered one short, silently.
 */
async function gamesOf(
  bracket: PlayoffBracket,
  slot: PlayoffSlot,
  include: readonly FeedMatch[] = [],
  fresh = false,
): Promise<PlayoffGame[]> {
  const seeds = slotSeeds(bracket, slot);
  const window = slotWindow(bracket, slot);
  if (!seeds || !window) return [];
  const season = gameSeasonOf(bracket);
  if (fresh) for (const s of seeds) histories.delete(`${s.uuid}:${season}:${window[0]}`);
  const [a, b] = await Promise.all(seeds.map((s) => loadHistory(s.uuid, season, window[0])));
  return slotGames(bracket, slot, [...a, ...b, ...include]);
}

/**
 * What playoff game this match is, or null for the ordinary case. Cheap for a non-playoff match:
 * one cached bracket read and no history fetch unless both players hold seats in one slot.
 * A hit is remembered for the process — once numbered, a game does not move — so the synchronous
 * `playoffEloFor` below can answer from it.
 *
 * What makes the number right is `include`: the match being packaged is folded into whatever
 * history came back, so it is always among the games it is counted against — a game the API has
 * not indexed yet cannot be numbered short by itself. The `fresh` refetch below that only helps
 * the *other* games, and only on a first resolve: the memo above is consulted first, so a number
 * the board already derived from its half-hour-cached histories is what the packaging gets.
 */
export async function playoffContextFor(match: MatchInfo | FeedMatch): Promise<PlayoffContext | null> {
  const known = contexts.get(match.id);
  if (known) return known;
  if (match.type !== 3 || match.players.length !== 2) return null;
  let bracket: PlayoffBracket | null;
  try {
    bracket = await loadBracket(match.season - 1);
    if (!bracket) return null;
    const slot = slotFor(bracket, match);
    if (!slot) return null;
    const ctx = contextOf(bracket, slot, await gamesOf(bracket, slot, [match], true), match.id);
    if (ctx) contexts.set(match.id, ctx);
    return ctx;
  } catch (err) {
    console.error(`playoffs: ${describeError(err)} (packaging as an ordinary match)`);
    return null;
  }
}

/** The same by id, for callers holding only the id. An unreadable match reads as an ordinary one. */
export const playoffContextForId = (matchId: number): Promise<PlayoffContext | null> =>
  getMatch(matchId)
    .then(playoffContextFor)
    .catch(() => null);

/**
 * The frozen season-end rating of a seed in a playoff game already resolved by
 * `playoffContextFor`, for `eloAtMatchStart`: playoff games carry no `changes[]`, and the live
 * rating is the new season's, not the one the broadcast shows.
 */
export function playoffEloFor(matchId: number, uuid: string): number | null {
  return contexts.get(matchId)?.seeds.find((s) => s.uuid === uuid)?.seasonEloRate ?? null;
}

/* --- The dashboard's board ----------------------------------------------------------------- */

export interface PlayoffBoardSlot {
  id: number;
  round: string;
  bestOf: number;
  startTime: number | null;
  seeds: [PlayoffSeed, PlayoffSeed];
  games: PlayoffGame[];
}

export interface PlayoffBoard {
  season: number | null;
  bracketUrl: string | null;
  slots: PlayoffBoardSlot[];
}

/** How far ahead a scheduled slot makes the bracket worth showing, and how far back its games are looked for. */
const UPCOMING_SEC = 14 * 24 * 60 * 60;

/** Whether any slot is scheduled soon, or recently enough that its games may exist. */
export function bracketActive(bracket: PlayoffBracket, nowSec: number): boolean {
  return bracket.matches.some(
    (m) =>
      m.startTime !== null &&
      m.startTime >= nowSec - TOURNAMENT_SPAN_SEC &&
      m.startTime <= nowSec + UPCOMING_SEC,
  );
}

/**
 * The current bracket's seated slots with their detected games, for the dashboard and the
 * nightly. Empty outside a tournament, when it costs one cached bracket read and nothing else.
 */
export async function playoffBoard(nowSec: number = Date.now() / 1000): Promise<PlayoffBoard> {
  const bracket = await loadBracket();
  if (!bracket || !bracketActive(bracket, nowSec))
    return {
      season: bracket?.season ?? null,
      bracketUrl: bracket ? playoffsBracketUrl(bracket.season) : null,
      slots: [],
    };
  const seated = bracket.matches.filter((slot) => slotSeeds(bracket, slot) !== null);
  const slots = await Promise.all(
    seated.map(async (slot) => ({
      id: slot.id,
      round: slot.name,
      bestOf: bestOfSlot(slot),
      startTime: slot.startTime,
      seeds: slotSeeds(bracket, slot)!,
      games: await gamesOf(bracket, slot),
    })),
  );
  for (const slot of slots) {
    for (const game of slot.games) {
      if (!contexts.has(game.matchId)) {
        contexts.set(game.matchId, {
          season: bracket.season,
          round: slot.round,
          gameNo: game.gameNo,
          bestOf: slot.bestOf,
          seeds: slot.seeds,
        });
      }
    }
  }
  return {
    season: bracket.season,
    bracketUrl: playoffsBracketUrl(bracket.season),
    slots: slots.sort((x, y) => (x.startTime ?? Infinity) - (y.startTime ?? Infinity) || x.id - y.id),
  };
}

/** Test seam: forget everything fetched. */
export function _resetPlayoffsForTest(): void {
  brackets.clear();
  histories.clear();
  contexts.clear();
}
