import { existsSync } from "node:fs";

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const HELIX = "https://api.twitch.tv/helix";
/** `GET /helix/users` accepts this many `login` params per request. */
const LOGIN_BATCH = 100;

// Node has read .env natively since 20.12, so this needs no dependency. Loading it here
// rather than in config.ts keeps the credentials scoped to the only module that uses
// them. Guarded because a missing .env is the normal case, not an error.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Malformed .env shouldn't take the whole suggester down; treated as unconfigured.
  }
}

/** True when both credentials are present. When false, callers fall back to frequency-only. */
export function isConfigured(): boolean {
  return Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * App access token via client_credentials. Cached for the process lifetime, refreshed a
 * minute before expiry. This grants no user context — enough for public channel data.
 */
async function getAppToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const body = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID!,
    client_secret: process.env.TWITCH_CLIENT_SECRET!,
    grant_type: "client_credentials",
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body });
  if (!res.ok) throw new Error(`Twitch token request failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}

async function helix<T>(path: string): Promise<T> {
  const token = await getAppToken();
  const res = await fetch(`${HELIX}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Client-Id": process.env.TWITCH_CLIENT_ID! },
  });
  if (!res.ok) throw new Error(`Twitch ${path} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Twitch logins (case-insensitive) to their numeric broadcaster ids. */
export async function getBroadcasterIds(logins: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < logins.length; i += LOGIN_BATCH) {
    const batch = logins.slice(i, i + LOGIN_BATCH);
    const query = batch.map((login) => `login=${encodeURIComponent(login)}`).join("&");
    const json = await helix<{ data: { id: string; login: string }[] }>(`/users?${query}`);
    // Unknown or banned logins are simply absent from the response.
    for (const user of json.data) out.set(user.login.toLowerCase(), user.id);
  }
  return out;
}

/**
 * Total followers for one channel.
 *
 * The reference docs describe this endpoint as needing a user access token with the
 * `moderator:read:followers` scope, but that scope gates the follower *list*: the
 * `total` comes back for any valid token, an app token included. If that ever stops
 * being true this throws, and the caller degrades to frequency-only popularity.
 */
export async function getFollowerCount(broadcasterId: string): Promise<number> {
  const json = await helix<{ total: number }>(
    `/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
  );
  return json.total;
}
