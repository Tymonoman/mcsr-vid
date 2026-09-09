import type { FeedMatch, MatchInfo, UserDetails, VersusStats } from "./types.js";

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
  const match = await getJson<MatchInfo>(`/matches/${matchId}`);
  matchCache.set(matchId, { at: Date.now(), match });
  return match;
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

export function getUser(identifier: string): Promise<UserDetails> {
  return getJson<UserDetails>(`/users/${encodeURIComponent(identifier)}`);
}

export function getVersus(identifier1: string, identifier2: string): Promise<VersusStats> {
  return getJson<VersusStats>(
    `/users/${encodeURIComponent(identifier1)}/versus/${encodeURIComponent(identifier2)}`,
  );
}

/** Accepts a full match URL (any site, with or without query/hash) or a bare match ID. */
export function parseMatchId(input: string): number {
  const withoutQueryOrHash = input.split(/[?#]/)[0];
  const trailingNumber = withoutQueryOrHash.match(/(\d+)\/?$/);
  if (!trailingNumber) {
    throw new Error(`Could not find a match ID in "${input}"`);
  }
  return Number(trailingNumber[1]);
}
