// "Re-render thumbnails" on disk: a match on the channel gets the new set in thumbnail-new/ and its
// live set is not touched; one not on the channel is drawn again in place. Temp dirs, a stubbed
// fetch and a stubbed renderer — never the network, never /media.
// Run: npx tsx src/thumbnails/rerender.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { renderThumbnailVariants } from "./thumbnailVariants.js";
import { NEW_DIR, rerenderThumbnails } from "./rerender.js";
import { writeUpload } from "../youtube/youtubeStore.js";
import { _setChannelUploadsForTest } from "../youtube/channelUploads.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-rerender-test-"));
const mediaDir = config.mediaDir;
const realFetch = globalThis.fetch;
config.mediaDir = media;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const data = /\/matches\/\d+$/.test(url)
    ? {
        id: 7,
        type: 2,
        players: [
          { uuid: "u1", nickname: "a" },
          { uuid: "u2", nickname: "b" },
        ],
      }
    : { uuid: url.split("/").pop(), nickname: "x" };
  return new Response(JSON.stringify({ status: "success", data }));
}) as typeof fetch;

/** The live set a match went up with: every file the upload, Finish, the scan and the A/B tab read. */
const LIVE = {
  "thumbnail.json": JSON.stringify({ chosen: "walking-crossed", chosenBy: "operator", variants: [] }),
  "thumbnail.png": "live",
  "thumbnail.walking-crossed.png": "old-a",
};
const seed = async (id: number) => {
  const dir = path.join(media, String(id));
  await mkdir(dir);
  for (const [f, body] of Object.entries(LIVE)) await writeFile(path.join(dir, f), body);
  return dir;
};
const liveOf = async (dir: string) =>
  Object.fromEntries(
    await Promise.all(Object.keys(LIVE).map(async (f) => [f, await readFile(path.join(dir, f), "utf8")])),
  );

const outDirs: string[] = [];
const landing = (async (args) => {
  assert.equal(args.fresh, true, "a re-render never reuses a still on disk");
  outDirs.push(args.outDir);
  await writeFile(path.join(args.outDir, "thumbnail.walking-crossed.png"), "new");
  await writeFile(path.join(args.outDir, "thumbnail.json"), "{}");
  return { chosen: "walking-crossed", hookText: null, variants: [] };
}) as typeof renderThumbnailVariants;
const failing = (async (args) => {
  await writeFile(path.join(args.outDir, "thumbnail.walking-crossed.png"), "half");
  throw new Error("chromium died");
}) as typeof renderThumbnailVariants;

try {
  // Uploaded: the new set lands in its own folder and the live set is byte for byte what it was.
  const dir = await seed(7);
  await writeUpload(7, {
    videoId: "vid7",
    uploadedAt: "2026-09-20T19:00:00Z",
    publishAt: null,
    privacyStatus: "public",
    thumbnailVariant: "walking-crossed",
    title: "t",
  });
  await rerenderThumbnails(7, { render: landing });
  assert.equal(outDirs.at(-1), path.join(dir, NEW_DIR));
  assert.deepEqual(await liveOf(dir), LIVE, "the live set is not touched");
  assert.equal(await readFile(path.join(dir, NEW_DIR, "thumbnail.walking-crossed.png"), "utf8"), "new");

  // A re-render cut short leaves a folder with no manifest — nothing for the panel or a Put to
  // take for a finished set — and the live set is still untouched.
  await assert.rejects(rerenderThumbnails(7, { render: failing }), /chromium died/);
  assert.deepEqual(await readdir(path.join(dir, NEW_DIR)), ["thumbnail.walking-crossed.png"]);
  assert.deepEqual(await liveOf(dir), LIVE);

  // On the channel without a record of its own (a series' game 2, a Studio upload the scan has not
  // recorded): the same — the A/B tab reads its live manifest too.
  const paired = await seed(8);
  _setChannelUploadsForTest([
    {
      videoId: "seriesVid01",
      title: "hook | a vs b",
      publishedAt: "2026-09-01T19:00:00Z",
      description: "Match data: https://mcsrranked.com/matches/8",
      privacyStatus: "public",
      durationSec: 3000,
    },
  ]);
  await rerenderThumbnails(8, { render: landing });
  assert.equal(outDirs.at(-1), path.join(paired, NEW_DIR));
  assert.deepEqual(await liveOf(paired), LIVE);
  _setChannelUploadsForTest([]);

  // Not on the channel: nothing to protect, so the live set is drawn again in place, as a pipeline
  // run would, and no thumbnail-new/ is made.
  const fresh = await seed(12);
  await rerenderThumbnails(12, { render: landing });
  assert.equal(outDirs.at(-1), fresh);
  assert.equal(await readFile(path.join(fresh, "thumbnail.walking-crossed.png"), "utf8"), "new");
  assert.ok(!existsSync(path.join(fresh, NEW_DIR)));

  // No directory is a refusal before any API read.
  await assert.rejects(rerenderThumbnails(9, { render: landing }), /no directory/);

  console.log("rerender: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = mediaDir;
  await rm(media, { recursive: true, force: true });
}
