/**
 * The dashboard's YouTube endpoints.
 *
 * Split from server.ts purely for size — that file is already at the 500-line cap — and it
 * keeps the same rule: transport only. Anything resembling a decision belongs in youtube.ts
 * (the API) or youtubeStore.ts (what we recorded about a match).
 */
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { auditState, readAudit, startAudit } from "./audit.js";
import { config } from "./config.js";
import { describeError } from "./errorText.js";
import { matchStatusFor } from "./matchStatus.js";
import { readManifest } from "./thumbnailVariants.js";
import {
  commentThreads,
  isConfigured,
  latestImpressions,
  replyToComment,
  setThumbnail,
  uploadVideo,
  videoStats,
  type ImpressionsRow,
} from "./youtube.js";
import { allUploads, findExportedVideo, readUpload, writeUpload, type UploadRecord } from "./youtubeStore.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage) => Promise<string>;

export interface YoutubeRouteContext {
  json: Json;
  readBody: ReadBody;
  matchDir: (matchId: number) => string;
  parseId: (raw: string | undefined) => number | null;
}

/** An upload in flight, so the browser can show a byte-level bar on a multi-GB file. */
interface UploadProgress {
  matchId: number;
  uploaded: number;
  total: number;
  done: boolean;
  error: string | null;
  videoId: string | null;
}

const uploads = new Map<number, UploadProgress>();

const idle = (matchId: number): UploadProgress => ({
  matchId,
  uploaded: 0,
  total: 0,
  done: false,
  error: null,
  videoId: null,
});

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
    ctx.json(res, 200, { connected: isConfigured(), channelId: config.youtubeChannelId });
    return true;
  }

  if (action === "uploads" && req.method === "GET") {
    ctx.json(res, 200, await uploadsPayload());
    return true;
  }

  if (action === "abtest" && req.method === "GET") {
    ctx.json(res, 200, await abTestPayload());
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
    ctx.json(res, 200, uploads.get(matchId) ?? idle(matchId));
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
  const running = uploads.get(matchId);
  if (running && !running.done) {
    ctx.json(res, 409, { error: `Match ${matchId} is already uploading`, progress: running });
    return;
  }

  const body = JSON.parse(await ctx.readBody(req)) as {
    title?: unknown;
    description?: unknown;
    tags?: unknown;
    privacyStatus?: unknown;
    publishAt?: unknown;
    videoPath?: unknown;
  };
  if (typeof body.title !== "string" || body.title.trim() === "") {
    ctx.json(res, 400, { error: "title is required" });
    return;
  }
  if (typeof body.description !== "string") {
    ctx.json(res, 400, { error: "description is required" });
    return;
  }
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

  const status = await matchStatusFor(matchId);
  const located =
    typeof body.videoPath === "string" && body.videoPath.trim() !== ""
      ? { path: body.videoPath }
      : findExportedVideo(matchId, [status.leftNickname, status.rightNickname]);
  if ("error" in located) {
    ctx.json(res, 400, { error: located.error });
    return;
  }
  if (!existsSync(located.path)) {
    ctx.json(res, 400, { error: `No such video file: ${located.path}` });
    return;
  }

  const manifest = await readManifest(ctx.matchDir(matchId));
  const progress = idle(matchId);
  uploads.set(matchId, progress);

  // Answer immediately: a multi-GB upload outlives any sensible request timeout, so the browser
  // polls GET /api/youtube/upload/:id for the bar.
  ctx.json(res, 202, { matchId, started: true, videoPath: located.path });

  void (async () => {
    try {
      const result = await uploadVideo({
        filePath: located.path,
        title: body.title as string,
        description: body.description as string,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
        privacyStatus,
        publishAt,
        onProgress: (uploaded, total) => {
          progress.uploaded = uploaded;
          progress.total = total;
        },
      });
      progress.videoId = result.videoId;

      // Set the thumbnail after the video exists. Failing here is worth reporting but not worth
      // pretending the upload failed — the video is up, it just has YouTube's auto-thumbnail.
      const thumb = path.join(ctx.matchDir(matchId), "thumbnail.png");
      if (existsSync(thumb)) {
        try {
          await setThumbnail(result.videoId, thumb);
        } catch (err) {
          progress.error = `Uploaded, but the thumbnail was rejected: ${describeError(err)}`;
        }
      }

      const record: UploadRecord = {
        videoId: result.videoId,
        uploadedAt: new Date().toISOString(),
        publishAt: result.publishAt,
        privacyStatus: result.privacyStatus,
        thumbnailVariant: manifest?.chosen ?? null,
        title: body.title as string,
      };
      await writeUpload(matchId, record);
    } catch (err) {
      progress.error = describeError(err);
    } finally {
      progress.done = true;
    }
  })();
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

/** Uploaded matches with their live stats, or the record alone when YouTube is unreachable. */
async function uploadsPayload() {
  const records = await allUploads();
  if (records.length === 0) return { uploads: [], statsError: null };

  try {
    const stats = await videoStats(records.map((r) => r.record.videoId));
    const byId = new Map(stats.map((s) => [s.videoId, s]));
    return {
      uploads: records.map((r) => ({
        matchId: r.matchId,
        ...r.record,
        stats: byId.get(r.record.videoId) ?? null,
      })),
      statsError: null,
    };
  } catch (err) {
    // The local record is still worth showing when the API is down — it is what tells you a
    // match was already published, which is the question you actually need answered.
    return {
      uploads: records.map((r) => ({ matchId: r.matchId, ...r.record, stats: null })),
      statsError: describeError(err),
    };
  }
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
  const records = await allUploads();
  if (records.length === 0) return { rows: [], note: "Nothing uploaded yet.", impressionsError: null };

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
  for (const { matchId, record } of records) {
    const key = record.thumbnailVariant ?? "(unknown)";
    const manifest = await readManifest(path.join(config.mediaDir, String(matchId)));
    const variant = manifest?.variants.find((v) => v.key === record.thumbnailVariant);
    const fellBack = variant
      ? variant.leftProvider !== "starlight" || variant.rightProvider !== "starlight"
      : false;

    const acc = groups.get(key) ?? { videos: 0, impressions: 0, weightedCtr: 0, fellBack: false };
    acc.videos += 1;
    acc.fellBack = acc.fellBack || fellBack;
    const v = byVideo.get(record.videoId);
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
      : withData < 2
        ? "Not enough data to compare variants yet."
        : rows.some((r) => r.fellBack)
          ? "Some variants fell back to the static NMSR render, so their pose names are not distinct images."
          : null;

  return { rows, note, impressionsError };
}
