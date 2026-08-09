import type { MatchInfo, UserDetails, VersusStats } from "./types.js";

const BASE_URL = "https://api.mcsrranked.com";

interface Envelope<T> {
  status: "success" | "error";
  data: T;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`MCSR Ranked API ${path} -> ${res.status} ${res.statusText}`);
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
