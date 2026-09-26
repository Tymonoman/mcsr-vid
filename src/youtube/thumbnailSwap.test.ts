// "Put on YouTube" / "Undo on YouTube" against a stubbed fetch — thumbnails.set changes the live
// channel, so nothing here reaches Google. Run: npx tsx src/youtube/thumbnailSwap.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { swapThumbnail, SwapRefused, YOUTUBE_PREV_FILE } from "./thumbnailSwap.js";
import { readUpload, writeUpload } from "./youtubeStore.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-swap-test-"));
const saved = {
  mediaDir: config.mediaDir,
  channel: config.youtubeChannelId,
  token: process.env.YOUTUBE_TOKEN_FILE,
};
const realFetch = globalThis.fetch;
config.mediaDir = media;
config.youtubeChannelId = "UCmine";
const tokenFile = path.join(media, "token.json");
await writeFile(tokenFile, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }));
process.env.YOUTUBE_TOKEN_FILE = tokenFile;

let owner = "UCmine";
let imageStatus = 200;
const JPEG = "J".repeat(8000);
let imageBody = JPEG;
let hasMaxres = true;
const sets: Array<{ videoId: string; type: string; body: string }> = [];
let downloads = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const json = (p: unknown) =>
    new Response(JSON.stringify(p), { headers: { "content-type": "application/json" } });
  if (url.startsWith("https://oauth2.googleapis.com/")) return json({ access_token: "t", expires_in: 3600 });
  if (url.includes("/videos?part=snippet&"))
    return json({
      items: [
        {
          id: "vidAAAAAAAA",
          snippet: {
            channelId: owner,
            title: "Live title",
            description: "d",
            categoryId: "20",
            thumbnails: {
              default: { url: "https://i.ytimg.com/vi/x/default.jpg", width: 120 },
              high: { url: "https://i.ytimg.com/vi/x/hqdefault.jpg", width: 480 },
              ...(hasMaxres
                ? { maxres: { url: "https://i.ytimg.com/vi/x/maxresdefault.jpg", width: 1280 } }
                : {}),
            },
          },
        },
      ],
    });
  if (url === "https://i.ytimg.com/vi/x/maxresdefault.jpg") {
    downloads++;
    return new Response(imageStatus === 200 ? imageBody : "", { status: imageStatus });
  }
  if (url.includes("/thumbnails/set?")) {
    const headers = init?.headers as Record<string, string>;
    sets.push({
      videoId: new URL(url).searchParams.get("videoId")!,
      type: headers["content-type"]!,
      body: Buffer.from(init?.body as Uint8Array).toString(),
    });
    return json({ kind: "youtube#thumbnailSetResponse" });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const refused = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (err: unknown) => err instanceof SwapRefused && re.test((err as Error).message));

try {
  const dir = path.join(media, "100");
  await mkdir(dir);
  const manifest = {
    chosen: "walking-crossed",
    chosenBy: "auto",
    hookText: null,
    variants: [
      {
        key: "walking-crossed",
        leftPose: "walking",
        rightPose: "crossed",
        leftProvider: "starlight",
        rightProvider: "starlight",
        hook: false,
        file: "thumbnail.walking-crossed.png",
      },
    ],
  };
  await writeFile(path.join(dir, "thumbnail.json"), JSON.stringify(manifest));
  await writeFile(path.join(dir, "thumbnail.walking-crossed.png"), "new-png");

  // Not on the channel: nothing to swap.
  await refused(swapThumbnail(100, false), /no long-form/);

  const record = {
    videoId: "vidAAAAAAAA",
    uploadedAt: "2026-09-20T19:00:00Z",
    publishAt: null,
    privacyStatus: "public",
    thumbnailVariant: "walking-crossed",
    title: "Old title",
    source: "studio" as const,
    finished: {
      thumbnail: "left alone — this video was uploaded elsewhere and no variant was confirmed here",
    },
  };
  await writeUpload(100, record);

  // A series' game 2 carries game 1's video id; its thumbnail is not the series'.
  await mkdir(path.join(media, "101"));
  await writeUpload(101, record);
  await refused(swapThumbnail(101, false), /no long-form/);

  // The renderer's default is not a decision.
  await refused(swapThumbnail(100, false), /No variant is confirmed/);
  await writeFile(path.join(dir, "thumbnail.json"), JSON.stringify({ ...manifest, chosenBy: "operator" }));

  // Nothing to undo before a first swap.
  await refused(swapThumbnail(100, true), /Nothing to undo/);

  // Another channel's video: refused by the read, nothing downloaded, nothing set.
  owner = "UCother";
  await assert.rejects(swapThumbnail(100, false), /belongs to channel UCother/);
  owner = "UCmine";
  // YouTube does not serve the image (a private video): no copy to undo to, so nothing is set.
  imageStatus = 404;
  await refused(swapThumbnail(100, false), /nothing changed/);
  assert.equal(sets.length, 0);
  assert.ok(!existsSync(path.join(dir, YOUTUBE_PREV_FILE)));
  imageStatus = 200;
  // The copy is kept for good, so it has to be the picture: a 200 with an empty body is refused,
  // and so is a video whose largest image is the 4:3 letterboxed hqdefault (not even fetched).
  imageBody = "";
  await refused(swapThumbnail(100, false), /nothing changed/);
  imageBody = JPEG;
  hasMaxres = false;
  await refused(swapThumbnail(100, false), /nothing changed/);
  hasMaxres = true;
  assert.equal(sets.length, 0);
  assert.ok(!existsSync(path.join(dir, YOUTUBE_PREV_FILE)));

  // The put: the live image kept first, then the chosen variant sent as PNG, recorded in the ledger.
  const put = await swapThumbnail(100, false);
  assert.equal(put.title, "Live title");
  assert.equal(put.set.variant, "walking-crossed");
  assert.equal(await readFile(path.join(dir, YOUTUBE_PREV_FILE), "utf8"), JPEG);
  assert.deepEqual(sets[0], { videoId: "vidAAAAAAAA", type: "image/png", body: "new-png" });
  let after = await readUpload(100);
  assert.deepEqual(after?.thumbnailSet, put.set);
  assert.equal(after?.finished?.thumbnail, null, "a later Finish does not set another image over it");

  // A second put never replaces the kept copy: Undo goes back to the image before the dashboard.
  await swapThumbnail(100, false);
  assert.equal(downloads, 3, "two refused downloads, one kept — none on the second put");

  // Undo: the kept JPEG goes back.
  const undone = await swapThumbnail(100, true);
  assert.equal(undone.set.variant, null);
  assert.deepEqual(sets.at(-1), { videoId: "vidAAAAAAAA", type: "image/jpeg", body: JPEG });
  after = await readUpload(100);
  assert.equal(after?.thumbnailSet?.variant, null);

  console.log("thumbnailSwap: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = saved.mediaDir;
  config.youtubeChannelId = saved.channel;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  await rm(media, { recursive: true, force: true });
}
