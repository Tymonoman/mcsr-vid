// "Re-render thumbnails" on disk: the backup, the restore after a failed render (and after a
// restart cut one short), that thumbnail.png (what the video went up with) is never touched on an
// uploaded match and follows the new pick on one not yet uploaded, and the A/B tab's row. Temp dirs and a stubbed fetch —
// never the network, never /media. Run: npx tsx src/thumbnails/rerender.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { chooseVariant, type renderThumbnailVariants } from "./thumbnailVariants.js";
import {
  abRowFor,
  copyThumbnails,
  PREV_DIR,
  rerenderThumbnails,
  restoreThumbnails,
  RUNNING_DIR,
} from "./rerender.js";
import { writeUpload } from "../youtube/youtubeStore.js";

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
  const uploaded = {
    videoId: "vid7",
    uploadedAt: "2026-09-20T19:00:00Z",
    publishAt: null,
    privacyStatus: "public",
    thumbnailVariant: "walking-crossed",
    title: "t",
  };
  await writeUpload(7, uploaded);

  // A render that dies halfway: the old set comes back over what it wrote, and it rethrows.
  const failing = (async (args) => {
    assert.equal(args.fresh, true, "a re-render never reuses a still on disk");
    // The stills are overwritten from here on: the manifest already vouches for none of them, so
    // Finish, the nightly's playlist retry or an upload cannot send a half-drawn set as confirmed.
    const live = path.join(args.outDir, "thumbnail.json");
    if (existsSync(live)) {
      const drawing = JSON.parse(await readFile(live, "utf8"));
      assert.equal(drawing.chosenBy, "auto", "no confirmed pick while the stills are redrawn");
      assert.ok(drawing.rerenderedAt, "and the set reads as re-rendered from the first still");
    }
    await writeFile(path.join(args.outDir, "thumbnail.walking-crossed.png"), "half");
    await writeFile(path.join(args.outDir, "thumbnail.json"), "{}");
    throw new Error("chromium died");
  }) as typeof renderThumbnailVariants;
  await assert.rejects(rerenderThumbnails(7, { render: failing }), /chromium died/);
  assert.equal(await readFile(path.join(dir, "thumbnail.walking-crossed.png"), "utf8"), "old-a");
  const restored = JSON.parse(await readFile(path.join(dir, "thumbnail.json"), "utf8"));
  assert.deepEqual(restored, old, "the manifest it started from, the operator's pick with it");
  assert.ok(!existsSync(path.join(dir, RUNNING_DIR)), "the working copy is cleared");

  // The kept set is the thumbnail files and nothing else: not the export, not the YouTube undo copy.
  assert.deepEqual((await readdir(path.join(dir, PREV_DIR))).sort(), [
    "thumbnail.json",
    "thumbnail.png",
    "thumbnail.walking-crossed.png",
  ]);

  // A render that lands: the old set is in thumbnail-prev/, thumbnail.png untouched.
  let draws = 0;
  const landing = (async (args) => {
    draws++;
    const next = {
      ...old,
      chosenBy: "auto" as const,
      variants: [{ key: "walking-crossed", file: "thumbnail.walking-crossed.png" }],
    };
    await writeFile(path.join(args.outDir, "thumbnail.walking-crossed.png"), `new-${draws}`);
    await writeFile(path.join(args.outDir, "thumbnail.json"), JSON.stringify(next));
    return next;
  }) as typeof renderThumbnailVariants;
  await rerenderThumbnails(7, { render: landing });
  assert.equal(await readFile(path.join(dir, "thumbnail.walking-crossed.png"), "utf8"), "new-1");
  assert.equal(await readFile(path.join(dir, PREV_DIR, "thumbnail.walking-crossed.png"), "utf8"), "old-a");
  assert.equal(await readFile(path.join(dir, "thumbnail.png"), "utf8"), "live");

  // Re-render, "Use this" (thumbnail.png becomes the new image), re-render again — the bulk after
  // a single run: the old design and the image the video went up with are still kept.
  await chooseVariant(dir, "walking-crossed");
  assert.equal(await readFile(path.join(dir, "thumbnail.png"), "utf8"), "new-1");
  await rerenderThumbnails(7, { render: landing });
  assert.equal(await readFile(path.join(dir, PREV_DIR, "thumbnail.walking-crossed.png"), "utf8"), "old-a");
  assert.equal(await readFile(path.join(dir, PREV_DIR, "thumbnail.png"), "utf8"), "live");

  // ...and a failure then puts back the set it started from (the first re-render), not the old one.
  await assert.rejects(rerenderThumbnails(7, { render: failing }), /chromium died/);
  assert.equal(await readFile(path.join(dir, "thumbnail.walking-crossed.png"), "utf8"), "new-2");

  // A Studio upload with no thumbnail files at all: nothing to back up, and a failure leaves no
  // manifest naming stills that were never drawn.
  const bare = path.join(media, "8");
  await mkdir(bare);
  assert.deepEqual(await copyThumbnails(bare, PREV_DIR), []);
  assert.deepEqual(await restoreThumbnails(bare, PREV_DIR), []);
  assert.ok(!existsSync(path.join(bare, PREV_DIR)));
  await assert.rejects(rerenderThumbnails(8, { render: failing }), /chromium died/);
  assert.ok(!existsSync(path.join(bare, "thumbnail.json")), "no manifest naming stills never drawn");

  // A restart cut a re-render short: its working copy is still there and the live set is half
  // new. The next re-render puts the set it started from back before copying anything.
  const cut = path.join(media, "11");
  await mkdir(path.join(cut, RUNNING_DIR), { recursive: true });
  await writeFile(path.join(cut, RUNNING_DIR, "thumbnail.walking-crossed.png"), "old-11");
  await writeFile(path.join(cut, "thumbnail.walking-crossed.png"), "half-drawn");
  await assert.rejects(rerenderThumbnails(11, { render: failing }), /chromium died/);
  assert.equal(await readFile(path.join(cut, "thumbnail.walking-crossed.png"), "utf8"), "old-11");
  assert.equal(await readFile(path.join(cut, PREV_DIR, "thumbnail.walking-crossed.png"), "utf8"), "old-11");

  // Not uploaded yet: an upload sends the chosen variant, so thumbnail.png (what the publish set,
  // the bundle and Studio are handed) follows the new pick rather than keep the old design.
  const fresh = path.join(media, "12");
  await mkdir(fresh);
  await writeFile(path.join(fresh, "thumbnail.json"), JSON.stringify(old));
  await writeFile(path.join(fresh, "thumbnail.png"), "old-12");
  await rerenderThumbnails(12, { render: landing });
  assert.equal(await readFile(path.join(fresh, "thumbnail.png"), "utf8"), `new-${draws}`);
  assert.equal(await readFile(path.join(fresh, PREV_DIR, "thumbnail.png"), "utf8"), "old-12");

  // The A/B tab: a re-render after the upload redrew the set with the facing look, so the row is
  // the one the video went up with, from thumbnail-prev/ — not "(facing)", which would credit the
  // new look with the old image's clicks. A swapped video wore both and has a row of its own.
  const ab = path.join(media, "13");
  await mkdir(path.join(ab, PREV_DIR), { recursive: true });
  const drawn = (provider: string, extra: object = {}) =>
    JSON.stringify({
      chosen: "walking-crossed",
      hookText: null,
      variants: [
        {
          key: "walking-crossed",
          leftPose: "walking",
          rightPose: "crossed",
          leftProvider: provider,
          rightProvider: provider,
          file: "thumbnail.walking-crossed.png",
        },
      ],
      ...extra,
    });
  await writeFile(path.join(ab, PREV_DIR, "thumbnail.json"), drawn("nmsr-posed"));
  await writeFile(
    path.join(ab, "thumbnail.json"),
    drawn("nmsr-facing", { rerenderedAt: "2026-09-26T10:00:00Z" }),
  );
  const row = async (u: Parameters<typeof abRowFor>[1]) => (await abRowFor(ab, u)).key;
  assert.equal(await row({ ...uploaded, source: "dashboard" }), "walking-crossed");
  assert.equal(
    await row({ source: "channel", publishedAt: "" }),
    "walking-crossed",
    "an unknown time fails closed",
  );
  assert.equal(
    await row({ ...uploaded, source: "dashboard", uploadedAt: "2026-09-26T11:00:00Z" }),
    "walking-crossed (facing)",
    "uploaded after the re-render: it wears the new look",
  );
  assert.equal(
    await row({ ...uploaded, source: "dashboard", thumbnailSet: { variant: "walking-crossed", at: "x" } }),
    "(swapped)",
  );

  // No directory is a refusal before any API read.
  await assert.rejects(rerenderThumbnails(9, { render: landing }), /no directory/);

  console.log("rerender: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = mediaDir;
  await rm(media, { recursive: true, force: true });
}
