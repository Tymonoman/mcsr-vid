/**
 * What is actually on the channel, matched back to the match that produced it.
 *
 * Uploads go through YouTube Studio by hand while the API audit is pending, so nothing on disk
 * records them.
 *
 * The link back is the description. Every description the pipeline writes carries
 * `Match data: https://mcsrranked.com/matches/<id>` (src/description.ts) and that description is
 * what the operator pastes into Studio, so the channel itself says which match a video is —
 * without a tick, a file, or a step to forget. What survives the hand-editing that line gets is
 * the `/matches/<id>` segment, not the host; see `channelVideoFor`.
 *
 * Shaped like src/rivalPosts.ts: an in-memory snapshot refreshed every six hours,
 * fire-and-forget from the routes that read it, and never a reason for a page to fail — no
 * token, no network, no match means "nothing known", not an error. The manual tick stays as the
 * fallback for what the link cannot find: the hand-made uploads from before the pipeline, whose
 * descriptions were written by hand and name no match.
 */
import { describeError } from "./errorText.js";
import { listProcessedMatchIds } from "./matchStatus.js";
import { recordStudioUpload } from "./youtubeUpload.js";
import { dataApiGet, isConfigured } from "./youtube.js";
import { readUpload } from "./youtubeStore.js";

export interface ChannelVideo {
  videoId: string;
  title: string;
  publishedAt: string;
  description: string;
  privacyStatus: string;
  /** From contentDetails.duration; what tells the match video from its Short. */
  durationSec: number;
}

/** YouTube's line: at most three minutes is a Short. */
const SHORT_MAX_SEC = 180;

/** `PT1H2M3S` → seconds. YouTube never sends days here; a shape it does not match reads as 0. */
export function parseIsoDuration(iso: string | undefined): number {
  const m = iso?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * The channel's video for this match, or null.
 *
 * Matched on the `/matches/<id>` path segment rather than on the whole URL: measured against the
 * three pipeline-era videos live on the channel today, that line has been hand-edited into three
 * shapes — `https://mcsrranked.com/matches/13048744`, the same without a scheme, and
 * `https://magmamcsr.com/ranked/player/lowk3y_/matches/12296170?season=11`. The host and the
 * query string are what the operator changes; the path segment is what identifies the match.
 * Twitch's POV links in the same description are `/videos/<id>`, so this cannot collide with one.
 *
 * The id has to end where the segment ends: a plain substring test finds match 1312345 inside a
 * link to 13123456, which would report a match as published because a *different* one was.
 */
export function channelVideoFor(matchId: number, videos: readonly ChannelVideo[]): ChannelVideo | null {
  const link = new RegExp(`/matches/${matchId}(?![0-9])`);
  return videos.find((v) => v.durationSec > SHORT_MAX_SEC && link.test(v.description)) ?? null;
}

/** The Short of this match: same link in its description (src/shortHook.ts), three minutes or under. */
export function channelShortFor(matchId: number, videos: readonly ChannelVideo[]): ChannelVideo | null {
  const link = new RegExp(`/matches/${matchId}(?![0-9])`);
  return videos.find((v) => v.durationSec <= SHORT_MAX_SEC && link.test(v.description)) ?? null;
}

/** YouTube's cap on ids per `videos.list`, and on rows per playlist page. */
const PAGE = 50;

/**
 * Every video on the operator's own channel. Throws on API failure; the cache below catches.
 * Descriptions only come from `videos.list` — the uploads playlist truncates them — so this is
 * three endpoints, not one.
 */
export async function fetchChannelUploads(fetchImpl: typeof fetch = fetch): Promise<ChannelVideo[]> {
  const channel = await dataApiGet<{
    items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
  }>("/channels?part=contentDetails&mine=true", fetchImpl);
  const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error("the stored token's channel has no uploads playlist");

  const videoIds: string[] = [];
  let pageToken = "";
  for (;;) {
    const page = await dataApiGet<{
      items?: Array<{ contentDetails: { videoId: string } }>;
      nextPageToken?: string;
    }>(
      `/playlistItems?part=contentDetails&maxResults=${PAGE}&playlistId=${encodeURIComponent(uploads)}${pageToken}`,
      fetchImpl,
    );
    videoIds.push(...(page.items ?? []).map((i) => i.contentDetails.videoId));
    if (!page.nextPageToken) break;
    pageToken = `&pageToken=${encodeURIComponent(page.nextPageToken)}`;
  }

  const videos: ChannelVideo[] = [];
  for (let i = 0; i < videoIds.length; i += PAGE) {
    const batch = await dataApiGet<{
      items?: Array<{
        id: string;
        snippet: { title: string; publishedAt: string; description?: string };
        status: { privacyStatus: string };
        contentDetails?: { duration?: string };
      }>;
    }>(`/videos?part=snippet,status,contentDetails&id=${videoIds.slice(i, i + PAGE).join(",")}`, fetchImpl);
    videos.push(
      ...(batch.items ?? []).map((v) => ({
        videoId: v.id,
        title: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        description: v.snippet.description ?? "",
        privacyStatus: v.status.privacyStatus,
        durationSec: parseIsoDuration(v.contentDetails?.duration),
      })),
    );
  }
  return videos;
}

const REFRESH_MS = 6 * 60 * 60 * 1000;
let cached: { atMs: number; videos: ChannelVideo[] } = { atMs: 0, videos: [] };
let inflight: Promise<void> | null = null;

/** What is known right now — possibly nothing yet. Synchronous, for the callers on hot paths. */
export function channelUploadsSnapshot(): ChannelVideo[] {
  return cached.videos;
}

/**
 * Refreshes the cache when it is older than six hours, in the background, once at a time.
 * Fire-and-forget from the routes that read it; the first request after boot answers without
 * the Studio uploads and the next has them.
 */
export function refreshChannelUploadsIfStale(nowMs: number = Date.now()): void {
  if (!isConfigured()) return;
  if (inflight || nowMs - cached.atMs < REFRESH_MS) return;
  inflight = refresh(nowMs);
}

/**
 * Now, whatever the cache's age: the operator has just uploaded in Studio and wants the row to
 * say so, not six hours from now. Three quota units, on a click. Shares the in-flight refresh.
 */
export function refreshChannelUploadsNow(
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!isConfigured()) return Promise.resolve();
  if (!inflight) inflight = refresh(nowMs, fetchImpl);
  return inflight;
}

/**
 * A Studio upload seen for the first time gets the record a dashboard upload would have written
 * (`source: "studio"`), so the A/B table, the audit and "Finish on YouTube" have one shape to
 * read; the rest of what a first pairing triggers (archive, the optional auto-finish) is in
 * youtubeRoutes.ts. Sequential: a channel scan is not the place for six parallel rsyncs.
 */
async function recordNewPairings(videos: readonly ChannelVideo[]): Promise<void> {
  for (const matchId of listProcessedMatchIds()) {
    const video = channelVideoFor(matchId, videos);
    if (!video || (await readUpload(matchId))) continue;
    await recordStudioUpload(matchId, video).catch((err: unknown) =>
      console.error(`channel: recording the Studio upload of #${matchId}: ${describeError(err)}`),
    );
  }
}

function refresh(nowMs: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  return fetchChannelUploads(fetchImpl)
    .then(async (videos) => {
      cached = { atMs: nowMs, videos };
      console.error(`channel: ${videos.length} videos on the channel`);
      await recordNewPairings(videos);
    })
    .catch((err: unknown) => {
      // Five minutes rather than six hours — a transient 5xx must not make every published
      // match look unpublished for a quarter of a day — but not on every request either: the
      // match list is polled, and a dead token would spend a call per poll.
      cached = { ...cached, atMs: nowMs - REFRESH_MS + 5 * 60_000 };
      console.error(`channel: ${describeError(err)} (Studio uploads unrecognised until the next try)`);
    })
    .finally(() => {
      inflight = null;
    });
}

/** Test seam. */
export function _setChannelUploadsForTest(videos: ChannelVideo[]): void {
  cached = { atMs: Date.now(), videos };
}
