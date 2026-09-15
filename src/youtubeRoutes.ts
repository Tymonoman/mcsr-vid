/**
 * The dashboard's YouTube endpoints.
 *
 * Split from server.ts for size, and it keeps the same rule: transport only. Anything resembling
 * a decision belongs in youtube.ts (the API), youtubeUpload.ts (what an upload does) or
 * youtubeStore.ts (what we recorded about a match).
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  channelUploadsSnapshot,
  channelVideoFor,
  parseIsoDuration,
  SHORT_MAX_SEC,
  refreshChannelUploadsIfStale,
  refreshChannelUploadsNow,
  type ChannelVideo,
} from "./channelUploads.js";
import { auditState, readAudit, startAudit } from "./audit.js";
import { config, matchDir } from "./config.js";
import { describeError } from "./errorText.js";
import { listProcessedMatchIds, matchStatusFor } from "./matchStatus.js";
import { exportStale, staleExportMessage } from "./syncFile.js";
import { readManifest, variantFellBack } from "./thumbnailVariants.js";
import {
  applyMetadata,
  commentThreads,
  isConfigured,
  latestImpressions,
  replyToComment,
  videoStats,
  type ImpressionsRow,
} from "./youtube.js";
import {
  allUploads,
  findExportedVideo,
  readUpload,
  uploadTextFor,
  videoIdOwner,
  writeUpload,
} from "./youtubeStore.js";
import { beginUpload, finishOnYouTube, uploadProgress } from "./youtubeUpload.js";
import { HOOK_PLACEHOLDER } from "./title.js";
import { yppProgress } from "./yppProgress.js";

export { uploadRunning } from "./youtubeUpload.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage) => Promise<string>;

export interface YoutubeRouteContext {
  json: Json;
  readBody: ReadBody;
  matchDir: (matchId: number) => string;
  parseId: (raw: string | undefined) => number | null;
}

/**
 * Returns true when it handled the request. Written as a predicate rather than a router so
 * server.ts keeps one obvious dispatch chain rather than gaining a routing abstraction.
 */
export async function handleYoutubeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  ctx: YoutubeRouteContext,
): Promise<boolean> {
  const [, resource, action, idRaw] = segments;
  if (resource !== "youtube") return false;

  // Everything below needs credentials; saying so once beats five identical 401s.
  if (!isConfigured() && action !== "status") {
    ctx.json(res, 503, {
      error:
        "YouTube is not connected. Run `npm run youtube-auth` on a machine with a browser, then copy youtube-token.json into the repo root.",
    });
    return true;
  }

  if (action === "status" && req.method === "GET") {
    ctx.json(res, 200, {
      connected: isConfigured(),
      channelId: config.youtubeChannelId,
      uploadsEnabled: config.youtubeUploadEnabled,
    });
    return true;
  }

  if (action === "uploads" && req.method === "GET") {
    // Fire-and-forget, as the suggestions route does for the rival posts: the first request
    // after boot answers without the Studio uploads and the next one has them. `?fresh=1` is
    // the operator back from Studio: list the channel now and answer with it.
    if (new URL(req.url ?? "/", "http://x").searchParams.get("fresh") === "1")
      await refreshChannelUploadsNow();
    else refreshChannelUploadsIfStale();
    ctx.json(res, 200, await uploadsPayload());
    return true;
  }

  if (action === "abtest" && req.method === "GET") {
    ctx.json(res, 200, await abTestPayload());
    return true;
  }

  // The Partner Programme gates with the current rate and the date each lands. Cached six
  // hours; the first request after boot answers `stale` while the numbers are fetched.
  if (action === "ypp" && req.method === "GET") {
    ctx.json(res, 200, yppProgress());
    return true;
  }

  if (action === "reply" && req.method === "POST") {
    const body = JSON.parse(await ctx.readBody(req)) as { threadId?: unknown; text?: unknown };
    if (typeof body.threadId !== "string" || typeof body.text !== "string" || body.text.trim() === "") {
      ctx.json(res, 400, { error: 'expected { threadId: "…", text: "…" }' });
      return true;
    }
    try {
      await replyToComment(body.threadId, body.text);
      ctx.json(res, 200, { replied: true });
    } catch (err) {
      ctx.json(res, 502, { error: describeError(err) });
    }
    return true;
  }

  const matchId = ctx.parseId(idRaw);
  if (matchId === null) {
    ctx.json(res, 400, { error: "match id must be digits" });
    return true;
  }

  if (action === "upload" && req.method === "POST") {
    await startUpload(req, res, matchId, ctx);
    return true;
  }

  if (action === "upload" && req.method === "GET") {
    const kind = new URL(req.url ?? "/", "http://x").searchParams.get("kind") === "short" ? "short" : "video";
    ctx.json(res, 200, uploadProgress(matchId, kind));
    return true;
  }

  /**
   * Adopt a bare Studio draft: the operator drops the file in and pastes the video id, and the
   * title, description and tags go on through `videos.update`, followed by the finish steps.
   *
   * This exists because the pairing everything else relies on is the `/matches/<id>` link in the
   * description (`describesMatch`) — which a draft with an empty description does not have. Once
   * the description is written the video pairs itself and the rest of the dashboard sees it.
   *
   * It REPLACES the title and description, so it is deliberately one explicit press on a video
   * the operator names by id, never something a scan or the nightly can reach.
   */
  if (action === "adopt" && req.method === "POST") {
    const body = JSON.parse(await ctx.readBody(req)) as { videoId?: unknown };
    const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
    // A YouTube id, not a URL and not a search: this reaches an API call and a stored record.
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      ctx.json(res, 400, {
        error: `"${videoId}" is not a YouTube video id (11 characters from the Studio URL)`,
      });
      return true;
    }
    // Across both kinds: the id most likely to be pasted by mistake is this match's own Short,
    // which sits beside the long-form in Studio and which `allUploads` cannot see.
    const owner = await videoIdOwner(videoId);
    if (owner && !(owner.matchId === matchId && owner.kind === "video")) {
      ctx.json(res, 409, {
        error: `${videoId} is already this dashboard's ${owner.kind === "short" ? "Short" : "video"} for match ${owner.matchId}`,
      });
      return true;
    }
    const { title, description, tags } = await uploadTextFor(matchId, "video");
    if (title.includes(HOOK_PLACEHOLDER)) {
      ctx.json(res, 409, { error: `The title still reads ${HOOK_PLACEHOLDER} — pick a hook first` });
      return true;
    }
    if (!description.includes(`/matches/${matchId}`)) {
      // Without it the video would not pair, and every later lookup would call it unpublished.
      ctx.json(res, 409, {
        error: `The description does not link /matches/${matchId}, so the video would not pair`,
      });
      return true;
    }
    // The thumbnail step declines on a video uploaded elsewhere unless a variant was confirmed
    // here, so without this the happy path would quietly leave YouTube's auto frame on. Refused
    // up front, like the hook above, rather than reported as a problem afterwards.
    const manifest = await readManifest(matchDir(matchId));
    if (manifest?.chosenBy !== "operator") {
      ctx.json(res, 409, {
        error: `No thumbnail variant is confirmed — press "Keep this" on the strip first, or the video would keep YouTube's auto frame`,
      });
      return true;
    }
    // The draft in Studio is the export on disk, and a sync.json written after that export means
    // the export places the clips by numbers the operator has since corrected. The same refusal
    // the Upload button gets (`beginUpload`); no export at all is not stale, only unverifiable.
    const status = await matchStatusFor(matchId);
    const located = findExportedVideo(matchId, [status.leftNickname, status.rightNickname]);
    if (!("error" in located) && exportStale(matchDir(matchId), located.path).stale) {
      ctx.json(res, 409, { error: staleExportMessage(matchId) });
      return true;
    }
    try {
      const [live] = await videoStats([videoId]);
      if (!live) {
        ctx.json(res, 404, { error: `No video ${videoId} is readable with this account` });
        return true;
      }
      // A match video runs ten-odd minutes; three minutes or less is a Short, and adopting one
      // would put the long-form's title and description on it. 0 means "unknown" (still
      // processing), which is not a reason to refuse.
      const durationSec = parseIsoDuration(live.duration);
      if (durationSec > 0 && durationSec <= SHORT_MAX_SEC) {
        ctx.json(res, 409, {
          error: `${videoId} is ${durationSec}s long — that is a Short, not the match video`,
        });
        return true;
      }
      const applied = await applyMetadata(videoId, { title, description, tags }, config.youtubeChannelId);
      // Re-adopting the SAME video keeps the finish ledger: it is the only thing between a second
      // press and a second pinned comment, which `postComment` de-duplicates not at all. A
      // different video for this match is a different video, and starts a fresh ledger.
      const previous = await readUpload(matchId);
      const carried = previous?.videoId === videoId ? (previous.finished ?? {}) : {};
      await writeUpload(matchId, {
        videoId,
        uploadedAt: live.publishedAt,
        publishAt: live.publishAt,
        privacyStatus: live.privacyStatus,
        thumbnailVariant: null,
        title,
        source: "studio",
        finished: carried,
      });
      const finished = await finishOnYouTube(matchId, videoId);
      // The A/B tab reads `thumbnailVariant` for a local record and falls back to the manifest
      // only for a channel-derived one, so leaving this null drops an adopted video out of the
      // hook-vs-control comparison. Recorded only once the image has actually gone up.
      if (finished.thumbnail === null) {
        const written = await readUpload(matchId);
        if (written) await writeUpload(matchId, { ...written, thumbnailVariant: manifest.chosen });
      }
      ctx.json(res, 200, {
        videoId,
        replacedTitle: applied.replacedTitle,
        addedTags: applied.addedTags,
        skippedTags: applied.skippedTags,
        finished,
      });
    } catch (err) {
      ctx.json(res, 502, { error: describeError(err) });
    }
    return true;
  }

  // A Studio upload is on the channel with YouTube's auto-thumbnail, in no playlist and with an
  // empty comment box; this is the rest of what a dashboard upload would have done to it.
  if (action === "finish" && req.method === "POST") {
    const videoId =
      (await readUpload(matchId))?.videoId ??
      channelVideoFor(matchId, channelUploadsSnapshot())?.videoId ??
      null;
    if (!videoId) {
      ctx.json(res, 409, {
        error: `No channel video is paired to match ${matchId} yet — upload it in Studio with the match link in the description, then check the channel`,
      });
      return true;
    }
    try {
      ctx.json(res, 200, { videoId, finished: await finishOnYouTube(matchId, videoId) });
    } catch (err) {
      ctx.json(res, 502, { error: describeError(err) });
    }
    return true;
  }

  // On demand only. The button that reaches this says what it costs, and nothing schedules it.
  if (action === "audit" && req.method === "POST") {
    const record = await readUpload(matchId);
    if (!record) {
      ctx.json(res, 404, { error: `Match ${matchId} has not been uploaded, so there is nothing to audit` });
      return true;
    }
    const status = await matchStatusFor(matchId);
    const [stats] = await videoStats([record.videoId]).catch(() => []);
    const reach = await reachFor(record.videoId);
    ctx.json(
      res,
      202,
      startAudit({
        matchId,
        videoId: record.videoId,
        title: record.title,
        description: "",
        players: [status.leftNickname, status.rightNickname],
        stats: stats ? { views: stats.views, likes: stats.likes, comments: stats.comments } : null,
        reach,
      }),
    );
    return true;
  }

  if (action === "audit" && req.method === "GET") {
    const state = auditState(matchId);
    ctx.json(res, 200, { ...state, report: state.running ? null : await readAudit(matchId) });
    return true;
  }

  if (action === "comments" && req.method === "GET") {
    const record = await readUpload(matchId);
    if (!record) {
      ctx.json(res, 404, { error: `Match ${matchId} has not been uploaded` });
      return true;
    }
    try {
      ctx.json(res, 200, { threads: await commentThreads(record.videoId, config.youtubeChannelId) });
    } catch (err) {
      ctx.json(res, 502, { error: describeError(err) });
    }
    return true;
  }

  return false;
}

async function startUpload(
  req: IncomingMessage,
  res: ServerResponse,
  matchId: number,
  ctx: YoutubeRouteContext,
): Promise<void> {
  const body = JSON.parse(await ctx.readBody(req)) as {
    kind?: unknown;
    privacyStatus?: unknown;
    publishAt?: unknown;
    videoPath?: unknown;
  };
  const privacyStatus =
    body.privacyStatus === "public" || body.privacyStatus === "unlisted" ? body.privacyStatus : "private";

  // publishAt must be RFC 3339 and in the future, or YouTube rejects the whole upload with a
  // bare invalidPublishAt *after* the bytes have already gone up.
  let publishAt: string | undefined;
  if (typeof body.publishAt === "string" && body.publishAt.trim() !== "") {
    const when = new Date(body.publishAt);
    if (Number.isNaN(when.getTime())) {
      ctx.json(res, 400, { error: `publishAt is not a valid date: ${body.publishAt}` });
      return;
    }
    if (when.getTime() <= Date.now()) {
      ctx.json(res, 400, { error: "publishAt must be in the future" });
      return;
    }
    publishAt = when.toISOString();
  }

  const kind = body.kind === "short" ? "short" : "video";
  const begun = await beginUpload(matchId, {
    kind,
    privacyStatus,
    publishAt,
    videoPath:
      typeof body.videoPath === "string" && body.videoPath.trim() !== "" ? body.videoPath : undefined,
    // The Short follows the long-form by itself (src/youtubeUpload.ts `shortAfterUpload`); its
    // line lands in this upload's progress, which is what the panel polls.
    thenShort: kind === "video",
  });
  if ("error" in begun) {
    ctx.json(res, begun.status, { error: begun.error });
    return;
  }
  // Answer immediately: a multi-GB upload outlives any sensible request timeout, so the browser
  // polls GET /api/youtube/upload/:id for the bar.
  ctx.json(res, 202, { matchId, kind: begun.progress.kind, started: true });
}

/**
 * Sums impressions and keeps CTR *undivided*, so the result can be summed again at a higher
 * level (per-video rows into a per-variant group) before anyone divides.
 *
 * CTR is a per-day rate: averaging days equally would let a quiet day outvote a busy one.
 */
export function totalReach(rows: ImpressionsRow[]): { impressions: number; weightedCtr: number } {
  return rows.reduce(
    (acc, r) => ({
      impressions: acc.impressions + r.impressions,
      weightedCtr: acc.weightedCtr + r.ctr * r.impressions,
    }),
    { impressions: 0, weightedCtr: 0 },
  );
}

/**
 * One video's impressions and click-through, or null.
 *
 * Best-effort: the audit is more useful knowing the video underperformed, but a Reporting job
 * that has not produced a row yet must not stop the audit from running.
 */
async function reachFor(videoId: string): Promise<{ impressions: number; ctr: number } | null> {
  try {
    const rows = (await latestImpressions(config.youtubeReportingJobId)).filter((r) => r.videoId === videoId);
    if (rows.length === 0) return null;
    const { impressions, weightedCtr } = totalReach(rows);
    return { impressions, ctr: impressions > 0 ? weightedCtr / impressions : 0 };
  } catch {
    return null;
  }
}

/**
 * Uploaded matches with their live stats, or the record alone when YouTube is unreachable.
 *
 * Two sources, because only one of them is written here. A match uploaded through Studio — every
 * upload while the API audit is pending — has no youtube.json; what it has is the match link in
 * its description, which is enough to pair it with the directory it came from
 * (src/channelUploads.ts). Without those the panel offered an upload form for videos already on
 * the channel.
 */
async function knownUploads() {
  const channel = channelUploadsSnapshot();
  const local = (await allUploads()).map((r) => ({
    matchId: r.matchId,
    ...r.record,
    // Records written before Studio uploads were persisted carry no source and were the dashboard's.
    source: r.record.source ?? ("dashboard" as const),
    // The tag gap is the same question whichever way the video got there — a record only means
    // the pairing was persisted, not that the tags were pasted.
    missingTags: missingTagsFor(r.matchId, channelVideoFor(r.matchId, channel)),
    inSeasonPlaylist: channelVideoFor(r.matchId, channel)?.inSeasonPlaylist ?? null,
  }));
  const known = new Set(local.map((u) => u.matchId));
  const studio = listProcessedMatchIds()
    .filter((matchId) => !known.has(matchId))
    .map((matchId) => ({ matchId, video: channelVideoFor(matchId, channel) }))
    .filter((e): e is { matchId: number; video: ChannelVideo } => e.video !== null)
    .map(({ matchId, video }) => ({
      matchId,
      videoId: video.videoId,
      title: video.title,
      publishedAt: video.publishedAt,
      privacyStatus: video.privacyStatus,
      source: "channel" as const,
      missingTags: missingTagsFor(matchId, video),
      inSeasonPlaylist: video.inSeasonPlaylist ?? null,
    }));
  return [...local, ...studio];
}

/**
 * The tags the pipeline generated for this match that the video on the channel does not carry.
 *
 * A Studio upload only has what was typed into the tag box, and every video on this channel has
 * the same four generic ones — while `match-<id>.tags.txt` holds eleven, both nicknames and the
 * seed among them, which are the terms somebody actually searches. The kit has had a Copy button
 * for them all along; nothing ever said when it had not been used.
 *
 * Null when there is nothing to compare: no tag file, or a scan that predates recording them.
 */
function missingTagsFor(matchId: number, video: ChannelVideo | null): string[] | null {
  if (!video || video.tags === undefined) return null;
  let generated: string[];
  try {
    generated = readFileSync(path.join(matchDir(matchId), `match-${matchId}.tags.txt`), "utf8")
      .split("\n")
      .map((t: string) => t.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
  if (generated.length === 0) return null;
  const have = new Set(video.tags.map((t) => t.toLowerCase()));
  return generated.filter((t) => !have.has(t.toLowerCase()));
}

async function uploadsPayload() {
  const uploads = await knownUploads();
  if (uploads.length === 0) return { uploads: [], statsError: null };

  try {
    const stats = await videoStats(uploads.map((u) => u.videoId));
    const byId = new Map(stats.map((s) => [s.videoId, s]));
    return {
      uploads: uploads.map((u) => ({ ...u, stats: byId.get(u.videoId) ?? null })),
      statsError: null,
    };
  } catch (err) {
    // The local record is still worth showing when the API is down — it is what tells you a
    // match was already published, which is the question you actually need answered.
    return {
      uploads: uploads.map((u) => ({ ...u, stats: null })),
      statsError: describeError(err),
    };
  }
}

/** One text-vs-no-text bucket. `hook: null` is "no manifest said", not "no". */
interface HookGroup {
  hook: boolean | null;
  videos: number;
  impressions: number;
  ctr: number | null;
}

/**
 * The comparison the hook change was made to answer: thumbnails with the headline against the
 * text-free control, pooled across every pose.
 *
 * Videos whose manifest or variant is gone group under `hook: null` rather than being guessed
 * into a side — a guess here moves impressions onto whichever answer the table is meant to
 * produce. Empty buckets are dropped so the client renders what exists.
 *
 * CTR stays impression-weighted (`totalReach`): averaging per-video percentages would let a
 * 40-impression upload outvote a 40,000-impression one.
 */
export function groupByHook(
  entries: { hook: boolean | null; reach: { impressions: number; weightedCtr: number } | null }[],
): HookGroup[] {
  const buckets: (boolean | null)[] = [true, false, null];
  return buckets
    .map((hook) => {
      const mine = entries.filter((e) => e.hook === hook);
      const impressions = mine.reduce((n, e) => n + (e.reach?.impressions ?? 0), 0);
      const weighted = mine.reduce((n, e) => n + (e.reach?.weightedCtr ?? 0), 0);
      return {
        hook,
        videos: mine.length,
        impressions,
        ctr: impressions > 0 ? weighted / impressions : null,
      };
    })
    .filter((g) => g.videos > 0);
}

/**
 * CTR grouped by thumbnail variant.
 *
 * Deliberately reports the sample size rather than declaring a winner: with four uploads the
 * difference between two poses is noise, and a table naming a "best pose" from n=2 would be
 * worse than no table. It also flags variants whose avatars fell back to NMSR, since those are
 * the same image under different pose names and cannot be compared at all.
 */
async function abTestPayload() {
  // The same union the YouTube panel shows: a Studio upload counts here too, or the tab says
  // "Nothing uploaded yet" over a channel with seven videos on it.
  const uploads = await knownUploads();
  if (uploads.length === 0)
    return { rows: [], byHook: [], note: "Nothing uploaded yet.", impressionsError: null };

  let impressions: ImpressionsRow[] = [];
  let impressionsError: string | null = null;
  try {
    impressions = await latestImpressions(config.youtubeReportingJobId);
  } catch (err) {
    impressionsError = describeError(err);
  }

  const rowsByVideo = new Map<string, ImpressionsRow[]>();
  for (const row of impressions) {
    rowsByVideo.set(row.videoId, [...(rowsByVideo.get(row.videoId) ?? []), row]);
  }
  const byVideo = new Map([...rowsByVideo].map(([videoId, rows]) => [videoId, totalReach(rows)]));

  const groups = new Map<
    string,
    { videos: number; impressions: number; weightedCtr: number; fellBack: boolean }
  >();
  const hookEntries: { hook: boolean | null; reach: { impressions: number; weightedCtr: number } | null }[] =
    [];
  for (const u of uploads) {
    const manifest = await readManifest(matchDir(u.matchId));
    // A dashboard upload recorded which variant it sent; a Studio upload did not, and the
    // manifest's `chosen` is the one the dashboard handed over to be uploaded.
    const variantKey = u.source === "channel" ? (manifest?.chosen ?? undefined) : u.thumbnailVariant;
    const key = variantKey ?? "(unknown)";
    const variant = manifest?.variants.find((v) => v.key === variantKey);
    const fellBack = variant ? variantFellBack(variant) : false;

    hookEntries.push({ hook: variant?.hook ?? null, reach: byVideo.get(u.videoId) ?? null });

    const acc = groups.get(key) ?? { videos: 0, impressions: 0, weightedCtr: 0, fellBack: false };
    acc.videos += 1;
    acc.fellBack = acc.fellBack || fellBack;
    const v = byVideo.get(u.videoId);
    if (v) {
      acc.impressions += v.impressions;
      acc.weightedCtr += v.weightedCtr;
    }
    groups.set(key, acc);
  }

  const rows = [...groups.entries()]
    .map(([variant, g]) => ({
      variant,
      videos: g.videos,
      impressions: g.impressions,
      ctr: g.impressions > 0 ? g.weightedCtr / g.impressions : null,
      fellBack: g.fellBack,
    }))
    .sort((a, b) => (b.ctr ?? -1) - (a.ctr ?? -1));

  const withData = rows.filter((r) => r.ctr !== null).length;
  const note =
    impressions.length === 0
      ? "No Reporting API rows yet — reports land about 48h after the day they cover."
      : // The text-vs-no-text question cannot resolve without one of each published, and it never
        // has been: every video so far used the hook: false control or a variant whose headline
        // was empty. Waiting for data would be waiting forever, so say which arm is missing.
        hookEntries.length > 0 && hookEntries.every((e) => e.hook !== true)
        ? "No thumbnail with a headline has been published yet, so text-vs-no-text has nothing to compare — choose a hooked variant on one upload to start the arm."
        : withData < 2
          ? "Not enough data to compare variants yet."
          : rows.some((r) => r.fellBack)
            ? "Some variants fell back to the static NMSR render, so their pose names are not distinct images."
            : null;

  return { rows, byHook: groupByHook(hookEntries), note, impressionsError };
}
