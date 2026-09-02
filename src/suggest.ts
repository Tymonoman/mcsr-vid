import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { chaosScore, closenessScore, computeMetrics, type MatchMetrics } from "./matchScore.js";
import { listProcessedMatchIds } from "./matchStatus.js";
import { getMatch, getRecentMatches, getUser, McsrApiError } from "./mcsrApi.js";
import * as twitch from "./twitch.js";
import type { FeedMatch } from "./types.js";

/** `type` 2 is ranked; casual and private matches aren't worth publishing. */
const RANKED_TYPE = 2;
/** The API caps `count` here. */
const PAGE_SIZE = 100;
/** Parallel `getMatch` calls. Low enough to stay polite inside the shared rate limit. */
const DETAIL_CONCURRENCY = 4;
const CACHE_VERSION = 2;
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
 * Measured, and the reason this exists: a 4,000-match scan (~5 hours of play) yielded
 * 26 dual-VOD candidates and exactly *one* with a comparable finish. Genuinely close
 * races are that rare, so eight of them cannot come out of a single scan — filling the
 * bucket in one pass would cost ~300 feed requests against a 500-per-10-min budget, and
 * some five-hour windows simply don't contain eight. Accumulating instead fills the
 * bucket over successive launches at no extra cost per scan.
 */
const POOL_MAX_ENTRIES = 500;
/** Twitch VODs expire (14 days for non-affiliates); past this a match can't be rendered. */
const POOL_MAX_AGE_DAYS = 10;
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

const NO_TWITCH_NOTE =
  "popularity: streaming frequency only (set TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET in .env for follower data)";

export type Bucket = "close" | "chaos";

export interface Suggestion {
  metrics: MatchMetrics;
  bucket: Bucket;
  /** The bucket's own score, 0-1. Only comparable within a bucket. */
  score: number;
  /** Combined dual-VOD appearances of both players - the streaming-frequency proxy. */
  popularity: number;
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

interface PooledMatch {
  metrics: MatchMetrics;
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
    // derived file and rebuilding it costs one scan.
    if (parsed.version !== CACHE_VERSION) return { ...EMPTY_CACHE };
    return { ...EMPTY_CACHE, ...parsed };
  } catch {
    return { ...EMPTY_CACHE };
  }
}

function saveCache(cache: SuggestCache): void {
  mkdirSync(config.mediaDir, { recursive: true });
  writeFileSync(cachePath(), JSON.stringify(cache, null, 2));
}

/** Match ids that must never be suggested: already worked on, or explicitly dismissed. */
function excludedIds(cache: SuggestCache): Set<number> {
  return new Set<number>([...listProcessedMatchIds(), ...cache.dismissed]);
}

/** Hide a suggestion permanently and drop it from the cached list. */
export function dismissSuggestion(matchId: number): void {
  const cache = loadCache();
  if (!cache.dismissed.includes(matchId)) cache.dismissed.push(matchId);
  cache.suggestions = cache.suggestions.filter((s) => s.metrics.matchId !== matchId);
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
      stats: cache.stats,
    };
  }

  const counted = new Set(cache.countedMatchIds);
  const candidates: FeedMatch[] = [];
  let scanned = 0;
  let requests = 0;
  let highestSeen = cache.newestScannedId ?? 0;
  let scanAborted = false;

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
    for (const match of page) {
      const hasBothVods = (match.vod?.length ?? 0) >= 2;
      // Popularity counts every dual-VOD match, forfeits and already-rendered ones
      // included: it measures who streams, not who is worth watching.
      if (hasBothVods && !counted.has(match.id)) {
        counted.add(match.id);
        for (const player of match.players) {
          cache.playerAppearances[player.nickname] =
            (cache.playerAppearances[player.nickname] ?? 0) + 1;
        }
      }
      if (!match.forfeited && hasBothVods && !excluded.has(match.id)) candidates.push(match);
    }
    options.onProgress?.(scanned, candidates.length);
    return { next: page[page.length - 1]!.id, allSeen };
  };

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
  const popularityOfNames = (a: string, b: string): number =>
    popularityOfName(a) + popularityOfName(b);
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
  const cutoff = Date.now() - POOL_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const live = Object.values(cache.pool)
    .filter((entry) => entry.dateSec * 1000 >= cutoff)
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
    }));

  const { suggestWeights, suggestFastRunTargetSec, suggestSlowRunCutoffSec } = config;
  const rank = (entry: (typeof selectable)[number], bucket: Bucket): number =>
    bucket === "close"
      ? closenessScore(entry.metrics, suggestWeights, suggestFastRunTargetSec, suggestSlowRunCutoffSec)
      : chaosScore(entry.metrics, suggestWeights, suggestFastRunTargetSec, suggestSlowRunCutoffSec);

  const take = (
    pool: typeof selectable,
    bucket: Bucket,
    slots: number,
    exclude: Set<number>,
  ): Suggestion[] =>
    pool
      .filter((entry) => !exclude.has(entry.metrics.matchId))
      .map((entry) => ({ ...entry, bucket, score: rank(entry, bucket) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, slots);

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
  saveCache(cache);

  // A truncated scan still returns results, but say so rather than letting a short list
  // look like "there was nothing to find".
  const scanNote = scanAborted
    ? `scan stopped early after ${requests} requests (rate limit or MCSR API error) — press r to continue`
    : null;
  const notes = [scanNote, note].filter((n): n is string => n !== null);

  return {
    suggestions,
    usedTwitchFollowers: usedTwitch,
    note: notes.length > 0 ? notes.join(" · ") : null,
    stats,
  };
}
