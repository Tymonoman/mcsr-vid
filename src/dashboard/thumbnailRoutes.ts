/**
 * The Thumbnail panel's endpoints: the variants and the choice, "Re-render thumbnails" (one match
 * or every uploaded long-form, render only), and the per-video swap on YouTube. Transport and a
 * job table; the work is src/thumbnails/rerender.ts and src/youtube/thumbnailSwap.ts.
 *
 * Its own job map, like shortsRoutes.ts: a re-render and a pipeline run on the same match must not
 * share jobs.ts's one-per-match slot.
 */
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describeError } from "../errorText.js";
import { chooseVariant, readManifest } from "../thumbnails/thumbnailVariants.js";
import { rerenderThumbnails } from "../thumbnails/rerender.js";
import { isConfigured } from "../youtube/youtube.js";
import { longFormRecord, swapThumbnail, SwapRefused, YOUTUBE_PREV_FILE } from "../youtube/thumbnailSwap.js";
import { allUploads } from "../youtube/youtubeStore.js";
import { isExported } from "./matchShelf.js";

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

export function startRerender(matchId: number, rerender: Rerender = rerenderThumbnails): ThumbJob {
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
  rerender(matchId, {
    onProgress: (p) => {
      job.line = p.phase === "bundling" ? "bundling the compositions" : "rendering the variants";
      job.percent = p.percent;
    },
  })
    .then(() => settle(null))
    .catch((err: unknown) => settle(describeError(err)));
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
  startedAt: string;
}
let bulk: Bulk | null = null;

/** Each long-form once: a series' games 2..n carry game 1's video id, and game 1 (the lowest id) owns it. */
export async function uploadedLongForms(): Promise<number[]> {
  const owners = new Map<string, number>();
  for (const { matchId, record } of await allUploads()) {
    const was = owners.get(record.videoId);
    if (was === undefined || matchId < was) owners.set(record.videoId, matchId);
  }
  return [...owners.values()].sort((a, b) => a - b);
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
    startedAt: new Date().toISOString(),
  };
  bulk = run;
  try {
    for (; run.index < ids.length; run.index++) {
      const matchId = ids[run.index]!;
      // Never beside a render: stills and an overlay render share the lab's four cores and the one
      // Remotion bundle. The nightly renders through the same job table, so this waits for it too.
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

const bulkState = () =>
  bulk && {
    total: bulk.ids.length,
    done: bulk.index,
    running: bulk.running,
    failed: bulk.failed,
    skipped: bulk.skipped,
    startedAt: bulk.startedAt,
  };

/** The strip's activity line: each running re-render, the bulk's count on it. */
export function thumbnailActivities(): Array<{
  matchId: number;
  step: "thumbnails";
  line: string;
  since: string;
  percent?: number;
}> {
  return [...jobs.values()]
    .filter((j) => !j.done)
    .map((j) => ({
      matchId: j.matchId,
      step: "thumbnails" as const,
      line:
        bulk?.running && bulk.ids[bulk.index] === j.matchId
          ? `${j.line} · ${bulk.index + 1} of ${bulk.ids.length}`
          : j.line,
      since: j.since,
      ...(j.percent !== undefined ? { percent: j.percent } : {}),
    }));
}

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
    ctx.json(res, 200, {
      ...(manifest ?? { chosen: null, hookText: null, variants: [] }),
      // A match with an export or a manifest can be drawn again; a bare directory has nothing to show it on.
      canRerender: existsSync(dir) && (manifest !== null || isExported(matchId) || record !== null),
      job: job
        ? {
            running: !job.done,
            line: job.line,
            since: job.since,
            percent: job.percent ?? null,
            error: job.error,
          }
        : null,
      youtube: record
        ? {
            videoId: record.videoId,
            title: record.title,
            set: record.thumbnailSet ?? null,
            canUndo: existsSync(path.join(dir, YOUTUBE_PREV_FILE)),
            connected: isConfigured(),
          }
        : null,
    });
    return true;
  }

  // Promote a variant to thumbnail.png, which is the file that actually gets uploaded.
  if (action === undefined && req.method === "PUT") {
    const body = JSON.parse(await ctx.readBody(req)) as { chosen?: unknown };
    if (typeof body.chosen !== "string") {
      ctx.json(res, 400, { error: 'expected { chosen: "<variant key>" }' });
      return true;
    }
    if (thumbnailRunning(matchId)) {
      ctx.json(res, 409, { error: "The thumbnails are being re-rendered — pick once they are done" });
      return true;
    }
    try {
      ctx.json(res, 200, await chooseVariant(dir, body.chosen));
    } catch (err) {
      ctx.json(res, 400, { error: describeError(err) });
    }
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

  // One press, one live-channel change: `{ undo: true }` puts back the image kept before the first swap.
  if (action === "youtube" && req.method === "POST") {
    if (!isConfigured()) {
      ctx.json(res, 503, { error: "YouTube is not connected on this box" });
      return true;
    }
    const busy = ctx.busy(matchId);
    if (busy) {
      ctx.json(res, 409, { error: `Match ${matchId} has ${busy} in flight — try again when it is done` });
      return true;
    }
    const body = JSON.parse((await ctx.readBody(req)) || "{}") as { undo?: unknown };
    try {
      ctx.json(res, 200, await swapThumbnail(matchId, body.undo === true));
    } catch (err) {
      ctx.json(res, err instanceof SwapRefused ? 409 : 502, { error: describeError(err) });
    }
    return true;
  }

  return false;
}
