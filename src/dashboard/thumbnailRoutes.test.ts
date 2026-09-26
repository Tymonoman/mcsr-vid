// The Thumbnail panel's routes and the bulk re-render: refusals, the one-per-video list, and
// that the bulk skips a busy match and waits out a pipeline run. No render, no network, no
// /media. Run: npx tsx src/dashboard/thumbnailRoutes.test.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, matchDir } from "../config.js";
import {
  handleThumbnailRoute,
  runBulk,
  uploadedLongForms,
  type ThumbnailRouteContext,
} from "./thumbnailRoutes.js";
import { writeUpload } from "../youtube/youtubeStore.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-thumbroutes-test-"));
const saved = { mediaDir: config.mediaDir, token: process.env.YOUTUBE_TOKEN_FILE };
config.mediaDir = media;
process.env.YOUTUBE_TOKEN_FILE = path.join(media, "no-token.json");

let busy: Record<number, string> = {};
const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
const ctx: ThumbnailRouteContext = {
  json: (_res, status, body) => void answers.push({ status, body: body as Record<string, unknown> }),
  readBody: async () => "{}",
  matchDir,
  parseId: (raw) => (raw && /^\d+$/.test(raw) ? Number(raw) : null),
  busy: (id) => busy[id] ?? null,
  pipelineRunning: () => false,
};
const call = async (method: string, url: string) => {
  const handled = await handleThumbnailRoute(
    { method } as IncomingMessage,
    {} as ServerResponse,
    url.split("/").filter(Boolean),
    ctx,
  );
  assert.ok(handled, `${method} ${url} is the thumbnail group's`);
  return answers.at(-1)!;
};

try {
  const record = (videoId: string) => ({
    videoId,
    uploadedAt: "2026-09-20T19:00:00Z",
    publishAt: null,
    privacyStatus: "public",
    thumbnailVariant: null,
    title: "t",
  });
  for (const id of [10, 11, 12, 20, 30]) await mkdir(path.join(media, String(id)));
  // A series: games 10..12 all carry game 1's video; 20 is a ranked match; 30 was never uploaded.
  for (const id of [10, 11, 12]) await writeUpload(id, record("seriesVid01"));
  await writeUpload(20, record("rankedVid01"));
  assert.deepEqual(await uploadedLongForms(), [10, 20], "each long-form once, the series by game 1");

  // The panel: a bare directory with nothing to show offers no re-render; an uploaded one does,
  // and game 2 of a series has no video of its own to swap.
  assert.equal((await call("GET", "/api/thumbnails/30")).body.canRerender, false);
  const g1 = (await call("GET", "/api/thumbnails/10")).body;
  assert.equal(g1.canRerender, true);
  assert.equal((g1.youtube as { videoId: string }).videoId, "seriesVid01");
  assert.equal((await call("GET", "/api/thumbnails/11")).body.youtube, null);

  // Refusals: anything else writing into the directory, a match with no directory, no YouTube.
  busy = { 20: "an export" };
  const refused = await call("POST", "/api/thumbnails/20/rerender");
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /an export in flight/);
  assert.equal((await call("POST", "/api/thumbnails/99/rerender")).status, 404);
  assert.equal(
    (await call("POST", "/api/thumbnails/20/youtube")).status,
    503,
    "not connected: nothing is sent",
  );

  // The bulk: one at a time, a busy match skipped, a failure recorded, the rest carried on —
  // and nothing starts while a pipeline run (the nightly's) is in flight.
  let pipeline = 2;
  const order: number[] = [];
  const run = await runBulk(
    [10, 20, 30],
    { busy: (id) => (id === 20 ? "an export" : null), pipelineRunning: () => pipeline-- > 0 },
    (async (id: number) => {
      assert.equal(pipeline < 0, true, "no re-render beside a pipeline run");
      order.push(id);
      if (id === 30) throw new Error("no players");
      return { chosen: "a", variants: [], hookText: null };
    }) as never,
    1,
  );
  assert.deepEqual(order, [10, 30]);
  assert.deepEqual(run.skipped, [{ matchId: 20, why: "an export" }]);
  assert.deepEqual(run.failed, [{ matchId: 30, error: "no players" }]);
  assert.equal(run.running, false);
  const state = (await call("GET", "/api/thumbnails/all/rerender")).body.bulk as {
    done: number;
    total: number;
  };
  assert.deepEqual([state.done, state.total], [3, 3]);

  console.log("thumbnailRoutes: all checks passed");
} finally {
  config.mediaDir = saved.mediaDir;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  await rm(media, { recursive: true, force: true });
}
