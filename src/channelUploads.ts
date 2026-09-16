/**
 * What is actually on the channel, matched back to the match that produced it.
 *
 * Uploads went through YouTube Studio by hand while the API audit was pending (cleared 15 Sept
 * 2026), so nothing on disk records those.
 *
 * The link back is the description. Every description the pipeline writes carries
 * `Match page: https://mcsrranked.com/matches/<id>` (src/description.ts) and that description is
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
import { config } from "./config.js";
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
  /**
   * Whether the video is in the season playlist every description links to. `undefined` when the
   * playlist could not be read (or is not configured), which is not the same as "no".
   */
  inSeasonPlaylist?: boolean;
  /**
   * The tags actually on the video. The pipeline writes eleven per match — both nicknames and the
   * seed among them — into `match-<id>.tags.txt`, but a Studio upload only carries what was typed
   * into the box, and every video on the channel today has the same four generic ones. Kept so
   * the dashboard can say when an upload is missing the tags that were generated for it.
   *
   * Optional, and absent is not empty: absent means nothing recorded them (a fixture, a scan from
   * before this field), while `[]` means the video really has none.
   */
  tags?: string[];
  /**
   * The scheduled publish time YouTube holds a private video for, RFC 3339, or absent when there
   * is none. Kept because a slot the channel has already booked is a slot the publish kit must
   * not propose again (src/publishSlot.ts). Optional: a video published on upload has no such
   * time, and neither do the fixtures the tests build.
   */
  publishAt?: string | null;
}

/** YouTube's line: at most three minutes is a Short. */
export const SHORT_MAX_SEC = 180;

/**
 * `PT1H2M3S` → seconds. YouTube never sends days here; a shape it does not match reads as 0,
 * which is "unknown", not "zero seconds" — a video still processing answers `P0D`, and "check
 * the channel" is pressed at exactly that moment.
 */
export function parseIsoDuration(iso: string | undefined): number {
  const m = iso?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * A Short is a video *known* to be three minutes or under. An unknown length (0) is the match
 * video, not the Short: the alternative ticks "the Short is up" on a match whose Short has never
 * been uploaded, and leaves the panel offering an upload form for a video already on the channel.
 *
 * ponytail: a Short caught mid-processing pairs as the long-form for one scan. It costs a wrong
 * record only when nothing else is paired to that match yet — the long-form is uploaded first and
 * `recordNewPairings` skips a match that already has one.
 */
const knownShort = (v: ChannelVideo): boolean => v.durationSec > 0 && v.durationSec <= SHORT_MAX_SEC;

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
  return videos.find((v) => !knownShort(v) && describesMatch(matchId, v)) ?? null;
}

/** The Short of this match: same link in its description (src/shortHook.ts), three minutes or under. */
export function channelShortFor(matchId: number, videos: readonly ChannelVideo[]): ChannelVideo | null {
  return videos.find((v) => knownShort(v) && describesMatch(matchId, v)) ?? null;
}

/**
 * Whether this video's description names this match — the test both lookups above share.
 *
 * Exported because a match has up to two videos on the channel and "the first one of them" is
 * the wrong answer when the question is "everything that is this match's": the publish kit
 * excludes its own match's booked slots (src/publishSlot.ts), and its own Short's day is not a
 * day it has to move out of.
 */
export function describesMatch(matchId: number, video: ChannelVideo): boolean {
  return new RegExp(`/matches/${matchId}(?![0-9])`).test(video.description);
}

/** YouTube's cap on ids per `videos.list`, and on rows per playlist page. */
const PAGE = 50;

/**
 * Every video on the operator's own channel. Throws on API failure; the cache below catches.
 * Descriptions only come from `videos.list` — the uploads playlist truncates them — so this is
 * three endpoints, not one.
 */
/** The list id out of a playlist URL, or null when there is no playlist configured. */
function seasonPlaylistIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /[?&]list=([A-Za-z0-9_-]+)/.exec(url);
  return m ? m[1]! : null;
}

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

  // Which of them are in the season playlist. Every description links to it, so a video that is
  // not in it advertises a playlist it is missing from — which happened once, silently, because a
  // Studio upload has to be added by hand. One extra request; a failure leaves the answer unknown
  // rather than wrong.
  const seasonPlaylistId = seasonPlaylistIdFromUrl(config.youtubePlaylistUrl);
  let inSeason: Set<string> | null = null;
  if (seasonPlaylistId) {
    try {
      const ids: string[] = [];
      let token = "";
      for (;;) {
        const page = await dataApiGet<{
          items?: Array<{ contentDetails: { videoId: string } }>;
          nextPageToken?: string;
        }>(
          `/playlistItems?part=contentDetails&maxResults=${PAGE}&playlistId=${encodeURIComponent(seasonPlaylistId)}${token}`,
          fetchImpl,
        );
        ids.push(...(page.items ?? []).map((i) => i.contentDetails.videoId));
        if (!page.nextPageToken) break;
        token = `&pageToken=${encodeURIComponent(page.nextPageToken)}`;
      }
      inSeason = new Set(ids);
    } catch (err) {
      console.error(`season playlist unreadable, membership unknown: ${describeError(err)}`);
    }
  }

  const videos: ChannelVideo[] = [];
  for (let i = 0; i < videoIds.length; i += PAGE) {
    const batch = await dataApiGet<{
      items?: Array<{
        id: string;
        snippet: { title: string; publishedAt: string; description?: string; tags?: string[] };
        status: { privacyStatus: string; publishAt?: string };
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
        tags: v.snippet.tags ?? [],
        ...(inSeason ? { inSeasonPlaylist: inSeason.has(v.id) } : {}),
        publishAt: v.status.publishAt ?? null,
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
