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
import { readFile } from "node:fs/promises";
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

async function apiCall<T>(base: string, pathAndQuery: string, init: RequestInit = {}): Promise<T> {
  const accessToken = await getAccessToken();
  const res = await fetch(`${base}${pathAndQuery}`, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await describeApiFailure(res, pathAndQuery));
  return (await res.json()) as T;
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
      ? "\nThe Data API's default quota is 10,000 units/day; uploads draw on a separate bucket."
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
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

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
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: false,
      ...(opts.publishAt ? { publishAt: opts.publishAt } : {}),
    },
  };

  const accessToken = await getAccessToken();
  const start = await fetch(`${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`, {
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

  const sessionUrl = start.headers.get("location");
  if (!sessionUrl) throw new Error("YouTube did not return a resumable upload URL");

  let uploaded = 0;
  while (uploaded < total) {
    const end = Math.min(uploaded + CHUNK_BYTES, total) - 1;
    const chunk = await readChunk(opts.filePath, uploaded, end);
    const res = await fetch(sessionUrl, {
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
      const accepted = res.headers.get("range")?.match(/bytes=0-(\d+)/);
      uploaded = accepted ? Number(accepted[1]) + 1 : end + 1;
      opts.onProgress?.(uploaded, total);
      continue;
    }
    if (res.ok) {
      const body = (await res.json()) as {
        id: string;
        status?: { privacyStatus?: string; publishAt?: string };
      };
      opts.onProgress?.(total, total);
      return {
        videoId: body.id,
        privacyStatus: body.status?.privacyStatus ?? privacyStatus,
        publishAt: body.status?.publishAt ?? opts.publishAt ?? null,
      };
    }
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
export async function setThumbnail(videoId: string, pngPath: string): Promise<void> {
  if (!existsSync(pngPath)) throw new Error(`No such thumbnail: ${pngPath}`);
  const accessToken = await getAccessToken();
  const res = await fetch(`${UPLOAD_API}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "image/png" },
    body: new Uint8Array(await readFile(pngPath)),
  });
  if (!res.ok) throw new Error(await describeApiFailure(res, "thumbnails.set"));
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
