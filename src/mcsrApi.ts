import type { FeedMatch, MatchInfo, UserDetails, VersusStats } from "./types.js";

const BASE_URL = "https://api.mcsrranked.com";

/** The API allows 500 requests per 10 minutes; callers that page should budget against it. */
export const RATE_LIMIT_PER_10_MIN = 500;

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

export function getMatch(matchId: number): Promise<MatchInfo> {
  return getJson<MatchInfo>(`/matches/${matchId}`);
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
