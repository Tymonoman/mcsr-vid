// "Re-render thumbnails" on disk: the new set lands in thumbnail-new/ and the live set is not
// touched; "Use this" on a new tile of a match not on the channel moves the set over the live one.
// Temp dirs, a stubbed fetch and a stubbed renderer — never the network, never /media.
// Run: npx tsx src/thumbnails/rerender.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { renderThumbnailVariants } from "./thumbnailVariants.js";
import { NEW_DIR, promoteNewSet, rerenderThumbnails, thumbnailRunning } from "./rerender.js";
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

/** The live set a match went up with: every file the upload, Finish, the scan and the A/B tab read. */
const LIVE = {
  "thumbnail.json": JSON.stringify({
    chosen: "walking-crossed",
    chosenBy: "operator",
    variants: [],
    hookText: "an old line",
    ranks: { u1: 9 },
  }),
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
  const variants = ["walking-crossed", "cheering-relaxing"].map((key) => ({
    key,
    file: `thumbnail.${key}.png`,
    leftPose: "a",
    rightPose: "b",
    leftProvider: "starlight" as const,
    rightProvider: "starlight" as const,
    hook: false,
  }));
  for (const v of variants) await writeFile(path.join(args.outDir, v.file), `new ${v.key}`);
  const manifest = {
    chosen: "walking-crossed",
    chosenBy: "auto" as const,
    hookText: null,
    variants,
    ranks: { u1: 3 },
  };
  await writeFile(path.join(args.outDir, "thumbnail.json"), JSON.stringify(manifest));
  return manifest;
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
  assert.equal(
    await readFile(path.join(dir, NEW_DIR, "thumbnail.walking-crossed.png"), "utf8"),
    "new walking-crossed",
  );

  // A re-render cut short leaves a folder with no manifest — nothing for the panel or a Put to
  // take for a finished set — and the live set is still untouched.
  await assert.rejects(rerenderThumbnails(7, { render: failing }), /chromium died/);
  assert.deepEqual(await readdir(path.join(dir, NEW_DIR)), ["thumbnail.walking-crossed.png"]);
  assert.deepEqual(await liveOf(dir), LIVE);

  // Not on the channel: the same folder, and the live set changes only at the press. "Use this"
  // renames the new stills over the live ones, copies the pick and writes the manifest last — the
  // pressed key, chosen by the operator, with the live set's frozen ranks and headline.
  const fresh = await seed(12);
  await rerenderThumbnails(12, { render: landing });
  assert.equal(outDirs.at(-1), path.join(fresh, NEW_DIR));
  assert.deepEqual(await liveOf(fresh), LIVE, "a re-render alone changes nothing live");
  await assert.rejects(promoteNewSet(12, "nope"), /No new-design thumbnail "nope"/);
  assert.deepEqual(await liveOf(fresh), LIVE, "an unknown tile changes nothing");
  const promoting = promoteNewSet(12, "cheering-relaxing");
  assert.equal(thumbnailRunning(12), true, "held while it moves the files: an upload refuses meanwhile");
  const promoted = await promoting;
  assert.equal(thumbnailRunning(12), false);
  const read = (f: string) => readFile(path.join(fresh, f), "utf8");
  assert.equal(await read("thumbnail.walking-crossed.png"), "new walking-crossed");
  assert.equal(await read("thumbnail.cheering-relaxing.png"), "new cheering-relaxing");
  assert.equal(await read("thumbnail.png"), "new cheering-relaxing");
  const written = JSON.parse(await read("thumbnail.json"));
  assert.deepEqual(written, promoted);
  assert.deepEqual(
    [written.chosen, written.chosenBy, written.hookText, written.ranks, written.variants.length],
    ["cheering-relaxing", "operator", "an old line", { u1: 9 }, 2],
  );
  assert.ok(!existsSync(path.join(fresh, NEW_DIR)), "the new set is the live one now");

  // No directory is a refusal before any API read.
  await assert.rejects(rerenderThumbnails(9, { render: landing }), /no directory/);

  // A blocked player's match is never rendered, even by hand — the same rule every other render
  // path follows (npm run short, the nightly). Read off the POV clip on disk, not the API.
  {
    const savedBlocked = config.blockedPlayers;
    config.blockedPlayers = ["TestBlocked"];
    const bdir = await seed(13);
    await writeFile(path.join(bdir, "testblocked.mp4"), "x");
    await assert.rejects(rerenderThumbnails(13, { render: landing }), /blocked player/);
    // "Use this" refuses too, even if a stale thumbnail-new/ somehow exists from before the block.
    await mkdir(path.join(bdir, NEW_DIR));
    await writeFile(
      path.join(bdir, NEW_DIR, "thumbnail.json"),
      JSON.stringify({ chosen: null, hookText: null, variants: [{ key: "k", file: "k.png" }] }),
    );
    await assert.rejects(promoteNewSet(13, "k"), /blocked player/);
    config.blockedPlayers = savedBlocked;
  }

  console.log("rerender: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = mediaDir;
  await rm(media, { recursive: true, force: true });
}
