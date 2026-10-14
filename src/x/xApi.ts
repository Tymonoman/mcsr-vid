/**
 * X (Twitter) through its official API, as the channel's own account: OAuth 1.0a user context
 * (the four keys the developer app's "Keys and tokens" page shows), the v2 chunked video upload
 * and `POST /2/tweets`. Endpoints as docs.x.com described them on 14 Oct 2026
 * (handbook/claude-md-reference.md, "X posts"). No dependency: the signature is HMAC-SHA1 from
 * node:crypto. Nothing here ever logs a key, a token or a signature.
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

// The same native .env read as src/api/twitch.ts: /app/.env holds the keys, nothing else does.
if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Malformed .env: treated as unconfigured, like Twitch.
  }
}

export const X_API = "https://api.x.com";
/** The docs: "Keep each segment at or below 5 MB". */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** A Short is ≤60s; X's own example polls every second. Two minutes of polls is plenty. */
const MAX_STATUS_POLLS = 120;

export interface XKeys {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

export const X_KEY_NAMES = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"] as const;

/** The four keys from the environment, or null while any is missing. */
export function xKeys(): XKeys | null {
  const [apiKey, apiSecret, accessToken, accessSecret] = X_KEY_NAMES.map((k) => process.env[k]?.trim());
  return apiKey && apiSecret && accessToken && accessSecret
    ? { apiKey, apiSecret, accessToken, accessSecret }
    : null;
}

export const isXConfigured = (): boolean => xKeys() !== null;

/** RFC 3986 percent-encoding, which OAuth 1.0a signs (encodeURIComponent leaves !'()* alone). */
const enc = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The OAuth 1.0a HMAC-SHA1 signature: method, the URL without its query, and every signed
 * parameter (query + oauth_*; a JSON or multipart body is not signed) sorted after encoding.
 */
export function oauthSignature(
  method: string,
  baseUrl: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const paramString = Object.entries(params)
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method.toUpperCase()}&${enc(baseUrl)}&${enc(paramString)}`;
  return createHmac("sha1", `${enc(consumerSecret)}&${enc(tokenSecret)}`)
    .update(base)
    .digest("base64");
}

/** The `Authorization: OAuth …` header for one request; `url` may carry a query, which is signed. */
export function authHeader(
  method: string,
  url: string,
  keys: XKeys,
  nonce = randomBytes(16).toString("hex"),
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: keys.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_token: keys.accessToken,
    oauth_version: "1.0",
  };
  oauth.oauth_signature = oauthSignature(
    method,
    `${u.origin}${u.pathname}`,
    { ...Object.fromEntries(u.searchParams), ...oauth },
    keys.apiSecret,
    keys.accessSecret,
  );
  return `OAuth ${Object.entries(oauth)
    .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
    .join(", ")}`;
}

/** One signed call. A failure names the path and X's own answer, never the header. */
async function call<T>(keys: XKeys, method: string, url: string, body?: string | FormData): Promise<T> {
  const headers: Record<string, string> = { authorization: authHeader(method, url, keys) };
  if (typeof body === "string") headers["content-type"] = "application/json";
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`X ${method} ${new URL(url).pathname}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

interface ProcessingInfo {
  state: "pending" | "in_progress" | "failed" | "succeeded";
  check_after_secs?: number;
}
type MediaAnswer = { data: { id: string; processing_info?: ProcessingInfo } };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Uploads an mp4 as Post video: INIT (JSON), APPEND in ≤4 MB multipart segments, FINALIZE, then
 * STATUS until X has processed it. Returns the media id `createPost` attaches.
 */
export async function uploadVideo(
  file: string,
  keys: XKeys,
  base = X_API,
  sleep: (ms: number) => Promise<unknown> = wait,
): Promise<string> {
  const bytes = await readFile(file);
  const init = await call<MediaAnswer>(
    keys,
    "POST",
    `${base}/2/media/upload/initialize`,
    JSON.stringify({ media_type: "video/mp4", total_bytes: bytes.length, media_category: "tweet_video" }),
  );
  const id = init.data.id;
  for (let at = 0, segment = 0; at < bytes.length; at += CHUNK_BYTES, segment++) {
    const form = new FormData();
    form.append("segment_index", String(segment));
    form.append("media", new Blob([new Uint8Array(bytes.subarray(at, at + CHUNK_BYTES))]), "chunk.mp4");
    await call(keys, "POST", `${base}/2/media/upload/${id}/append`, form);
  }
  let info = (await call<MediaAnswer>(keys, "POST", `${base}/2/media/upload/${id}/finalize`)).data
    .processing_info;
  for (let polls = 0; info && info.state !== "succeeded"; polls++) {
    if (info.state === "failed") throw new Error(`X could not process the video (media ${id})`);
    if (polls >= MAX_STATUS_POLLS) throw new Error(`X still processing media ${id} after ${polls} checks`);
    await sleep((info.check_after_secs ?? 1) * 1000);
    info = (await call<MediaAnswer>(keys, "GET", `${base}/2/media/upload?command=STATUS&media_id=${id}`)).data
      .processing_info;
  }
  return id;
}

/** `POST /2/tweets` with one attached video; returns the new post's id. */
export async function createPost(keys: XKeys, text: string, mediaId: string, base = X_API): Promise<string> {
  const answer = await call<{ data: { id: string } }>(
    keys,
    "POST",
    `${base}/2/tweets`,
    JSON.stringify({ text, media: { media_ids: [mediaId] } }),
  );
  return answer.data.id;
}
