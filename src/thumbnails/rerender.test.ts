// "Re-render thumbnails" on disk: the backup, the restore after a failed render, and that
// thumbnail.png (what the video went up with) is never touched. Temp dirs and a stubbed fetch —
// never the network, never /media. Run: npx tsx src/thumbnails/rerender.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { backupThumbnails, PREV_DIR, rerenderThumbnails, restoreThumbnails } from "./rerender.js";
import type { renderThumbnailVariants } from "./thumbnailVariants.js";

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

try {
  const dir = path.join(media, "7");
  await mkdir(dir);
  const old = { chosen: "walking-crossed", chosenBy: "operator", hookText: null, variants: [] };
  await writeFile(path.join(dir, "thumbnail.json"), JSON.stringify(old));
  await writeFile(path.join(dir, "thumbnail.png"), "live");
  await writeFile(path.join(dir, "thumbnail.walking-crossed.png"), "old-a");
  await writeFile(path.join(dir, "thumbnail-youtube-prev.jpg"), "yt");
  await writeFile(path.join(dir, "final-7.mp4"), "video");

  // The backup is the thumbnail set and nothing else: not the export, not the YouTube undo copy.
  const kept = await backupThumbnails(dir);
  assert.deepEqual(kept.sort(), ["thumbnail.json", "thumbnail.png", "thumbnail.walking-crossed.png"]);
  assert.deepEqual((await readdir(path.join(dir, PREV_DIR))).sort(), kept);

  // A render that dies halfway: the old set comes back over what it wrote, and it rethrows.
  const failing = (async (args) => {
    assert.equal(args.fresh, true, "a re-render never reuses a still on disk");
    await writeFile(path.join(args.outDir, "thumbnail.walking-crossed.png"), "half");
    await writeFile(path.join(args.outDir, "thumbnail.json"), "{}");
    throw new Error("chromium died");
  }) as typeof renderThumbnailVariants;
  await assert.rejects(rerenderThumbnails(7, { render: failing }), /chromium died/);
  assert.equal(await readFile(path.join(dir, "thumbnail.walking-crossed.png"), "utf8"), "old-a");
  assert.equal(
    JSON.parse(await readFile(path.join(dir, "thumbnail.json"), "utf8")).chosen,
    "walking-crossed",
  );

  // A render that lands: the previous generation is in thumbnail-prev/, thumbnail.png untouched.
  const landing = (async (args) => {
    await writeFile(path.join(args.outDir, "thumbnail.walking-crossed.png"), "new-a");
    await writeFile(path.join(args.outDir, "thumbnail.json"), JSON.stringify({ ...old, chosenBy: "auto" }));
    return { ...old, chosenBy: "auto" as const };
  }) as typeof renderThumbnailVariants;
  await rerenderThumbnails(7, { render: landing });
  assert.equal(await readFile(path.join(dir, "thumbnail.walking-crossed.png"), "utf8"), "new-a");
  assert.equal(await readFile(path.join(dir, PREV_DIR, "thumbnail.walking-crossed.png"), "utf8"), "old-a");
  assert.equal(await readFile(path.join(dir, "thumbnail.png"), "utf8"), "live");

  // One generation: a second re-render replaces the backup rather than nesting it.
  await rerenderThumbnails(7, { render: landing });
  assert.equal(await readFile(path.join(dir, PREV_DIR, "thumbnail.walking-crossed.png"), "utf8"), "new-a");

  // A Studio upload with no thumbnail files at all: nothing to back up, and a failure leaves no
  // manifest naming stills that were never drawn.
  const bare = path.join(media, "8");
  await mkdir(bare);
  assert.deepEqual(await backupThumbnails(bare), []);
  assert.deepEqual(await restoreThumbnails(bare), []);
  assert.ok(!existsSync(path.join(bare, PREV_DIR)));

  // No directory is a refusal before any API read.
  await assert.rejects(rerenderThumbnails(9, { render: landing }), /no directory/);

  console.log("rerender: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = mediaDir;
  await rm(media, { recursive: true, force: true });
}
