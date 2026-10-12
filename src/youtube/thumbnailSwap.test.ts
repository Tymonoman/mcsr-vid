// "Put on YouTube" / "Undo on YouTube" against a stubbed fetch — thumbnails.set changes the live
// channel, so nothing here reaches Google. Run: npx tsx src/youtube/thumbnailSwap.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { swapThumbnail, SwapRefused, undoFile } from "./thumbnailSwap.js";
import { onVideo, readUpload, videoWriting, writeUpload } from "./youtubeStore.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-swap-test-"));
const saved = {
  mediaDir: config.mediaDir,
  channel: config.youtubeChannelId,
  token: process.env.YOUTUBE_TOKEN_FILE,
};
const realFetch = globalThis.fetch;
config.mediaDir = media;
config.youtubeChannelId = "UCmine";
process.env.YOUTUBE_TOKEN_FILE = path.join(media, "token.json");
await writeFile(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);

let owner = "UCmine";
let imageStatus = 200;
let imageBody: string | null = null;
let hasMaxres = true;
/** What YouTube serves as each video's thumbnail now. */
const wears: Record<string, string> = { vidAAAAAAAA: "A".repeat(8000), vidBBBBBBBB: "B".repeat(8000) };
const sets: Array<{ videoId: string; type: string; body: string }> = [];
let downloads = 0;
/** Runs inside thumbnails.set: another writer touching the record while the put is on the wire. */
let duringSet: (() => Promise<void>) | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const json = (p: unknown) =>
    new Response(JSON.stringify(p), { headers: { "content-type": "application/json" } });
  if (url.startsWith("https://oauth2.googleapis.com/")) return json({ access_token: "t", expires_in: 3600 });
  if (url.includes("/videos?part=snippet&")) {
    const id = new URL(url).searchParams.get("id")!;
    const img = (name: string, width: number) => ({ url: `https://i.ytimg.com/vi/${id}/${name}.jpg`, width });
    const thumbnails = {
      high: img("hqdefault", 480),
      ...(hasMaxres ? { maxres: img("maxresdefault", 1280) } : {}),
    };
    return json({ items: [{ id, snippet: { channelId: owner, title: `Live title ${id}`, thumbnails } }] });
  }
  // hqdefault answers with a real-sized body too: the width, not the answer, has to refuse it.
  const image = /^https:\/\/i\.ytimg\.com\/vi\/(\w+)\/(maxres|hq)default\.jpg$/.exec(url);
  if (image) {
    downloads++;
    return new Response(imageStatus === 200 ? (imageBody ?? wears[image[1]!]!) : "", { status: imageStatus });
  }
  if (url.includes("/thumbnails/set?")) {
    const videoId = new URL(url).searchParams.get("videoId")!;
    const body = Buffer.from(init?.body as Uint8Array).toString();
    sets.push({ videoId, type: (init?.headers as Record<string, string>)["content-type"]!, body });
    wears[videoId] = body;
    await duringSet?.();
    return json({ kind: "youtube#thumbnailSetResponse" });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const refused = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (err: unknown) => err instanceof SwapRefused && re.test((err as Error).message));

try {
  // The live set the video went up with, and the re-rendered one beside it.
  const dir = path.join(media, "100");
  const fresh = path.join(dir, "thumbnail-new");
  await mkdir(fresh, { recursive: true });
  const live = { chosen: "walking-crossed", chosenBy: "operator", hookText: null, variants: [] };
  await writeFile(path.join(dir, "thumbnail.json"), JSON.stringify(live));
  await writeFile(path.join(dir, "thumbnail.png"), "live-png");
  const tile = { key: "cheering-relaxing", leftPose: "cheering", rightPose: "relaxing", file: "t.cr.png" };
  await writeFile(path.join(fresh, "thumbnail.json"), JSON.stringify({ chosen: tile.key, variants: [tile] }));
  await writeFile(path.join(fresh, tile.file), "new-png");
  const put = { variant: tile.key };

  await refused(swapThumbnail(100, put), /no long-form/);
  const record = {
    videoId: "vidAAAAAAAA",
    uploadedAt: "2026-09-20T19:00:00Z",
    publishAt: null,
    privacyStatus: "public",
    thumbnailVariant: "walking-crossed",
    title: "Old title",
    source: "studio" as const,
    finished: { thumbnail: "left alone — uploaded elsewhere", playlists: '"Season 11": quota' },
  };
  await writeUpload(100, record);
  // A series' game 2 carries game 1's video id; its thumbnail is not the series'.
  await mkdir(path.join(media, "101"));
  await writeUpload(101, record);
  await refused(swapThumbnail(101, put), /no long-form/);
  // Only a tile of the new set, and nothing to undo before a first put.
  await refused(swapThumbnail(100, { variant: "walking-crossed" }), /re-render the thumbnails first/);
  await refused(swapThumbnail(100, { undo: true }), /Nothing to undo/);

  // Another channel's video: refused by the read, nothing downloaded, nothing set.
  owner = "UCother";
  await assert.rejects(swapThumbnail(100, put), /belongs to channel UCother/);
  owner = "UCmine";
  // No full-size image came back (expected of a private or scheduled video): no copy to undo to,
  // so nothing is set, and the line says when to press again. Nor for an empty 200, nor for a
  // video whose largest image is the 4:3 hqdefault (not even fetched).
  imageStatus = 404;
  await refused(
    swapThumbnail(100, put),
    /no image 1280 wide and 5 KB or more came back.*nothing changed; press again once the video is public$/,
  );
  imageStatus = 200;
  imageBody = "";
  await refused(swapThumbnail(100, put), /nothing changed/);
  imageBody = null;
  hasMaxres = false;
  await refused(swapThumbnail(100, put), /nothing changed/);
  hasMaxres = true;
  assert.equal(sets.length, 0);
  assert.ok(!existsSync(path.join(dir, undoFile("vidAAAAAAAA"))));

  // The put: what the video wears kept first, then the new tile sent as PNG — while another writer
  // (the nightly's playlist retry, say) records its step. Both land: the record is read again
  // before it is written, and the ledger's thumbnail step counts as done.
  duringSet = async () => {
    const now = (await readUpload(100))!;
    await writeUpload(100, { ...now, finished: { ...now.finished, playlists: null } });
  };
  const first = await swapThumbnail(100, put);
  duringSet = null;
  assert.equal(first.title, "Live title vidAAAAAAAA");
  assert.deepEqual(first.set, { variant: tile.key, at: first.set.at, from: "thumbnail-new" });
  assert.equal(await readFile(path.join(dir, undoFile("vidAAAAAAAA")), "utf8"), "A".repeat(8000));
  assert.deepEqual(sets[0], { videoId: "vidAAAAAAAA", type: "image/png", body: "new-png" });
  let after = await readUpload(100);
  assert.deepEqual(after?.thumbnailSet, first.set);
  assert.equal(after?.finished?.playlists, null, "the other writer's step survives");
  assert.equal(after?.finished?.thumbnail, null, "a later Finish does not set the live pick over it");
  assert.equal(
    await readFile(path.join(dir, "thumbnail.png"), "utf8"),
    "live-png",
    "the live set is untouched",
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "thumbnail.json"), "utf8")), live);

  // A second put never replaces the kept copy; Undo puts it back.
  await swapThumbnail(100, put);
  assert.equal(downloads, 3, "two refused downloads, one kept — none on the second put");
  assert.equal((await swapThumbnail(100, { undo: true })).set.variant, null);
  assert.deepEqual(sets.at(-1), { videoId: "vidAAAAAAAA", type: "image/jpeg", body: "A".repeat(8000) });
  assert.equal((await readUpload(100))?.thumbnailSet?.variant, null);

  // Another video for the match (a re-upload, an Adopt of another id) keeps its own copy: Undo on
  // it puts its own image back, never the first video's.
  await writeUpload(100, { ...record, videoId: "vidBBBBBBBB", finished: {} });
  await refused(swapThumbnail(100, { undo: true }), /Nothing to undo/);
  await swapThumbnail(100, put);
  await swapThumbnail(100, { undo: true });
  assert.deepEqual(sets.at(-1), { videoId: "vidBBBBBBBB", type: "image/jpeg", body: "B".repeat(8000) });

  // An Adopt of yet another id while a put is on the wire: the put's ledger is not written onto it.
  duringSet = () => writeUpload(100, { ...record, videoId: "vidCCCCCCCC", finished: {} });
  await swapThumbnail(100, put);
  duringSet = null;
  after = await readUpload(100);
  assert.equal(after?.videoId, "vidCCCCCCCC");
  assert.equal(after?.thumbnailSet, undefined, "not carried onto another video");

  // One at a time per match: a put waits out a Finish in flight (the same record, maybe the same image).
  await writeUpload(100, { ...record, videoId: "vidBBBBBBBB", finished: {} });
  let releaseFinish!: () => void;
  const finish = onVideo(100, () => new Promise<void>((r) => (releaseFinish = r)));
  const before = sets.length;
  const waiting = swapThumbnail(100, put);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(videoWriting(100), true);
  assert.equal(sets.length, before, "nothing sent while the Finish runs");
  releaseFinish();
  await finish;
  await waiting;
  assert.equal(sets.length, before + 1, "and it goes once the Finish is done");
  assert.equal(videoWriting(100), false);

  // A blocked player's match is refused before any read of the record or the live video — the
  // same gate every other YouTube write in this codebase goes through.
  {
    const savedBlocked = config.blockedPlayers;
    config.blockedPlayers = ["TestBlocked"];
    const bdir = path.join(media, "102");
    await mkdir(bdir, { recursive: true });
    await writeFile(path.join(bdir, "testblocked.mp4"), "x");
    await writeUpload(102, record);
    const beforeSets = sets.length;
    await refused(swapThumbnail(102, put), /blocked player/);
    await refused(swapThumbnail(102, { undo: true }), /blocked player/);
    assert.equal(sets.length, beforeSets, "nothing was ever sent to YouTube");
    config.blockedPlayers = savedBlocked;
  }

  console.log("thumbnailSwap: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = saved.mediaDir;
  config.youtubeChannelId = saved.channel;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  await rm(media, { recursive: true, force: true });
}
