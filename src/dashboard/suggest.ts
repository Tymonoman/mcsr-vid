import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { blockedIn, config } from "../config.js";
import { chaosScore, closenessScore, computeMetrics, type MatchMetrics } from "../pipeline/matchScore.js";
import { listProcessedMatchIds } from "./matchStatus.js";
import { pairKey, recentPairPostsSnapshot, type PairPost } from "./pairPosts.js";
import {
  getMatch,
  getRecentMatches,
  getUser,
  getUserMatches,
  getVersus,
  McsrApiError,
} from "../api/mcsrApi.js";
import { eloAtMatchStart } from "../pipeline/overlayProps.js";
import * as twitch from "../api/twitch.js";
import type { FeedMatch, MatchInfo } from "../api/types.js";

/** `type` 2 is ranked; casual and private matches aren't worth publishing. */
const RANKED_TYPE = 2;
/** The API caps `count` here. */
const PAGE_SIZE = 100;
/** Parallel `getMatch` calls. Low enough to stay polite inside the shared rate limit. */
const DETAIL_CONCURRENCY = 4;
/** Bumped whenever `PooledMatch` grows a field: a stale pool regenerates, it never migrates. */
// 4: metrics.deaths counts real deaths only (hunger resets left out, 26 Sept 2026).
const CACHE_VERSION = 4;
/**
 * Twitch handles are resolved one MCSR request per player and then cached forever, so
 * only a cold cache pays. Capped per scan so a first run can't blow the request budget;
 * whoever is left over resolves on the next scan.
 */
const MAX_LOGIN_RESOLVES_PER_SCAN = 60;
/** Follower counts move slowly, so re-read them once a day. */
const FOLLOWER_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Scored matches persist between launches and the buckets draw from that pool.
 *
 * Comparable finishes are rare — roughly one per 4,000 matches scanned — so eight of them
 * cannot come out of one scan at any sane request budget. Accumulating instead fills the
 * bucket over successive launches at no extra cost per scan.
 */
const POOL_MAX_ENTRIES = 500;
/** Twitch VODs expire (14 days for non-affiliates); past this a match can't be rendered. */
export const POOL_MAX_AGE_DAYS = 10;
/** Requests spent catching up on matches played since the last launch. */
const CATCHUP_MAX_REQUESTS = 5;

/**
 * A rate limit or a flaky upstream is worth one retry — over 40 paged requests the MCSR
 * API returns the occasional 502, and a background scan shouldn't die on one.
 */
const TRANSIENT_RETRIES = 2;
const RETRY_DELAY_MS = 800;

const isTransient = (err: unknown): boolean =>
  // A network-level failure surfaces as a plain TypeError from fetch, not McsrApiError.
  !(err instanceof McsrApiError) || err.status === 429 || err.status >= 500;

/**
 * The favourite players (`config.favouritePlayers`) are a tier and a bonus. A match with at least one
 * of them ranks above every match with none, both when the slots are chosen (`take`, below) and when
 * the cards are ordered (src/dashboard/suggestPresent.ts): no-name players are not what anyone clicks
 * on (the operator), and a bonus alone lost to a no-name pair's popularity from appearances. Inside
 * the tier each favourite playing adds half again to a match's weight, one counting 1.5x and two 2x:
 * to its 0-1 score at the slots, to its popularity in the order. A multiple, not a number of points,
 * because popularity is a sum of appearance counts that keeps growing and the two scales differ. With
 * an empty list there is no tier and no bonus. ponytail: a constant — make it a setting if the
 * operator wants to tune it.
 */
export const FAVOURITE_BONUS = 0.5;

/** How many of a match's players are on `favourites`, compared whole and ignoring case. */
function favouriteCounter(favourites: readonly string[]): (players: readonly string[]) => number {
  const liked = new Set(favourites.map((name) => name.toLowerCase()));
  return (players) => players.filter((p) => liked.has(p.toLowerCase())).length;
}

/** `1 + FAVOURITE_BONUS` per player on `favourites`: what a match is worth inside its tier. */
export function favouriteFactorFor(favourites: readonly string[]): (players: readonly string[]) => number {
  const count = favouriteCounter(favourites);
  return (players) => 1 + FAVOURITE_BONUS * count(players);
}

/** Whether a match has at least one player on `favourites`: its tier, ranked before its audience. */
export function favouriteTierFor(favourites: readonly string[]): (players: readonly string[]) => boolean {
  const count = favouriteCounter(favourites);
  return (players) => count(players) > 0;
}

/**
 * How reliably a player's matches get watched, independent of `favouritePlayers` or Twitch follower
 * counts. Seeded once from `draw.json`'s n>=3 rows (1 Oct 2026, the operator's night goal: "the
 * suggestion system is shit it recommends and schedules matches that no one will watch"); anyone
 * never measured gets `UNMEASURED_DRAW` instead. ponytail: a code constant, like `FAVOURITE_BONUS` —
 * refresh by hand if the roster's draw drifts, there is no job that re-seeds it.
 */
export const DEFAULT_DRAW: Readonly<Record<string, number>> = {
  hackingnoises: 2.08,
  silverrruns: 1.93,
  lowk3y_: 1.38,
  beefsalad: 1.29,
  infume: 1.19,
  feinberg: 1.09,
  edcr: 1.07,
  nahhann: 1.04,
  doogile: 1.03,
  v_strid: 0.8,
  // Aquacorde is gone, not just below the gate: blocked (config.blockedPlayers, 2 Oct 2026).
  blazemind: 0.74,
  anjouu: 0.62,
  dandannyboy: 0.5,
  pinne: 0.46,
  romuxii: 0.43,
  badgamer: 0.34,
  bbiddd: 0.29,
  "7rowl": 0.2,
};

/**
 * The draw of a player `DEFAULT_DRAW` never measured, by Twitch following, first band that fits. Not a
 * neutral 1.0: that let an unmeasured grinder outrank BlazeMind (0.74) + Feinberg (1.09), and every
 * sampled player under ~10k followers drew at or below the channel's median (draw.json, 1 Oct 2026).
 * No follower data counts as 0.
 */
export const UNMEASURED_DRAW: readonly { minFollowers: number; draw: number }[] = [
  { minFollowers: 50_000, draw: 1.0 },
  { minFollowers: 10_000, draw: 0.75 },
  { minFollowers: 0, draw: 0.5 },
];

/** `draw(name)`: `DEFAULT_DRAW`'s entry, lowercased, else `UNMEASURED_DRAW` by `followersOf`. */
export function drawOf(name: string, followersOf: (name: string) => number | null): number {
  const measured = DEFAULT_DRAW[name.toLowerCase()];
  if (measured !== undefined) return measured;
  const followers = followersOf(name) ?? 0;
  return UNMEASURED_DRAW.find((band) => followers >= band.minFollowers)!.draw;
}

/**
 * A match's expected draw: the bigger player's `drawOf` plus half the other's. The audience comes for
 * the bigger name; a second one adds to it without doubling it (1 Oct 2026).
 */
export function expectedDrawFor(
  players: readonly [string, string],
  followersOf: (name: string) => number | null,
): number {
  const a = drawOf(players[0], followersOf);
  const b = drawOf(players[1], followersOf);
  return Math.max(a, b) + 0.5 * Math.min(a, b);
}

/** A pair the channel put out lately (`pairRepeatDays`, `posted`) counts for this much. */
export const REPEAT_FACTOR = 0.5;

/**
 * A match's audience across cards: `expectedDrawFor` × `favouriteFactorFor` × `REPEAT_FACTOR` for a
 * pair in `posted`. Expected views, not ladder activity: popularity (appearances + followers) is how
 * often someone plays — gothy666's 241 appearances to Infume's 91 put a grinder and one favourite
 * above two favourites — so it only breaks the last tie. `take()` and `presentSuggestions` both rank
 * on it.
 */
export function audienceFor(
  favourites: readonly string[],
  followersOf: (name: string) => number | null,
  posted: readonly PairPost[],
): (players: readonly [string, string]) => number {
  const favoured = favouriteFactorFor(favourites);
  const repeats = new Set(posted.map((post) => pairKey(post.players)));
  return (players) =>
    expectedDrawFor(players, followersOf) *
    favoured(players) *
    (repeats.has(pairKey(players)) ? REPEAT_FACTOR : 1);
}

/**
 * Measured draws at or above this get their own matches pulled every scan, favourite or not
 * (`STRONG_DRAWS`): with the default roster that adds hackingnoises, BeefSalad, edcr and nahhann.
 */
export const STRONG_DRAW_MIN = 1.0;
export const STRONG_DRAWS: readonly string[] = Object.keys(DEFAULT_DRAW).filter(
  (name) => DEFAULT_DRAW[name]! >= STRONG_DRAW_MIN,
);

/**
 * Below this measured draw a name is not "known" however many followers it has (romuxii: 1,962
 * followers, 0.43 draw) — named so the gate's one magic number is not bare in `knownPlayerFor`.
 */
export const KNOWN_DRAW_MIN = 0.6;

/**
 * Whether one player is recognisable: on `favourites`, or — when enough of their matches have been
 * measured (a `DEFAULT_DRAW` entry) — a draw at or above `KNOWN_DRAW_MIN`. A measured draw is
 * authoritative and skips `followersOf` entirely: it can promote a name the Twitch lookup has never
 * resolved (hackingnoises, no `twitchFollowers` entry on 1 Oct 2026) exactly as it can veto a high
 * follower count the draw says does not convert (romuxii). Only a name with no measured draw falls
 * back to `followersOf`.
 */
export function knownPlayerFor(
  favourites: readonly string[],
  followersOf: (name: string) => number | null,
  threshold: number,
): (name: string) => boolean {
  const liked = new Set(favourites.map((n) => n.toLowerCase()));
  return (name) => {
    const lower = name.toLowerCase();
    if (liked.has(lower)) return true;
    const draw = DEFAULT_DRAW[lower];
    return draw !== undefined ? draw >= KNOWN_DRAW_MIN : (followersOf(name) ?? 0) >= threshold;
  };
}

/**
 * Whether a match has at least one player people know (`knownPlayerFor`): the known-tier, mirroring
 * `favouriteTierFor`'s shape (`favourite` is a subset of `known` — every favourite clears it through
 * the first branch). The middle of `tierFor` for the list, and `nightly.ts`'s gate on the unattended
 * pick.
 */
export function knownTierFor(
  favourites: readonly string[],
  followersOf: (name: string) => number | null,
  threshold: number,
): (players: readonly string[]) => boolean {
  const known = knownPlayerFor(favourites, followersOf, threshold);
  return (players) => players.some(known);
}

/**
 * A match's tier, the first key of `take()` and of `presentSuggestions`: 2 with a favourite, 1 with a
 * known player and no favourite (`knownTierFor`), 0 with neither. A favourite outranks every match
 * without one — the operator's call of 30 Sept 2026 — and a known player lifts a match above the
 * no-names, an expiring one included (1 Oct 2026).
 */
export function tierFor(
  favourites: readonly string[],
  followersOf: (name: string) => number | null,
  threshold: number,
): (players: readonly string[]) => number {
  const isFavourite = favouriteTierFor(favourites);
  const isKnown = knownTierFor(favourites, followersOf, threshold);
  return (players) => (isFavourite(players) ? 2 : isKnown(players) ? 1 : 0);
}

const NO_TWITCH_NOTE =
  "popularity: streaming frequency only (set TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET in .env for follower data)";

export type Bucket = "close" | "chaos";

/** Who a player is, for the card: the operator picks on names and stakes, not on a score. */
export interface SuggestionPlayer {
  nickname: string;
  /** Leaderboard position when the match was scored; null when unranked. */
  eloRank: number | null;
  /** Rating carried *into* this match, per `eloAtMatchStart`; null when unknown. */
  elo: number | null;
  /** Twitch followers, or null when unknown or no linked account. */
  followers: number | null;
}

/** Ranked wins between these two, in `metrics.players` order. */
export interface HeadToHead {
  leftWins: number;
  rightWins: number;
}

export interface Suggestion {
  metrics: MatchMetrics;
  bucket: Bucket;
  /** The bucket's own score, 0-1. Only comparable within a bucket. */
  score: number;
  /** Combined dual-VOD appearances of both players - the streaming-frequency proxy. */
  popularity: number;
  /** Same order as `metrics.players`. */
  profiles: [SuggestionPlayer, SuggestionPlayer];
  h2h: HeadToHead | null;
  vodUrls: string[];
  /** Match start, unix epoch seconds. */
  dateSec: number;
}

interface SuggestCache {
  version: number;
  /** Epoch ms of the last completed scan. */
  scannedAt: number;
  /** Nickname -> number of dual-VOD matches seen, accumulated across scans. */
  playerAppearances: Record<string, number>;
  /** Match ids already folded into `playerAppearances`, so rescans never double-count. */
  countedMatchIds: number[];
  /** Explicitly hidden by the operator; never suggested again. */
  dismissed: number[];
  suggestions: Suggestion[];
  /** Nickname -> Twitch login, or null for "checked, has no linked Twitch". Permanent. */
  twitchLogins: Record<string, string | null>;
  /** Twitch login -> follower count, refreshed after FOLLOWER_TTL_MS. */
  twitchFollowers: Record<string, { count: number; fetchedAt: number }>;
  /** Whether the cached suggestions were ranked with follower data folded in. */
  usedTwitchFollowers: boolean;
  stats: SuggestResult["stats"];
  /**
   * Every match scored so far, keyed by match id, carried across launches. Close races
   * are too rare to gather eight of in one scan, so the buckets select from here.
   */
  pool: Record<string, PooledMatch>;
  /** How far back the feed has been paged. The next scan resumes from here. */
  oldestScannedId: number | null;
  /** Highest match id seen. The catch-up pass stops once it drops below this. */
  newestScannedId: number | null;
}

/** Followers move daily and are cached separately, so they are filled in per scan, not pooled. */
type PooledPlayer = Omit<SuggestionPlayer, "followers">;

interface PooledMatch {
  metrics: MatchMetrics;
  profiles: [PooledPlayer, PooledPlayer];
  h2h: HeadToHead | null;
  vodUrls: string[];
  /** Match start, unix epoch seconds — used to expire entries whose VODs have died. */
  dateSec: number;
  scoredAt: number;
}

const EMPTY_CACHE: SuggestCache = {
  version: CACHE_VERSION,
  scannedAt: 0,
  playerAppearances: {},
  countedMatchIds: [],
  dismissed: [],
  suggestions: [],
  twitchLogins: {},
  twitchFollowers: {},
  usedTwitchFollowers: false,
  stats: { matchesScanned: 0, candidates: 0, detailFetched: 0, closeEligible: 0, poolSize: 0 },
  pool: {},
  oldestScannedId: null,
  newestScannedId: null,
};

export interface SuggestResult {
  suggestions: Suggestion[];
  /** False when credentials are absent or Twitch failed; popularity is appearances-only. */
  usedTwitchFollowers: boolean;
  /** Set when something degraded, for the UI to show. */
  note: string | null;
  /** When the feed was last walked — the cache's time, not the time this call answered. */
  scannedAt: number;
  /** How the scan went. Close slots underfill when few matches have a comparable finish. */
  stats: {
    matchesScanned: number;
    candidates: number;
    detailFetched: number;
    closeEligible: number;
    /** Scored matches available to choose from, accumulated across launches. */
    poolSize: number;
  };
}

const cachePath = (): string => path.join(config.mediaDir, ".suggest-cache.json");

function loadCache(): SuggestCache {
  const file = cachePath();
  if (!existsSync(file)) return { ...EMPTY_CACHE };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SuggestCache;
    // A cache written by an older layout is discarded rather than migrated; it is a
    // derived file and rebuilding it costs one scan. The operator's dismissals are not derived, and
    // a dismissed match coming back is one the nightly could render: they come along.
    if (parsed.version !== CACHE_VERSION) {
      return { ...EMPTY_CACHE, dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [] };
    }
    return { ...EMPTY_CACHE, ...parsed };
  } catch {
    return { ...EMPTY_CACHE };
  }
}

function saveCache(cache: SuggestCache): void {
  mkdirSync(config.mediaDir, { recursive: true });
  writeFileSync(cachePath(), JSON.stringify(cache, null, 2));
}

/**
 * A scan holds its own copy of the cache for minutes; a Dismiss (or its undo) meanwhile writes
 * the file. The disk's list is the newer one, so it replaces the copy's before the scan saves,
 * and the list being saved loses anything dismissed since it was ranked.
 */
export function reconcileDismissed(cache: SuggestCache): void {
  cache.dismissed = loadCache().dismissed;
  const gone = new Set(cache.dismissed);
  cache.suggestions = cache.suggestions.filter((s) => !gone.has(s.metrics.matchId));
}

/** Match ids that must never be suggested: already worked on, or explicitly dismissed. */
function excludedIds(cache: SuggestCache): Set<number> {
  return new Set<number>([...listProcessedMatchIds(), ...cache.dismissed]);
}

/**
 * What the scans already know about players, for code that must not spend an MCSR profile call
 * (the Telegram report's "worth rendering"): a nickname's Twitch login and follower count as the
 * last scan cached them, null when never seen or no linked Twitch, and the ids the operator
 * dismissed. One read of the cache file, nicknames matched without regard to case.
 */
export function scanKnowledge(): {
  dismissed: ReadonlySet<number>;
  twitchOf: (nickname: string) => { login: string; followers: number | null } | null;
} {
  const cache = loadCache();
  const logins = new Map(
    Object.entries(cache.twitchLogins).map(([nick, login]) => [nick.toLowerCase(), login]),
  );
  return {
    dismissed: new Set(cache.dismissed),
    twitchOf: (nickname) => {
      const login = logins.get(nickname.toLowerCase());
      return login ? { login, followers: cache.twitchFollowers[login]?.count ?? null } : null;
    },
  };
}

/**
 * A pooled match's players by id, with no API call: the scan's own cache, for a queued match
 * `take()`'s slots have since dropped (nightly.ts) — the operator's pick must not go silently empty
 * because a later scan trimmed it off the ranked list.
 */
export function pooledMatchPlayers(matchId: number): [string, string] | null {
  return loadCache().pool[String(matchId)]?.metrics.players ?? null;
}

/** Hide a suggestion permanently and drop it from the cached list. */
export function dismissSuggestion(matchId: number): void {
  const cache = loadCache();
  if (!cache.dismissed.includes(matchId)) cache.dismissed.push(matchId);
  cache.suggestions = cache.suggestions.filter((s) => s.metrics.matchId !== matchId);
  saveCache(cache);
}

/**
 * The undo, because Dismiss sits next to Render on a phone. `row` is the scored entry the caller kept when it dropped it, put back so a restart
 * before the next scan still shows the match; without one it returns at that scan.
 */
export function restoreSuggestion(matchId: number, row?: Suggestion): void {
  const cache = loadCache();
  cache.dismissed = cache.dismissed.filter((id) => id !== matchId);
  if (row && !cache.suggestions.some((s) => s.metrics.matchId === matchId)) cache.suggestions.push(row);
  saveCache(cache);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results.push(await fn(items[index]!));
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Follower count per nickname, for the popularity blend. Three hops, each cached:
 * nickname -> Twitch login (MCSR `connections.twitch`, permanent), login -> broadcaster
 * id (Twitch, per scan), id -> follower total (Twitch, daily).
 *
 * Every failure path degrades to "no follower data" rather than throwing: popularity
 * falls back to appearances alone and the caller reports it. Twitch being down must
 * never stop the suggester working.
 */
async function resolveFollowers(
  nicknames: readonly string[],
  cache: SuggestCache,
): Promise<{ followers: Map<string, number>; usedTwitch: boolean; note: string | null }> {
  const followers = new Map<string, number>();
  if (!twitch.isConfigured()) {
    return { followers, usedTwitch: false, note: NO_TWITCH_NOTE };
  }

  // Hop 1: nickname -> Twitch login, via MCSR. One request per never-seen player.
  let budget = MAX_LOGIN_RESOLVES_PER_SCAN;
  for (const nickname of nicknames) {
    if (nickname in cache.twitchLogins) continue;
    if (budget-- <= 0) break;
    try {
      const user = await getUser(nickname);
      cache.twitchLogins[nickname] = user.connections?.twitch?.id?.toLowerCase() ?? null;
    } catch {
      // Leave unset so the next scan retries rather than caching a transient failure.
    }
  }

  const wanted = new Map<string, string>(); // login -> nickname
  for (const nickname of nicknames) {
    const login = cache.twitchLogins[nickname];
    if (login) wanted.set(login, nickname);
  }
  if (wanted.size === 0) {
    return { followers, usedTwitch: false, note: "no linked Twitch accounts found for these players" };
  }

  // Serve what's still fresh from cache before asking Twitch for the rest.
  const stale: string[] = [];
  for (const [login, nickname] of wanted) {
    const hit = cache.twitchFollowers[login];
    if (hit && Date.now() - hit.fetchedAt < FOLLOWER_TTL_MS) followers.set(nickname, hit.count);
    else stale.push(login);
  }
  if (stale.length === 0) return { followers, usedTwitch: true, note: null };

  try {
    // Hops 2 and 3. Ids batch 100 at a time; counts are one request each.
    const ids = await twitch.getBroadcasterIds(stale);
    for (const [login, id] of ids) {
      const count = await twitch.getFollowerCount(id);
      cache.twitchFollowers[login] = { count, fetchedAt: Date.now() };
      const nickname = wanted.get(login);
      if (nickname) followers.set(nickname, count);
    }
  } catch (err) {
    // Keep whatever the cache already had; report the degradation rather than hiding it.
    return {
      followers,
      usedTwitch: followers.size > 0,
      note: `Twitch lookup failed (${(err as Error).message}); popularity is mostly streaming frequency`,
    };
  }

  return { followers, usedTwitch: true, note: null };
}

function profilesOf(match: MatchInfo): [PooledPlayer, PooledPlayer] {
  return match.players.slice(0, 2).map((player) => ({
    nickname: player.nickname,
    eloRank: player.eloRank,
    // `|| null` because eloAtMatchStart bottoms out at 0 when nothing is known, and a card
    // should say nothing rather than "0 elo".
    elo: eloAtMatchStart(match, player.uuid, player.eloRate) || null,
  })) as [PooledPlayer, PooledPlayer];
}

/**
 * Ranked head-to-head, in `metrics.players` order. One request, spent once per match ever: it
 * is pooled next to the metrics, because the record barely moves and refreshing it per scan
 * would cost a request for every pooled match on every launch.
 */
async function headToHead(match: MatchInfo): Promise<HeadToHead | null> {
  const [left, right] = match.players;
  if (!left || !right) return null;
  try {
    const versus = await getVersus(left.uuid, right.uuid);
    return {
      leftWins: versus.results.ranked[left.uuid] ?? 0,
      rightWins: versus.results.ranked[right.uuid] ?? 0,
    };
  } catch {
    // A card without a rivalry line is still a card; the overlay fetches this again at render.
    return null;
  }
}

export interface SuggestOptions {
  /** Ignore a still-fresh cache and rescan. */
  force?: boolean;
  signal?: AbortSignal;
  /** Called after each feed page so a UI can show progress. */
  onProgress?: (scanned: number, candidates: number) => void;
}

/**
 * Ten suggested matches: `suggestCloseSlots` ranked on how close the race was, then
 * `suggestChaosSlots` ranked on how entertainingly it fell apart.
 *
 * Only ~2% of ranked matches have the two Twitch VODs the pipeline needs, so the feed is
 * paged (100 per request, `vod`/`forfeited` both present there) to build a candidate list
 * cheaply, and only the survivors are re-fetched for their timelines.
 */
export async function getSuggestions(options: SuggestOptions = {}): Promise<SuggestResult> {
  const cache = loadCache();
  const excluded = excludedIds(cache);

  const ttlMs = config.suggestCacheTtlMin * 60_000;
  const fresh = Date.now() - cache.scannedAt < ttlMs;
  if (!options.force && fresh && cache.suggestions.length > 0) {
    // Still filter: a match may have been rendered since the scan that produced this.
    return {
      suggestions: cache.suggestions.filter((s) => !excluded.has(s.metrics.matchId)),
      usedTwitchFollowers: cache.usedTwitchFollowers,
      // Re-derived rather than cached: the reason popularity is frequency-only still
      // applies to a cached list, and the operator should keep seeing it.
      note: cache.usedTwitchFollowers ? null : NO_TWITCH_NOTE,
      scannedAt: cache.scannedAt,
      stats: cache.stats,
    };
  }

  const counted = new Set(cache.countedMatchIds);
  const candidates: FeedMatch[] = [];
  let scanned = 0;
  let requests = 0;
  let highestSeen = cache.newestScannedId ?? 0;
  let scanAborted = false;

  // Matches already folded into `candidates` this scan, across both sources below: the feed's own
  // paging and a favourite's own list can easily name the same match, and a duplicate would cost a
  // second detail fetch for nothing.
  const candidateIds = new Set<number>();
  /** One match, from either source: the popularity count and the candidate list both go through here. */
  const foldMatch = (match: FeedMatch): void => {
    // A blocked player's match does not exist for this purpose: not counted, not a candidate,
    // never scored (config.blockedPlayers). Checked here rather than only at the pool so it also
    // never spends a detail fetch, whether the match came from the feed or a favourite's own list.
    if (blockedIn(match.players.map((p) => p.nickname))) return;
    const hasBothVods = (match.vod?.length ?? 0) >= 2;
    // Popularity counts every dual-VOD match, forfeits and already-rendered ones
    // included: it measures who streams, not who is worth watching.
    if (hasBothVods && !counted.has(match.id)) {
      counted.add(match.id);
      for (const player of match.players) {
        cache.playerAppearances[player.nickname] = (cache.playerAppearances[player.nickname] ?? 0) + 1;
      }
    }
    if (!match.forfeited && hasBothVods && !excluded.has(match.id) && !candidateIds.has(match.id)) {
      candidateIds.add(match.id);
      candidates.push(match);
    }
  };

  /**
   * One page of the feed, retrying transient failures. Returns null once the scan should
   * stop — a non-transient error still throws, so a genuine bug isn't swallowed.
   */
  const fetchPage = async (before: number | undefined): Promise<FeedMatch[] | null> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await getRecentMatches({ count: PAGE_SIZE, type: RANKED_TYPE, before });
      } catch (err) {
        if (!isTransient(err)) throw err;
        if (attempt >= TRANSIENT_RETRIES) return null;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  };

  /**
   * Reads one page and folds it in. Returns the id to continue from, or null to stop.
   * `seenBefore` reports whether the whole page was already known — the signal that a
   * catch-up pass has reached territory an earlier launch already covered.
   */
  const consumePage = async (
    before: number | undefined,
  ): Promise<{ next: number | null; allSeen: boolean }> => {
    const page = await fetchPage(before);
    // A partial list beats none: a rate limit or a flaky upstream ends the scan rather
    // than failing it. Whatever was already pooled is still worth showing.
    if (page === null) {
      scanAborted = true;
      return { next: null, allSeen: false };
    }
    requests += 1;
    if (page.length === 0) return { next: null, allSeen: false };
    scanned += page.length;

    // The feed is newest-first, so a page whose newest entry is below the previous
    // high-water mark is entirely old news.
    const highWater = cache.newestScannedId;
    const allSeen = highWater !== null && page[0]!.id <= highWater;
    highestSeen = Math.max(highestSeen, page[0]!.id);
    for (const match of page) foldMatch(match);
    options.onProgress?.(scanned, candidates.length);
    return { next: page[page.length - 1]!.id, allSeen };
  };

  // A favourite or a strong draw (`STRONG_DRAWS`) too quiet to surface in the feed's own paging (it
  // only reaches so far back) still gets a look: one list per name — 10 with the default roster —
  // folded into the same candidates the feed fills. Only a match no scan has seen yet and young
  // enough for the pool: a list is re-read every scan, and an already-counted match coming back
  // would take a detail fetch from a new one (or be fetched again every time the pool drops it). One
  // name failing (a stale nickname in the config) costs that name's coverage, not the scan.
  const coveredSec = Date.now() / 1000 - POOL_MAX_AGE_DAYS * 86_400;
  const covered = new Map([...config.favouritePlayers, ...STRONG_DRAWS].map((n) => [n.toLowerCase(), n]));
  for (const nickname of covered.values()) {
    try {
      const list = await getUserMatches(nickname, { type: RANKED_TYPE, count: PAGE_SIZE });
      requests += 1;
      for (const match of list) if (!counted.has(match.id) && match.date >= coveredSec) foldMatch(match);
    } catch (err) {
      console.error(`suggest: ${nickname}'s own matches could not be read — ${(err as Error).message}`);
    }
  }

  // Pass 1 — catch up on matches played since the last launch. Stops as soon as a whole
  // page is already known, so this is usually one or two requests.
  let cursor: number | undefined;
  for (let i = 0; i < CATCHUP_MAX_REQUESTS && requests < config.suggestMaxScanRequests; i++) {
    if (options.signal?.aborted) break;
    const { next, allSeen } = await consumePage(cursor);
    if (next === null) break;
    cursor = next;
    if (allSeen) break;
  }
  const newestSeen = cursor;

  // Pass 2 — push the frontier further back in time. Without this every launch would
  // re-scan the same recent window and the pool would never actually grow, which matters
  // because close races are rare enough to need days of history, not hours.
  cursor = cache.oldestScannedId ?? newestSeen;
  while (requests < config.suggestMaxScanRequests && candidates.length < config.suggestDetailFetchLimit) {
    if (options.signal?.aborted) break;
    const { next } = await consumePage(cursor);
    if (next === null) break;
    cursor = next;
    cache.oldestScannedId = next;
  }
  cache.newestScannedId = highestSeen;

  // Everyone who could appear in the final list, not just this scan's finds: the buckets
  // rank the whole pool, so resolving only fresh candidates would leave most pooled
  // matches scored on appearances alone.
  const nicknames = [
    ...new Set([
      ...candidates.flatMap((m) => m.players.map((p) => p.nickname)),
      ...Object.values(cache.pool).flatMap((entry) => entry.metrics.players),
    ]),
  ];
  const { followers, usedTwitch, note } = await resolveFollowers(nicknames, cache);

  // Popularity blends how often a player streams ranked matches with the size of their
  // Twitch following. Followers go through log10 because the counts are heavy-tailed —
  // added raw, one big streamer would dominate every other signal.
  const popularityOfName = (nickname: string): number =>
    (cache.playerAppearances[nickname] ?? 0) +
    config.suggestFollowerWeight * Math.log10(1 + (followers.get(nickname) ?? 0));
  const popularityOfNames = (a: string, b: string): number => popularityOfName(a) + popularityOfName(b);
  const popularityOf = (match: FeedMatch): number =>
    match.players.reduce((sum, p) => sum + popularityOfName(p.nickname), 0);

  // Pre-rank on feed-only signals so the detail fetches are spent on the most promising
  // candidates: most popular first, faster runs breaking ties.
  const shortlist = [...candidates]
    .sort((a, b) => popularityOf(b) - popularityOf(a) || a.result.time - b.result.time)
    .slice(0, config.suggestDetailFetchLimit);

  // Only matches not already scored on a previous launch need a detail fetch.
  const unscored = shortlist.filter((m) => !(String(m.id) in cache.pool));
  const newlyScored = (
    await mapWithConcurrency(unscored, DETAIL_CONCURRENCY, async (feedMatch) => {
      try {
        const full = await getMatch(feedMatch.id);
        return {
          metrics: computeMetrics(full),
          profiles: profilesOf(full),
          h2h: await headToHead(full),
          vodUrls: (feedMatch.vod ?? []).map((v) => v.url),
          dateSec: feedMatch.date,
          scoredAt: Date.now(),
        };
      } catch {
        // One unreadable match shouldn't sink the whole list.
        return null;
      }
    })
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  for (const entry of newlyScored) cache.pool[String(entry.metrics.matchId)] = entry;

  // Matches whose Twitch VODs have aged out can't be rendered any more, so they leave
  // the pool. Then cap it, oldest first, so it can't grow without bound.
  //
  // A blocked player's match also leaves here, not just at foldMatch: a match pooled before the
  // player was blocked must not go on being carried forward (or selected) just because it was
  // already scored.
  const cutoff = Date.now() - POOL_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const live = Object.values(cache.pool)
    .filter((entry) => entry.dateSec * 1000 >= cutoff && !blockedIn(entry.metrics.players))
    .sort((a, b) => b.dateSec - a.dateSec)
    .slice(0, POOL_MAX_ENTRIES);
  cache.pool = Object.fromEntries(live.map((entry) => [String(entry.metrics.matchId), entry]));

  // Popularity is recomputed rather than stored: appearance counts keep accumulating, so
  // a figure saved when the match was first scored would be stale.
  const selectable = live
    .filter((entry) => !excluded.has(entry.metrics.matchId))
    .map((entry) => ({
      ...entry,
      popularity: popularityOfNames(entry.metrics.players[0], entry.metrics.players[1]),
      profiles: entry.profiles.map((p) => ({
        ...p,
        followers: followers.get(p.nickname) ?? null,
      })) as [SuggestionPlayer, SuggestionPlayer],
    }));

  const { suggestWeights, suggestFastRunTargetSec, suggestSlowRunCutoffSec } = config;
  const rank = (entry: (typeof selectable)[number], bucket: Bucket): number =>
    bucket === "close"
      ? closenessScore(entry.metrics, suggestWeights, suggestFastRunTargetSec, suggestSlowRunCutoffSec)
      : chaosScore(entry.metrics, suggestWeights, suggestFastRunTargetSec, suggestSlowRunCutoffSec);

  // The slots go by `tierFor` — the matches with a favourite, then those with a known player, then
  // the rest — inside a tier by `audienceFor` (the pairs put out lately as the scan finds them), then
  // the bucket's score, then popularity; the `score` kept on the card stays the bucket's own. One card
  // per pair across both buckets (`pairs`): the best of a pair's matches, never two of them.
  const followersOf = (name: string) => followers.get(name) ?? null;
  const tier = tierFor(config.favouritePlayers, followersOf, config.knownFollowerThreshold);
  const audience = audienceFor(config.favouritePlayers, followersOf, recentPairPostsSnapshot());
  const pairs = new Set<string>();
  const take = (
    pool: typeof selectable,
    bucket: Bucket,
    slots: number,
    exclude: Set<number>,
  ): Suggestion[] => {
    const ranked = pool
      .filter((entry) => !exclude.has(entry.metrics.matchId))
      .map((entry) => ({ ...entry, bucket, score: rank(entry, bucket) }))
      .sort(
        (a, b) =>
          tier(b.metrics.players) - tier(a.metrics.players) ||
          audience(b.metrics.players) - audience(a.metrics.players) ||
          b.score - a.score ||
          b.popularity - a.popularity,
      );
    const out: Suggestion[] = [];
    for (const entry of ranked) {
      if (out.length >= slots) break;
      const key = pairKey(entry.metrics.players);
      if (pairs.has(key)) continue;
      pairs.add(key);
      out.push(entry);
    }
    return out;
  };

  // A match where the loser never killed the dragon has no finish to be close *at*, so it
  // can't hold a close-race slot however tense the middle was. It stays eligible for the
  // chaos bucket, which is where that kind of match belongs anyway.
  const closeEligible = selectable.filter((entry) => entry.metrics.finishMarginMs !== null);
  const stats = {
    matchesScanned: scanned,
    candidates: candidates.length,
    detailFetched: newlyScored.length,
    closeEligible: closeEligible.length,
    poolSize: selectable.length,
  };
  const close = take(closeEligible, "close", config.suggestCloseSlots, new Set());

  const claimed = new Set(close.map((s) => s.metrics.matchId));
  // Close slots that couldn't be filled roll over, so the list still comes back full.
  const chaosSlots = config.suggestChaosSlots + (config.suggestCloseSlots - close.length);
  const chaos = take(selectable, "chaos", chaosSlots, claimed);
  const suggestions = [...close, ...chaos];

  cache.version = CACHE_VERSION;
  cache.scannedAt = Date.now();
  cache.countedMatchIds = [...counted];
  cache.suggestions = suggestions;
  cache.usedTwitchFollowers = usedTwitch;
  cache.stats = stats;
  reconcileDismissed(cache);
  saveCache(cache);

  // A truncated scan still returns results, but say so rather than letting a short list
  // look like "there was nothing to find".
  const scanNote = scanAborted
    ? `scan stopped early after ${requests} requests (rate limit or MCSR API error) — press r to continue`
    : null;
  const notes = [scanNote, note].filter((n): n is string => n !== null);

  return {
    suggestions: cache.suggestions,
    scannedAt: cache.scannedAt,
    usedTwitchFollowers: usedTwitch,
    note: notes.length > 0 ? notes.join(" · ") : null,
    stats,
  };
}
