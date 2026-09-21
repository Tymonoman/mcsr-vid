import type { FeedMatch, MatchInfo, PlayoffBracket, UserDetails, VersusStats } from "./types.js";

const BASE_URL = "https://api.mcsrranked.com";

interface Envelope<T> {
  status: "success" | "error";
  data: T;
}

/** Carries the HTTP status so callers can react to 429 (rate limited) specifically. */
export class McsrApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "McsrApiError";
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    throw new McsrApiError(`MCSR Ranked API ${path} -> ${res.status} ${res.statusText}`, res.status);
  }
  const body = (await res.json()) as Envelope<T>;
  if (body.status !== "success") {
    throw new Error(`MCSR Ranked API ${path} returned error: ${JSON.stringify(body.data)}`);
  }
  return body.data;
}

/**
 * Ten minutes, not forever: a match record keeps changing after the game — players attach
 * `vod[]` later, and the pipeline's VOD guard reads that — but within one dashboard page the
 * same match is asked for by the metadata, the hooks, the splits and the Short panel, against
 * a 500-per-10-minute budget.
 */
const MATCH_TTL_MS = 10 * 60_000;
const matchCache = new Map<number, { at: number; match: MatchInfo }>();

export async function getMatch(matchId: number): Promise<MatchInfo> {
  const hit = matchCache.get(matchId);
  if (hit && Date.now() - hit.at < MATCH_TTL_MS) return hit.match;
  const match = withoutGhostPlayers(await getJson<MatchInfo>(`/matches/${matchId}`));
  matchCache.set(matchId, { at: Date.now(), match });
  return match;
}

/**
 * A private room's player list without anyone who never played: the host joined S11 playoff
 * game 13333220 as a third player and stayed at spawn, so the API lists three players and the
 * timeline names two. Dropped only when more than two are listed and only when the timeline
 * has nothing on them, so a real 2-player match is never touched.
 */
export function withoutGhostPlayers(match: MatchInfo): MatchInfo {
  if (match.type !== 3 || match.players.length <= 2) return match;
  const active = new Set(match.timelines.map((t) => t.uuid));
  if (match.result.uuid) active.add(match.result.uuid);
  const players = match.players.filter((p) => active.has(p.uuid));
  return players.length === match.players.length ? match : { ...match, players };
}

/**
 * Replaces the cached record of a match already fetched, keeping its original expiry — this
 * enriches a fetch rather than being one. `withDiscoveredVods` uses it so the archive listings
 * it spent (~8 s of yt-dlp per player, and a private room needs two) are not spent again by the
 * next caller of `getMatch` for the same id.
 */
export function cacheMatch(match: MatchInfo): void {
  const at = matchCache.get(match.id)?.at ?? Date.now();
  matchCache.set(match.id, { at, match });
}

export interface RecentMatchQuery {
  /** Page size. The API caps this at 100. */
  count?: number;
  /** Pages backwards: returns matches with an id below this one. */
  before?: number;
  /** 1 = casual, 2 = ranked, 3 = private. */
  type?: number;
}

/**
 * The `/matches` feed, newest first. Entries are `FeedMatch` — no `timelines`, so they
 * are cheap to page (100 matches per request) but must be re-fetched with `getMatch`
 * before they can be scored.
 */
export function getRecentMatches(query: RecentMatchQuery = {}): Promise<FeedMatch[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return getJson<FeedMatch[]>(`/matches${search ? `?${search}` : ""}`);
}

/**
 * One player's own match history, newest first, in the shape of the `/matches` feed. `type: 3`
 * and a `season` are how the playoff games are found: they are ordinary private-room matches.
 */
export function getUserMatches(
  uuid: string,
  query: RecentMatchQuery & { season?: number },
): Promise<FeedMatch[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return getJson<FeedMatch[]>(`/users/${encodeURIComponent(uuid)}/matches?${params.toString()}`);
}

/**
 * The playoff bracket: the current one, or a past season's. The envelope wraps the bracket in a
 * second `data` next to `next`/`prev` season pointers, which nothing here needs.
 */
export async function getPlayoffs(season?: number): Promise<PlayoffBracket> {
  const page = await getJson<{ data: PlayoffBracket }>(
    season === undefined ? "/playoffs" : `/playoffs/${season}`,
  );
  return page.data;
}

export function getUser(identifier: string): Promise<UserDetails> {
  return getJson<UserDetails>(`/users/${encodeURIComponent(identifier)}`);
}

export function getVersus(identifier1: string, identifier2: string): Promise<VersusStats> {
  return getJson<VersusStats>(
    `/users/${encodeURIComponent(identifier1)}/versus/${encodeURIComponent(identifier2)}`,
  );
}

/**
 * The match page, on Magma. mcsrranked.com's own `/matches/<id>` pages went 404 in Sept 2026 and
 * Magma's only match route sits under a player (`/ranked/matches/<id>` bounces to the
 * leaderboard); either player will do. The site appends `?season=` itself when it is left out.
 * Keep the `/matches/<id>` segment: it is what pairs a channel upload back to its match
 * (src/channelUploads.ts).
 */
export const matchPageUrl = (matchId: number, nickname: string, season?: number | null): string =>
  `https://magmamcsr.com/ranked/player/${encodeURIComponent(nickname)}/matches/${matchId}${season ? `?season=${season}` : ""}`;

/** The live tournament lives under /events; an archived season moves to /ranked/playoffs/s<N>/bracket. */
export const playoffsBracketUrl = (season: number): string =>
  `https://magmamcsr.com/events/playoffs/s${season}/bracket`;

/** Accepts a full match URL (any site, with or without query/hash) or a bare match ID. */
export function parseMatchId(input: string): number {
  const withoutQueryOrHash = input.split(/[?#]/)[0];
  const trailingNumber = withoutQueryOrHash.match(/(\d+)\/?$/);
  if (!trailingNumber) {
    throw new Error(`Could not find a match ID in "${input}"`);
  }
  return Number(trailingNumber[1]);
}
