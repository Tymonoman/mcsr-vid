/**
 * The Thumbnail panel's endpoints: the variants, "Re-render thumbnails" (one match
 * or every uploaded long-form, render only), and "Put on YouTube" / "Undo on YouTube" for a tile of
 * the new set. Transport and a job table; the work is src/thumbnails/rerender.ts and
 * src/youtube/thumbnailSwap.ts.
 *
 * Its own job map, like shortsRoutes.ts: a re-render and a pipeline run on the same match must not
 * share jobs.ts's one-per-match slot.
 */
import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describeError } from "../errorText.js";
import { readManifest } from "../thumbnails/thumbnailVariants.js";
import { NEW_DIR, rerenderThumbnails } from "../thumbnails/rerender.js";
import { isConfigured } from "../youtube/youtube.js";
import { swapThumbnail, SwapRefused, undoFile } from "../youtube/thumbnailSwap.js";
import { allUploads, longFormRecord, videoWriting } from "../youtube/youtubeStore.js";
import { isExported, isUploaded } from "./matchShelf.js";

export interface ThumbnailRouteContext {
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
  matchDir: (matchId: number) => string;
  parseId: (raw: string | undefined) => number | null;
  /** What else is writing into the match directory, in words, or null (server.ts, Delete's guard). */
  busy: (matchId: number) => string | null;
  /** A pipeline run anywhere on the box — the nightly's included. The bulk waits it out. */
  pipelineRunning: () => boolean;
}

interface ThumbJob {
  matchId: number;
  line: string;
  since: string;
  percent?: number;
  done: boolean;
  error: string | null;
  finished: Promise<string | null>;
}

const jobs = new Map<number, ThumbJob>();

/** A re-render writing this match's thumbnails right now. */
export const thumbnailRunning = (matchId: number): boolean => jobs.get(matchId)?.done === false;

/** Any re-render in flight: the scheduled nightly waits it out before it starts (nightly.ts). */
export const anyThumbnailRunning = (): boolean => [...jobs.values()].some((j) => !j.done);

type Rerender = typeof rerenderThumbnails;

/**
 * Four stills take a minute or two; one still drawing after this is hung (a Chromium that never
 * answers), and it would hold the bulk and the nightly behind it for ever. The signal cancels the
 * still render (`renderStill`); the API reads, avatar fetches and bundling before it are not cut short.
 */
export const RERENDER_TIMEOUT_MS = 15 * 60_000;

export function startRerender(
  matchId: number,
  rerender: Rerender = rerenderThumbnails,
  timeoutMs = RERENDER_TIMEOUT_MS,
): ThumbJob {
  const existing = jobs.get(matchId);
  if (existing && !existing.done) return existing;
  let settle!: (error: string | null) => void;
  const job: ThumbJob = {
    matchId,
    line: "reading the match",
    since: new Date().toISOString(),
    done: false,
    error: null,
    finished: new Promise((resolve) => (settle = resolve)),
  };
  jobs.set(matchId, job);
  const signal = AbortSignal.timeout(timeoutMs);
  rerender(matchId, {
    onProgress: (p) => {
      job.line = p.phase === "bundling" ? "bundling the compositions" : "rendering the variants";
      job.percent = p.percent;
    },
    signal,
  })
    .then(() => settle(null))
    .catch((err: unknown) =>
      settle(signal.aborted ? `stopped after ${Math.round(timeoutMs / 60_000)} min` : describeError(err)),
    );
  void job.finished.then((error) => {
    job.done = true;
    job.error = error;
    job.line = error ? "failed" : "done";
    if (error) console.error(`thumbnails ${matchId}: ${error}`);
  });
  return job;
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
  rerender: Rerender = rerenderThumbnails,
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
  [...jobs.values()]
    .filter((j) => !j.done)
    .map((j) => ({
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
    const job = jobs.get(matchId);
    const record = await longFormRecord(matchId);
    const newManifest = path.join(dir, NEW_DIR, "thumbnail.json");
    const set = record?.thumbnailSet ?? null;
    const onChannel = await isUploaded(matchId);
    ctx.json(res, 200, {
      ...(manifest ?? { chosen: null, hookText: null, variants: [] }),
      // The re-rendered set of a match on the channel (src/thumbnails/rerender.ts); null until one lands.
      newVariants: (await readManifest(path.join(dir, NEW_DIR)))?.variants ?? null,
      // Where a re-render lands: beside the live set (on the channel) or over it (src/thumbnails/rerender.ts).
      onChannel,
      // A match with an export, a manifest or a video can be drawn again; a bare directory has nothing to show it on.
      canRerender: existsSync(dir) && (manifest !== null || isExported(matchId) || onChannel),
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

  // One press, one live-channel change: `{ variant }` puts that new tile on, `{ undo: true }` puts
  // back the image kept before the first put.
  if (action === "youtube" && req.method === "POST") {
    if (!isConfigured()) {
      ctx.json(res, 503, { error: "YouTube is not connected on this box" });
      return true;
    }
    // An upload or a re-render (ctx.busy), or a Finish on YouTube, which sets the thumbnail too.
    const busy = ctx.busy(matchId) ?? (videoWriting(matchId) ? "a Finish on YouTube" : null);
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
