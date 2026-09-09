/**
 * YouTube Data, Analytics and Reporting access, with no dependencies.
 *
 * `googleapis` would be the first heavy dependency in this project and it is not needed: OAuth
 * refresh is one form POST, and every call here is `fetch` plus a query string. The resumable
 * upload is the only fiddly part, and that is a documented PUT protocol rather than anything
 * the SDK hides.
 *
 * Credentials live in a token file rather than the environment because a refresh token is
 * long-lived; the key names deliberately match the Python token the `claude-youtube` skill
 * already writes, so the two are interchangeable.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const DATA_API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";
const REPORTING_API = "https://youtubereporting.googleapis.com/v1";

/**
 * Scopes the dashboard needs. `youtube.upload` cannot set a thumbnail or read comments, and
 * `youtube.force-ssl` is what allows replying to one; the two read scopes cover stats and the
 * Reporting job. Listed here so `npm run youtube-auth` and the runtime agree on one definition.
 */
export const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

/** Resumable uploads must send multiples of 256 KiB except for the final chunk. */
const CHUNK_BYTES = 8 * 1024 * 1024;

export interface StoredToken {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  token_uri?: string;
  scopes?: string[];
  obtained_at?: string;
}

export function tokenPath(): string {
  return path.resolve(process.env.YOUTUBE_TOKEN_FILE ?? "youtube-token.json");
}

export function isConfigured(): boolean {
  return existsSync(tokenPath());
}

async function readToken(): Promise<StoredToken> {
  const file = tokenPath();
  if (!existsSync(file)) {
    throw new Error(
      `No YouTube credentials at ${file}. Run \`npm run youtube-auth\` on a machine with a browser, then copy the file here.`,
    );
  }
  const token = JSON.parse(await readFile(file, "utf8")) as StoredToken;
  if (!token.refresh_token) {
    throw new Error(`${file} has no refresh_token; re-run \`npm run youtube-auth\` with prompt=consent.`);
  }
  return token;
}

/** Access tokens last an hour; cached to a minute before expiry so a long upload never straddles. */
let cached: { value: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const token = await readToken();
  const res = await fetch(token.token_uri ?? TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: token.client_id,
      client_secret: token.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    // A revoked or expired refresh token is the one failure a restart will not fix, so say so.
    throw new Error(
      `YouTube token refresh failed: ${res.status} ${res.statusText}. ${await res.text()}\n` +
        "If this says invalid_grant, the refresh token was revoked — re-run `npm run youtube-auth`.",
    );
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cached.value;
}

async function apiCall<T>(
  base: string,
  pathAndQuery: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const accessToken = await getAccessToken();
  const res = await fetchImpl(`${base}${pathAndQuery}`, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await describeApiFailure(res, pathAndQuery));
  return (await res.json()) as T;
}

/**
 * One Data API GET with the auth header and the error text every call here shares. Exported for
 * src/channelUploads.ts, which walks three endpoints and has no reason to re-derive either;
 * `fetchImpl` is its test seam.
 */
export function dataApiGet<T>(pathAndQuery: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  return apiCall<T>(DATA_API, pathAndQuery, {}, fetchImpl);
}

/**
 * Google's error bodies carry the actionable part in `error.errors[].reason`, which is the
 * difference between "fix your quota" and "verify your channel" — worth digging out rather than
 * reporting a bare 403.
 */
async function describeApiFailure(res: Response, where: string): Promise<string> {
  const text = await res.text();
  let reason = "";
  try {
    const body = JSON.parse(text) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    const reasons = (body.error?.errors ?? []).map((e) => e.reason).filter(Boolean);
    reason = [body.error?.message, reasons.length ? `(${reasons.join(", ")})` : ""].filter(Boolean).join(" ");
  } catch {
    reason = text.slice(0, 500);
  }
  const hint =
    res.status === 403 && /quota/i.test(reason)
      ? "\nvideos.insert costs 1,600 of the 10,000 daily units; a long-form plus its Short is ~3,300; the quota resets at midnight Pacific."
      : res.status === 401
        ? "\nThe access token was rejected — the stored scopes may not cover this call."
        : "";
  return `YouTube API ${where} -> ${res.status} ${res.statusText}: ${reason}${hint}`;
}

export interface UploadOptions {
  filePath: string;
  title: string;
  description: string;
  tags?: string[];
  /** 20 = Gaming. */
  categoryId?: string;
  privacyStatus: "private" | "unlisted" | "public";
  /**
   * RFC 3339, e.g. "2026-09-05T18:00:00Z". YouTube only honours a scheduled publish on a
   * private video, so passing this forces privacyStatus to private rather than silently
   * uploading something public immediately.
   */
  publishAt?: string;
  /** `notifySubscribers=false` on the insert: a Short must not push a second bell for one match. */
  notifySubscribers?: boolean;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  /** Test seam for the start POST and the chunk PUTs; the token refresh still uses global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: a 3-chunk file at 8 MiB a chunk is 24 MB of fixture. Multiples of 256 KiB only. */
  chunkBytes?: number;
}

/**
 * Where an interrupted upload's session URL is kept: beside the file, so the next attempt on the
 * same bytes picks up where the last one stopped instead of re-sending a gigabyte. YouTube keeps
 * a session for about a day. `total` guards a re-export under the same name.
 *
 * Named after the file, because a match's long-form and its Short share a directory and the
 * nightly uploads them back to back: one shared name meant starting the Short threw away the
 * long-form's resume, which is the whole point of the feature.
 */
const sessionPath = (filePath: string): string =>
  path.join(path.dirname(filePath), `.upload-session-${path.basename(filePath)}.json`);

async function readSession(filePath: string, total: number): Promise<string | null> {
  try {
    const s = JSON.parse(await readFile(sessionPath(filePath), "utf8")) as {
      filePath?: string;
      total?: number;
      sessionUrl?: string;
    };
    return s.filePath === filePath && s.total === total && s.sessionUrl ? s.sessionUrl : null;
  } catch {
    return null;
  }
}

/**
 * `Range: bytes=0-N` is the last byte YouTube holds. null for a header that is absent or in any
 * other shape — the caller decides what that means, and the two callers mean different things:
 * nothing landed yet on the resume probe, but "assume the chunk we just sent" in the loop.
 * Reading an unparseable header as 0 there restarted the file from the beginning, forever.
 */
const acceptedBytes = (res: Response): number | null => {
  const m = res.headers.get("range")?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : null;
};

export interface UploadResult {
  videoId: string;
  privacyStatus: string;
  publishAt: string | null;
}

export async function uploadVideo(opts: UploadOptions): Promise<UploadResult> {
  if (!existsSync(opts.filePath)) throw new Error(`No such video file: ${opts.filePath}`);
  const total = statSync(opts.filePath).size;
  if (total === 0) throw new Error(`${opts.filePath} is empty`);

  // publishAt is only honoured while the video is private; uploading a scheduled video as
  // public would publish it immediately, which is the opposite of what was asked for.
  const privacyStatus = opts.publishAt ? "private" : opts.privacyStatus;

  const metadata = {
    snippet: {
      title: opts.title,
      description: opts.description,
      tags: opts.tags ?? [],
      categoryId: opts.categoryId ?? "20",
      // Without a language YouTube guesses one from the audio and files the video under it;
      // both POVs' chatter is English and so is every title.
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: false,
      ...(opts.publishAt ? { publishAt: opts.publishAt } : {}),
    },
  };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const accessToken = await getAccessToken();

  // The session file is only useful to a retry, so a terminal answer removes it either way.
  const forget = () => rm(sessionPath(opts.filePath), { force: true });
  const resultOf = (body: { id: string; status?: { privacyStatus?: string; publishAt?: string } }) => ({
    videoId: body.id,
    privacyStatus: body.status?.privacyStatus ?? privacyStatus,
    publishAt: body.status?.publishAt ?? opts.publishAt ?? null,
  });

  // A session left by an interrupted attempt on these exact bytes: ask YouTube how much it holds
  // (`bytes */total`) and carry on from there.
  let sessionUrl = await readSession(opts.filePath, total);
  let uploaded = 0;
  if (sessionUrl) {
    const probe = await fetchImpl(sessionUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-range": `bytes */${total}`,
        "content-length": "0",
      },
      signal: opts.signal,
    });
    // 2xx means YouTube already accepted the last chunk and the process died before it could
    // forget the session: the video exists. Starting over would upload the same match twice.
    if (probe.ok) {
      await forget();
      opts.onProgress?.(total, total);
      return resultOf((await probe.json()) as { id: string });
    }
    if (probe.status === 308) uploaded = acceptedBytes(probe) ?? 0;
    // Anything else means the session is gone; a fresh start is the right answer.
    else sessionUrl = null;
  }

  if (!sessionUrl) {
    const notify = opts.notifySubscribers === false ? "&notifySubscribers=false" : "";
    const start = await fetchImpl(`${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status${notify}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=utf-8",
        "x-upload-content-length": String(total),
        "x-upload-content-type": "video/*",
      },
      body: JSON.stringify(metadata),
      signal: opts.signal,
    });
    if (!start.ok) throw new Error(await describeApiFailure(start, "videos.insert (start)"));
    sessionUrl = start.headers.get("location");
    if (!sessionUrl) throw new Error("YouTube did not return a resumable upload URL");
    await writeFile(
      sessionPath(opts.filePath),
      JSON.stringify({ filePath: opts.filePath, total, sessionUrl, startedAt: new Date().toISOString() }),
      "utf8",
    );
  }

  while (uploaded < total) {
    const end = Math.min(uploaded + chunkBytes, total) - 1;
    const chunk = await readChunk(opts.filePath, uploaded, end);
    const res = await fetchImpl(sessionUrl, {
      method: "PUT",
      headers: {
        "content-length": String(chunk.byteLength),
        "content-range": `bytes ${uploaded}-${end}/${total}`,
      },
      body: new Uint8Array(chunk),
      signal: opts.signal,
    });

    // 308 means "keep going"; the Range header is authoritative about how much actually landed,
    // so resuming from it rather than from our own counter survives a partially-accepted chunk.
    if (res.status === 308) {
      // A Range we cannot read falls back to the chunk we just sent, as it always did: assuming
      // 0 instead would re-send the whole file, and nothing here caps the attempts.
      uploaded = acceptedBytes(res) ?? end + 1;
      opts.onProgress?.(uploaded, total);
      continue;
    }
    if (res.ok) {
      await forget();
      opts.onProgress?.(total, total);
      return resultOf((await res.json()) as { id: string });
    }
    // 5xx and 429 are the retryable ones YouTube documents; the session file stays for those so
    // the next attempt resumes. A 4xx is terminal — the same bytes would be refused again.
    if (res.status < 500 && res.status !== 429) await forget();
    throw new Error(await describeApiFailure(res, "videos.insert (chunk)"));
  }
  throw new Error("Upload finished without YouTube returning a video id");
}

function readChunk(filePath: string, start: number, end: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start, end });
    stream.on("data", (c) => chunks.push(c as Buffer));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** Custom thumbnails require a phone-verified channel; the API says so in the error `reason`. */
export async function setThumbnail(
  videoId: string,
  pngPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!existsSync(pngPath)) throw new Error(`No such thumbnail: ${pngPath}`);
  const accessToken = await getAccessToken();
  const res = await fetchImpl(`${UPLOAD_API}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "image/png" },
    body: new Uint8Array(await readFile(pngPath)),
  });
  if (!res.ok) throw new Error(await describeApiFailure(res, "thumbnails.set"));
}

/**
 * Adds a video to a playlist, creating the playlist the first time.
 *
 * Keyed by title, not id, because an id would have to be copied out of Studio by hand — the
 * manual step this exists to remove. Uses `youtube.force-ssl`, already in the stored token, so
 * enabling this needs no re-consent.
 *
 * It asks before inserting. That used to be unnecessary — this only ever ran on a video
 * `videos.insert` had returned seconds earlier — but "Finish on YouTube" runs on videos that
 * have been through here before, including a retry after one of four joins failed. A duplicate
 * playlist item is a hand-removal in Studio, and the list costs 1 unit against the insert's 50.
 */
export async function addToPlaylist(videoId: string, playlistTitle: string, description = ""): Promise<void> {
  const playlistId = await findOrCreatePlaylist(playlistTitle, description);
  const existing = await apiCall<{ items?: unknown[] }>(
    DATA_API,
    `/playlistItems?part=id&maxResults=1&playlistId=${encodeURIComponent(playlistId)}&videoId=${encodeURIComponent(videoId)}`,
  );
  if ((existing.items ?? []).length > 0) return;
  await apiCall(DATA_API, "/playlistItems?part=snippet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
    }),
  });
}

/**
 * The playlist title for one matchup.
 *
 * Sorted, and case-insensitively, so the same two players land in one playlist however they were
 * seated: MCSR decides who is players[0] per match, so "doogile vs Feinberg" and
 * "Feinberg vs doogile" are the same series, and two playlists for it would be worse than none.
 */
export function matchupPlaylistTitle(a: string, b: string): string {
  const [first, second] = [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
  return `${first} vs ${second} · MCSR Ranked`;
}

/**
 * The playlist title for one player: every match of theirs on the channel. Runners' fans follow
 * a runner, not a channel, and a runner asked to share "their" matches needs one link, not a
 * search. The nickname as the API spells it, so the same person never gets two.
 */
export function playerPlaylistTitle(nickname: string): string {
  return `${nickname} · MCSR Ranked matches`;
}

/**
 * Playlist descriptions, which YouTube indexes and shows on the playlist page. Set at creation
 * only — an existing playlist keeps whatever it has, so a hand-edited one is never overwritten.
 */
export const SEASON_PLAYLIST_DESCRIPTION =
  "Every MCSR Ranked 1v1 on MCSR Replayoffs, oldest first: top-bracket matches, both POVs synced with a live split comparison, head-to-head record and seed on the intro card. Subscribe for the next one.";

export function matchupPlaylistDescription(a: string, b: string): string {
  const [first, second] = [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
  return `Every ranked 1v1 between ${first} and ${second} on MCSR Replayoffs, oldest first — both POVs synced, with the live split comparison and the head-to-head record on the intro card.`;
}

/**
 * One playlist per tournament, in place of the matchup's: a playoff series is watched as a
 * bracket, not as a rivalry, and the same pair's ranked games have no business in it.
 */
export function playoffPlaylistTitle(season: number): string {
  return `MCSR Ranked Season ${season} Playoffs · Replayoffs`;
}

export function playoffPlaylistDescription(season: number): string {
  return `Every game of the MCSR Ranked Season ${season} Playoffs on MCSR Replayoffs, in bracket order — both POVs synced, with the live split comparison and the round and game number on the intro card. Bracket: https://mcsrranked.com/playoffs/${season}`;
}

export function playerPlaylistDescription(nickname: string): string {
  return `Every MCSR Ranked 1v1 of ${nickname}'s on MCSR Replayoffs, oldest first — both POVs synced with a live split comparison.`;
}

/**
 * Playlist ids this process has already resolved or created, by title. YouTube's `playlists.list`
 * does not show a playlist it created a second earlier — measured: the season playlist was made,
 * the very next call listed the channel without it, and created a second one with the same title.
 * Every upload runs two inserts back to back (season, then matchup), so without this the channel
 * grows a duplicate playlist per upload.
 */
const playlistIds = new Map<string, string>();

/** Exported for the test; `addToPlaylist` is the entry point everything else should use. */
export async function findOrCreatePlaylist(title: string, description = ""): Promise<string> {
  const known = playlistIds.get(title);
  if (known) return known;
  const id = await lookupOrCreatePlaylist(title, description);
  playlistIds.set(title, id);
  return id;
}

async function lookupOrCreatePlaylist(title: string, description: string): Promise<string> {
  // `mine=true` scopes the search to the operator's own playlists, so a title collision with
  // someone else's public playlist cannot hijack this.
  let pageToken = "";
  for (;;) {
    const page = await apiCall<{
      items?: Array<{ id: string; snippet: { title: string } }>;
      nextPageToken?: string;
    }>(DATA_API, `/playlists?part=snippet&mine=true&maxResults=50${pageToken}`);
    const hit = (page.items ?? []).find((p) => p.snippet.title === title);
    if (hit) return hit.id;
    if (!page.nextPageToken) break;
    pageToken = `&pageToken=${encodeURIComponent(page.nextPageToken)}`;
  }

  const created = await apiCall<{ id: string }>(DATA_API, "/playlists?part=snippet,status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snippet: { title, description }, status: { privacyStatus: "public" } }),
  });
  return created.id;
}

export interface VideoStats {
  videoId: string;
  title: string;
  publishedAt: string;
  privacyStatus: string;
  publishAt: string | null;
  views: number;
  likes: number;
  comments: number;
}

export async function videoStats(videoIds: string[]): Promise<VideoStats[]> {
  if (videoIds.length === 0) return [];
  const body = await apiCall<{
    items: Array<{
      id: string;
      snippet: { title: string; publishedAt: string };
      status: { privacyStatus: string; publishAt?: string };
      statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
    }>;
  }>(DATA_API, `/videos?part=snippet,status,statistics&id=${videoIds.map(encodeURIComponent).join(",")}`);

  return body.items.map((v) => ({
    videoId: v.id,
    title: v.snippet.title,
    publishedAt: v.snippet.publishedAt,
    privacyStatus: v.status.privacyStatus,
    publishAt: v.status.publishAt ?? null,
    // Absent rather than zero when the owner has hidden the count, so `?? 0` is a display
    // choice, not a measurement.
    views: Number(v.statistics.viewCount ?? 0),
    likes: Number(v.statistics.likeCount ?? 0),
    comments: Number(v.statistics.commentCount ?? 0),
  }));
}

export interface CommentThread {
  threadId: string;
  author: string;
  text: string;
  publishedAt: string;
  likeCount: number;
  /** True when nobody from the channel has replied in this thread. */
  unanswered: boolean;
}

/**
 * Comment threads on a video, flagged by whether the channel has answered.
 *
 * "Unanswered" means no reply in the thread was authored by the channel itself — replies from
 * other viewers do not count, since the point is finding what still needs *you*.
 */
export async function commentThreads(videoId: string, channelId: string): Promise<CommentThread[]> {
  const body = await apiCall<{
    items: Array<{
      id: string;
      snippet: {
        topLevelComment: {
          snippet: {
            authorDisplayName: string;
            textDisplay: string;
            publishedAt: string;
            likeCount: number;
            authorChannelId?: { value?: string };
          };
        };
      };
      replies?: { comments: Array<{ snippet: { authorChannelId?: { value?: string } } }> };
    }>;
  }>(
    DATA_API,
    `/commentThreads?part=snippet,replies&maxResults=50&order=time&videoId=${encodeURIComponent(videoId)}`,
  );

  return body.items.map((t) => {
    const top = t.snippet.topLevelComment.snippet;
    const answered =
      top.authorChannelId?.value === channelId ||
      (t.replies?.comments ?? []).some((c) => c.snippet.authorChannelId?.value === channelId);
    return {
      threadId: t.id,
      author: top.authorDisplayName,
      text: top.textDisplay,
      publishedAt: top.publishedAt,
      likeCount: top.likeCount,
      unanswered: !answered,
    };
  });
}

/**
 * A new top-level comment on a video — the first one, which the operator then pins in Studio
 * (pinning has no API). Same scope as replying. 50 units.
 */
export async function postComment(videoId: string, text: string): Promise<void> {
  await apiCall(DATA_API, "/commentThreads?part=snippet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } },
    }),
  });
}

/** Needs `youtube.force-ssl`; the read scopes alone cannot post. */
export async function replyToComment(parentThreadId: string, text: string): Promise<void> {
  await apiCall(DATA_API, "/comments?part=snippet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snippet: { parentId: parentThreadId, textOriginal: text } }),
  });
}

export interface ImpressionsRow {
  date: string;
  videoId: string;
  impressions: number;
  /** Fraction, 0-1, as the Reporting API delivers it. */
  ctr: number;
}

/**
 * Per-video thumbnail impressions and CTR from the standing Reporting API job.
 *
 * This is the *only* source of those two numbers — the Analytics API does not expose them — so
 * thumbnail A/B testing depends entirely on this job existing and having produced a report.
 * Reports appear roughly 48h after the day they cover, so a video uploaded today has none.
 */
export async function latestImpressions(jobId: string): Promise<ImpressionsRow[]> {
  const list = await apiCall<{ reports?: Array<{ id: string; downloadUrl: string; endTime: string }> }>(
    REPORTING_API,
    `/jobs/${encodeURIComponent(jobId)}/reports`,
  );
  const reports = list.reports ?? [];
  if (reports.length === 0) return [];

  const newest = reports.reduce((a, b) => (a.endTime > b.endTime ? a : b));
  const accessToken = await getAccessToken();
  const res = await fetch(newest.downloadUrl, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(await describeApiFailure(res, "reporting download"));
  return parseImpressionsCsv(await res.text());
}

/**
 * Reporting API CSVs are plain comma-separated with a header row naming the columns. Reading the
 * header rather than assuming positions means a column added upstream cannot silently shift the
 * CTR into the impressions slot.
 */
export function parseImpressionsCsv(csv: string): ImpressionsRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0]!.split(",");
  const iDate = header.indexOf("date");
  const iVideo = header.indexOf("video_id");
  const iImpressions = header.indexOf("video_thumbnail_impressions");
  const iCtr = header.indexOf("video_thumbnail_impressions_ctr");
  if (iVideo < 0 || iImpressions < 0 || iCtr < 0) {
    throw new Error(`Reporting CSV is missing expected columns; header was: ${header.join(", ")}`);
  }

  const rows: ImpressionsRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    if (cells.length < header.length) continue;
    rows.push({
      date: iDate >= 0 ? (cells[iDate] ?? "") : "",
      videoId: cells[iVideo]!,
      impressions: Number(cells[iImpressions]),
      ctr: Number(cells[iCtr]),
    });
  }
  return rows;
}
