// The Thumbnail panel's routes and the bulk re-render: refusals, the one-per-video list, and
// that the bulk skips a busy match and waits out a pipeline run. No render, no network, no
// /media. Run: npx tsx src/dashboard/thumbnailRoutes.test.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
import { busyIn } from "./busy.js";
import { onChannelNow } from "./matchShelf.js";
import { startRerender } from "../thumbnails/rerender.js";
import { _setChannelUploadsForTest } from "../youtube/channelUploads.js";
import { onVideo, writeUpload } from "../youtube/youtubeStore.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-thumbroutes-test-"));
const saved = { mediaDir: config.mediaDir, token: process.env.YOUTUBE_TOKEN_FILE };
config.mediaDir = media;
process.env.YOUTUBE_TOKEN_FILE = path.join(media, "no-token.json");
// The channel list, when a test reaches for it, fails to load: never the network.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("no network in this test");
}) as typeof fetch;

let busy: Record<number, string> = {};
let sent = "{}";
const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
const ctx: ThumbnailRouteContext = {
  json: (_res, status, body) => void answers.push({ status, body: body as Record<string, unknown> }),
  readBody: async () => sent,
  matchDir,
  parseId: (raw) => (raw && /^\d+$/.test(raw) ? Number(raw) : null),
  // The server's own guard under anything a check names.
  busy: (id) => busy[id] ?? busyIn(id),
  pipelineRunning: () => false,
};
const call = async (method: string, url: string, body = "{}") => {
  sent = body;
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
  await writeFile(process.env.YOUTUBE_TOKEN_FILE!, "{}");
  // A Finish, an upload or a re-render on the match refuses the press; so does a body naming no tile.
  assert.equal((await call("POST", "/api/thumbnails/20/youtube")).status, 409);
  busy = {};
  let finished!: () => void;
  const finish = onVideo(20, () => new Promise<void>((r) => (finished = r)));
  // The server's guard (busyIn) knows a Finish or a Put, for the swap, a re-render, the bulk and Delete.
  const duringFinish = await call("POST", "/api/thumbnails/20/youtube");
  assert.equal(duringFinish.status, 409);
  assert.match(String(duringFinish.body.error), /a Finish or Put on YouTube in flight/);
  const rerenderDuringFinish = await call("POST", "/api/thumbnails/20/rerender");
  assert.equal(rerenderDuringFinish.status, 409);
  assert.match(String(rerenderDuringFinish.body.error), /a Finish or Put on YouTube in flight/);
  finished();
  await finish;
  assert.equal((await call("POST", "/api/thumbnails/20/youtube")).status, 400);

  // The new set beside the live one, and what the line may say about the video.
  const newManifest = path.join(media, "20", "thumbnail-new", "thumbnail.json");
  await mkdir(path.dirname(newManifest));
  await writeFile(newManifest, JSON.stringify({ chosen: "w-c", variants: [{ key: "w-c", file: "t.png" }] }));
  const at = "2026-09-26T10:00:00Z";
  await writeUpload(20, {
    ...record("rankedVid01"),
    thumbnailSet: { variant: "w-c", at, from: "thumbnail-new" },
  });
  const panel = async (drawnAt: string, undoCopyOf: string) => {
    await utimes(newManifest, new Date(), new Date(drawnAt));
    await writeFile(path.join(media, "20", `thumbnail-youtube-${undoCopyOf}.jpg`), "x");
    const body = (await call("GET", "/api/thumbnails/20")).body;
    return body as {
      newVariants: Array<{ key: string }>;
      youtube: { canUndo: boolean; redrawnSince: boolean };
    };
  };
  let p = await panel("2026-09-26T09:00:00Z", "otherVid001");
  assert.deepEqual(
    p.newVariants.map((v) => v.key),
    ["w-c"],
  );
  assert.equal(p.youtube.redrawnSince, false, "the tile is the drawing that was sent");
  assert.equal(p.youtube.canUndo, false, "another video's undo copy is not this one's");
  p = await panel("2026-09-26T11:00:00Z", "rankedVid01");
  assert.equal(p.youtube.redrawnSince, true, "drawn again after the put: YouTube has the earlier drawing");
  assert.equal(p.youtube.canUndo, true);
  assert.equal((await call("GET", "/api/thumbnails/30")).body.newVariants, null);

  // "Use this" on a new tile: only for a match known not to be on the channel. Until the channel
  // list has loaded once, a Studio upload the scan has not recorded looks like one that is not up —
  // so neither press is offered (onChannel null) and Use this refuses.
  const newDir30 = path.join(media, "30", "thumbnail-new");
  await mkdir(newDir30);
  await writeFile(path.join(newDir30, "thumbnail.w-c.png"), "new still");
  await writeFile(
    path.join(newDir30, "thumbnail.json"),
    JSON.stringify({
      chosen: "w-c",
      chosenBy: "auto",
      variants: [{ key: "w-c", file: "thumbnail.w-c.png" }],
    }),
  );
  const use = (id: number) => call("POST", `/api/thumbnails/${id}/use`, JSON.stringify({ chosen: "w-c" }));
  assert.equal((await call("GET", "/api/thumbnails/30")).body.onChannel, null, "not known yet");
  const unknown = await use(30);
  assert.equal(unknown.status, 409);
  assert.match(String(unknown.body.error), /checking the channel/);
  // The list read once (awaited, not fire-and-forget): a Studio upload it names is on the channel.
  await writeFile(
    process.env.YOUTUBE_TOKEN_FILE!,
    JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
  );
  const answer = (url: string) =>
    url.includes("oauth2")
      ? { access_token: "t", expires_in: 3600 }
      : url.includes("/channels?")
        ? { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] }
        : url.includes("/playlistItems?")
          ? { items: [{ contentDetails: { videoId: "studio00031" } }] }
          : {
              items: [
                {
                  id: "studio00031",
                  snippet: {
                    title: "t",
                    publishedAt: "2026-09-20T19:00:00Z",
                    description: "https://mcsrranked.com/matches/31",
                  },
                  status: { privacyStatus: "public" },
                  contentDetails: { duration: "PT10M" },
                },
              ],
            };
  globalThis.fetch = (async (input: string | URL | Request) =>
    Response.json(answer(String(input)))) as typeof fetch;
  // (No folder for 31: the pairing a first read records, and the NAS copy it starts, stay out of this test.)
  assert.equal(await onChannelNow(31), true, "a Studio upload, known on first sight");
  _setChannelUploadsForTest([]);
  assert.equal((await call("GET", "/api/thumbnails/30")).body.onChannel, false);
  const onChannel = await use(20);
  assert.equal(onChannel.status, 409, "a match on the channel takes Put on YouTube, never Use this");
  assert.match(String(onChannel.body.error), /on the channel/);
  busy = { 30: "an upload" };
  assert.equal((await use(30)).status, 409, "not while anything else writes into the folder");
  busy = {};
  const promoted = await use(30);
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.deepEqual([promoted.body.chosen, promoted.body.chosenBy], ["w-c", "operator"]);
  const after30 = (await call("GET", "/api/thumbnails/30")).body;
  assert.deepEqual([after30.newVariants, after30.chosen, after30.hasLive], [null, "w-c", true]);

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

  // A re-render that hangs (a Chromium that never answers, or a bundle that never finishes and so
  // never reaches the still the signal cancels) is ended, and the job says so — otherwise it holds
  // the bulk and every scheduled nightly behind it for ever.
  const hung = startRerender(40, (() => new Promise(() => {})) as never, 50);
  // AbortSignal.timeout's timer is unref'd (the server keeps the loop alive); this test must.
  const alive = setTimeout(() => {}, 5_000);
  assert.match(String(await hung.finished), /^stopped after \d+ min$/);
  clearTimeout(alive);

  console.log("thumbnailRoutes: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = saved.mediaDir;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  await rm(media, { recursive: true, force: true });
}
