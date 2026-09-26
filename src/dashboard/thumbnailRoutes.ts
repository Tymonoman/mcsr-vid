/**
 * The Thumbnail panel's endpoints: the variants, "Re-render thumbnails" (one match or every
 * uploaded long-form, render only), and for a tile of the new set "Use this" (a match not on the
 * channel) or "Put on YouTube" / "Undo on YouTube" (one on it). Transport and the bulk; the work
 * and the job table are src/thumbnails/rerender.ts and src/youtube/thumbnailSwap.ts.
 */
import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describeError } from "../errorText.js";
import { manifestPath, readManifest } from "../thumbnails/thumbnailVariants.js";
import {
  NEW_DIR,
  promoteNewSet,
  rerenderThumbnails,
  runningThumbJobs,
  startRerender,
  thumbJob,
  thumbnailRunning,
} from "../thumbnails/rerender.js";
import { isConfigured } from "../youtube/youtube.js";
import { swapThumbnail, SwapRefused, undoFile } from "../youtube/thumbnailSwap.js";
import { allUploads, longFormRecord } from "../youtube/youtubeStore.js";
import { isExported, isUploaded, onChannelNow } from "./matchShelf.js";

export interface ThumbnailRouteContext {
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
  matchDir: (matchId: number) => string;
  parseId: (raw: string | undefined) => number | null;
  /** What else is writing into the match directory, in words, or null (`busyIn`, busy.ts). */
  busy: (matchId: number) => string | null;
  /** A pipeline run anywhere on the box — the nightly's included. The bulk waits it out. */
  pipelineRunning: () => boolean;
}

/* --- Every uploaded long-form, one at a time --------------------------------------------------- */

interface Bulk {
  ids: number[];
  index: number;
  failed: Array<{ matchId: number; error: string }>;
  skipped: Array<{ matchId: number; why: string }>;
  running: boolean;
}
let bulk: Bulk | null = null;

/** Each long-form once: a series' games 2..n carry game 1's video id, and game 1 (the lowest id, listed first) owns it. */
export async function uploadedLongForms(): Promise<number[]> {
  const all = await allUploads();
  return all
    .filter((u, i) => all.findIndex((o) => o.record.videoId === u.record.videoId) === i)
    .map((u) => u.matchId);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runBulk(
  ids: number[],
  ctx: Pick<ThumbnailRouteContext, "busy" | "pipelineRunning">,
  rerender: typeof rerenderThumbnails = rerenderThumbnails,
  waitMs = 30_000,
): Promise<Bulk> {
  const run: Bulk = {
    ids,
    index: 0,
    failed: [],
    skipped: [],
    running: true,
  };
  bulk = run;
  try {
    for (; run.index < ids.length; run.index++) {
      const matchId = ids[run.index]!;
      // Never beside a pipeline run: stills and an overlay render share the lab's four cores and the
      // one Remotion bundle. The nightly renders through the same job table, so this waits for it
      // too. An export or a Short render on another match does not hold it.
      while (ctx.pipelineRunning()) await sleep(waitMs);
      const busy = ctx.busy(matchId);
      if (busy) {
        run.skipped.push({ matchId, why: busy });
        continue;
      }
      const error = await startRerender(matchId, rerender).finished;
      if (error) run.failed.push({ matchId, error });
    }
  } finally {
    run.running = false;
  }
  return run;
}

const bulkState = () => bulk && { ...bulk, total: bulk.ids.length, done: bulk.index };

/** The strip's activity line: each running re-render, the bulk's count on it. */
export const thumbnailActivities = () =>
  runningThumbJobs().map((j) => ({
    matchId: j.matchId,
    step: "thumbnails" as const,
    line:
      bulk?.running && bulk.ids[bulk.index] === j.matchId
        ? `${j.line} · ${bulk.index + 1} of ${bulk.ids.length}`
        : j.line,
    since: j.since,
    percent: j.percent,
  }));

/* --- Routes ------------------------------------------------------------------------------------ */

/** `/api/thumbnails/…`. Returns false for anything it does not own. */
export async function handleThumbnailRoute(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  ctx: ThumbnailRouteContext,
): Promise<boolean> {
  const [, resource, idRaw, action] = segments;
  if (resource !== "thumbnails") return false;

  if (idRaw === "all" && action === "rerender") {
    if (req.method === "POST") {
      if (bulk?.running) {
        ctx.json(res, 409, {
          error: "A re-render of every uploaded video is already running",
          bulk: bulkState(),
        });
        return true;
      }
      const ids = await uploadedLongForms();
      void runBulk(ids, ctx).catch((err: unknown) => console.error(`thumbnails bulk: ${describeError(err)}`));
      ctx.json(res, 202, { bulk: bulkState() });
      return true;
    }
    if (req.method === "GET") {
      ctx.json(res, 200, { bulk: bulkState(), uploaded: (await uploadedLongForms()).length });
      return true;
    }
  }

  const matchId = ctx.parseId(idRaw);
  if (matchId === null) {
    ctx.json(res, 400, { error: "match id must be digits" });
    return true;
  }
  const dir = ctx.matchDir(matchId);

  if (action === undefined && req.method === "GET") {
    const manifest = await readManifest(dir);
    const job = thumbJob(matchId);
    const record = await longFormRecord(matchId);
    const newManifest = path.join(dir, NEW_DIR, "thumbnail.json");
    const set = record?.thumbnailSet ?? null;
    // The re-rendered set (src/thumbnails/rerender.ts); null until one lands.
    const newVariants = (await readManifest(path.join(dir, NEW_DIR)))?.variants ?? null;
    // Which press a new tile gets — Put on YouTube (true) or Use this (false) — is never read off a
    // channel list that has not loaded yet: null, and the panel offers neither.
    const onChannel = newVariants ? await onChannelNow(matchId) : await isUploaded(matchId);
    ctx.json(res, 200, {
      ...(manifest ?? { chosen: null, hookText: null, variants: [] }),
      // When the live set was last written: the tiles' URLs change with it, or the browser shows a cached still.
      liveAt: manifest ? statSync(manifestPath(dir)).mtimeMs : null,
      hasLive: existsSync(path.join(dir, "thumbnail.png")),
      newVariants,
      onChannel,
      // A match with an export, a manifest or a video can be drawn again; a bare directory has nothing to show it on.
      canRerender: existsSync(dir) && (manifest !== null || isExported(matchId) || onChannel === true),
      job: job ? { ...job, running: !job.done } : null,
      youtube: record
        ? {
            videoId: record.videoId,
            title: record.title,
            set,
            // The tile it names was drawn again after the put: YouTube has the earlier drawing.
            redrawnSince:
              set?.from === NEW_DIR &&
              existsSync(newManifest) &&
              statSync(newManifest).mtimeMs > Date.parse(set.at),
            canUndo: existsSync(path.join(dir, undoFile(record.videoId))),
            connected: isConfigured(),
          }
        : null,
    });
    return true;
  }

  if (action === "rerender" && req.method === "POST") {
    if (!existsSync(dir)) {
      ctx.json(res, 404, { error: `Match ${matchId} has no directory on this box` });
      return true;
    }
    const busy = thumbnailRunning(matchId) ? null : ctx.busy(matchId);
    if (busy) {
      ctx.json(res, 409, { error: `Match ${matchId} has ${busy} in flight — the thumbnails wait for it` });
      return true;
    }
    const job = startRerender(matchId);
    ctx.json(res, 202, { matchId, running: !job.done });
    return true;
  }

  // "Use this" on a new tile of a match not on the channel: the new set becomes the live one.
  if (action === "use" && req.method === "POST") {
    const body = JSON.parse((await ctx.readBody(req)) || "{}") as { chosen?: unknown };
    if (typeof body.chosen !== "string") {
      ctx.json(res, 400, { error: 'expected { chosen: "<variant key>" }' });
      return true;
    }
    const onChannel = await onChannelNow(matchId);
    // Checked after the await, and marked by promoteNewSet before its first: nothing starts between.
    const busy = ctx.busy(matchId);
    const refused =
      onChannel === null
        ? "checking the channel — reload in a moment"
        : onChannel
          ? `Match ${matchId} is on the channel: its live set is what went up, and Put on YouTube changes the video's thumbnail`
          : busy && `Match ${matchId} has ${busy} in flight — try again when it is done`;
    if (refused) {
      ctx.json(res, 409, { error: refused });
      return true;
    }
    try {
      ctx.json(res, 200, await promoteNewSet(matchId, body.chosen));
    } catch (err) {
      ctx.json(res, 409, { error: describeError(err) });
    }
    return true;
  }

  // One press, one live-channel change: `{ variant }` puts that new tile on, `{ undo: true }` puts
  // back the image kept before the first put.
  if (action === "youtube" && req.method === "POST") {
    if (!isConfigured()) {
      ctx.json(res, 503, { error: "YouTube is not connected on this box" });
      return true;
    }
    // An upload, a re-render, or a Finish on YouTube, which sets the thumbnail too (ctx.busy).
    const busy = ctx.busy(matchId);
    if (busy) {
      ctx.json(res, 409, { error: `Match ${matchId} has ${busy} in flight — try again when it is done` });
      return true;
    }
    const body = JSON.parse((await ctx.readBody(req)) || "{}") as { undo?: unknown; variant?: unknown };
    if (body.undo !== true && typeof body.variant !== "string") {
      ctx.json(res, 400, { error: 'expected { variant: "<key>" } or { undo: true }' });
      return true;
    }
    try {
      ctx.json(
        res,
        200,
        await swapThumbnail(matchId, body.undo === true ? { undo: true } : { variant: String(body.variant) }),
      );
    } catch (err) {
      ctx.json(res, err instanceof SwapRefused ? 409 : 502, { error: describeError(err) });
    }
    return true;
  }

  return false;
}
