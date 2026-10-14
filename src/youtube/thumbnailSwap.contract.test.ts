// Contract test for "Put on YouTube" / "Undo on YouTube" (CLAUDE.md, "Re-render a match's
// thumbnails beside the live set, never over it"; promise list in
// src/thumbnails/thumbnailVariants.contract.test.ts, 8/9/10 pinned here), written from the docs by
// an outsider. Covers what thumbnailSwap.test.ts does not: a Studio upload whose folder never had
// thumbnail files, the operator putting the arms-up tile by hand, Undo surviving a later re-render
// that emptied thumbnail-new/, the new set across put AND undo, and blocks read off chats and the
// title (an archived match) refusing before anything reaches Google.
// thumbnails.set changes the live channel: every fetch here is a stub, nothing reaches Google.
// Run: npx tsx src/youtube/thumbnailSwap.contract.test.ts
import assert from "node:assert/strict";
import { deviation } from "../fixtures/deviation.js";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { NEW_DIR, rerenderThumbnails } from "../thumbnails/rerender.js";
import type { renderThumbnailVariants } from "../thumbnails/thumbnailVariants.js";
import { swapThumbnail, SwapRefused, undoFile } from "./thumbnailSwap.js";
import { readUpload, writeUpload } from "./youtubeStore.js";
import type { MatchInfo } from "../api/types.js";

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/match-13766294.json", import.meta.url), "utf8"),
) as MatchInfo;

const media = await mkdtemp(path.join(tmpdir(), "mcsr-swap-contract-"));
const saved = {
  mediaDir: config.mediaDir,
  channel: config.youtubeChannelId,
  blocked: config.blockedPlayers,
  token: process.env.YOUTUBE_TOKEN_FILE,
};
config.mediaDir = media;
config.youtubeChannelId = "UCmine";
config.blockedPlayers = ["BlockedRunner"]; // synthetic: no real runner's name in test data
process.env.YOUTUBE_TOKEN_FILE = path.join(media, "token.json");
await writeFile(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);

/** What each video wears on YouTube right now: a 1280-wide JPEG well over 5 KB. */
const wears: Record<string, string> = {};
const sets: Array<{ videoId: string; body: string }> = [];
const calls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push(url);
  const json = (p: unknown) =>
    new Response(JSON.stringify(p), { headers: { "content-type": "application/json" } });
  if (url.startsWith("https://oauth2.googleapis.com/")) return json({ access_token: "t", expires_in: 3600 });
  if (url.includes("/videos?part=snippet&")) {
    const id = new URL(url).searchParams.get("id")!;
    const thumbnails = { maxres: { url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, width: 1280 } };
    return json({ items: [{ id, snippet: { channelId: "UCmine", title: `Live ${id}`, thumbnails } }] });
  }
  const image = /^https:\/\/i\.ytimg\.com\/vi\/(\w+)\/maxresdefault\.jpg$/.exec(url);
  if (image) return new Response(wears[image[1]!] ?? "");
  if (url.includes("/thumbnails/set?")) {
    const videoId = new URL(url).searchParams.get("videoId")!;
    const body = Buffer.from(init?.body as Uint8Array).toString();
    sets.push({ videoId, body });
    wears[videoId] = body;
    return json({ kind: "youtube#thumbnailSetResponse" });
  }
  // The MCSR API, for the re-renders below.
  if (/\/matches\/\d+$/.test(url)) return new Response(JSON.stringify({ status: "success", data: fixture }));
  const player = fixture.players.find((p) => url.endsWith(`/users/${p.uuid}`));
  if (player) return new Response(JSON.stringify({ status: "success", data: player }));
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const refused = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (err: unknown) => err instanceof SwapRefused && re.test((err as Error).message));

const TILES = ["walking-crossed", "cheering-relaxing"];
/** Chromium stand-in for a re-render: a finished new set, one still per tile, manifest last. */
const lands = (async (args) => {
  const variants = TILES.map((key) => ({
    key,
    file: `thumbnail.${key}.png`,
    leftPose: key.split("-")[0]!,
    rightPose: key.split("-")[1]!,
    leftProvider: "nmsr-facing" as const,
    rightProvider: "nmsr-facing" as const,
    hook: false,
  }));
  for (const v of variants) await writeFile(path.join(args.outDir, v.file), `NEW ${v.key}`);
  const manifest = { chosen: TILES[0]!, chosenBy: "auto" as const, hookText: null, variants };
  await writeFile(path.join(args.outDir, "thumbnail.json"), JSON.stringify(manifest));
  return manifest;
}) as typeof renderThumbnailVariants;
const cutShort = (async (args) => {
  await writeFile(path.join(args.outDir, "thumbnail.walking-crossed.png"), "half");
  throw new Error("chromium died");
}) as typeof renderThumbnailVariants;

const upload = (videoId: string) => ({
  videoId,
  uploadedAt: "2026-09-20T19:00:00Z",
  publishAt: null,
  privacyStatus: "public",
  thumbnailVariant: null,
  title: "t",
  source: "studio" as const,
});
const filesIn = async (dir: string) =>
  Object.fromEntries(
    await Promise.all(
      (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.startsWith("thumbnail"))
        .map(async (e) => [e.name, await readFile(path.join(dir, e.name), "utf8")]),
    ),
  );

try {
  // --- A Studio upload whose folder never had thumbnail files ---------------------------------
  // The docs name this case: a re-render reaches it too, and a put and an undo work on it.
  {
    const id = 500;
    const dir = path.join(media, String(id));
    await mkdir(dir);
    const vid = "studioVid01";
    wears[vid] = "S".repeat(9000);
    await writeUpload(id, upload(vid));
    await rerenderThumbnails(id, { render: lands });
    const put = await swapThumbnail(id, { variant: "walking-crossed" });
    assert.equal(sets.at(-1)?.body, "NEW walking-crossed", "the pressed tile is what YouTube gets");
    assert.equal(put.set.from, NEW_DIR);
    // What the video wore before the dashboard touched it is kept, so there is something to undo to.
    assert.equal(await readFile(path.join(dir, undoFile(vid)), "utf8"), "S".repeat(9000));
    await swapThumbnail(id, { undo: true });
    assert.equal(wears[vid], "S".repeat(9000), "Undo puts the Studio image back");
  }
  console.log("OK 8/9: a Studio upload with no thumbnail files gets a put and an undo");

  // --- The new set across a put AND an undo; the arms-up tile by hand -------------------------
  {
    const id = 501;
    const dir = path.join(media, String(id));
    await mkdir(dir);
    const live = {
      "thumbnail.json": JSON.stringify({
        chosen: "walking-crossed",
        chosenBy: "operator",
        hookText: null,
        variants: [],
      }),
      "thumbnail.png": "LIVE png",
      "thumbnail.walking-crossed.png": "LIVE walking-crossed",
    };
    for (const [f, b] of Object.entries(live)) await writeFile(path.join(dir, f), b);
    const vid = "rankedVid01";
    wears[vid] = "R".repeat(9000);
    await writeUpload(id, upload(vid));
    await rerenderThumbnails(id, { render: lands });
    const newSet = await filesIn(path.join(dir, NEW_DIR));

    // The exclusion is only on the paths nobody reviews: a press of the arms-up tile is the
    // operator's own choice, and it goes up.
    await swapThumbnail(id, { variant: "cheering-relaxing" });
    assert.equal(sets.at(-1)?.body, "NEW cheering-relaxing");
    assert.equal((await readUpload(id))?.thumbnailSet?.variant, "cheering-relaxing");
    // Read plainly, CLAUDE.md names Put as the press that changes the live files for a match on
    // the channel; the code writes only YouTube and youtube.json, so thumbnail.png and
    // manifest.chosen (tc-thumbs' "live pose") go on naming the old tile. Reported, not pinned.
    const liveChosen = JSON.parse(await readFile(path.join(dir, "thumbnail.json"), "utf8")).chosen;
    await deviation(
      'CLAUDE.md "Re-render a match\'s thumbnails…": live files change only on an operator press — "Put on YouTube" for a match on the channel (doc ambiguous: the code keeps Put to YouTube + youtube.json)',
      () => assert.equal(liveChosen, "cheering-relaxing", `after a Put, the live manifest still says "${liveChosen}"`),
    );
    await swapThumbnail(id, { variant: "walking-crossed" });
    await swapThumbnail(id, { undo: true });
    assert.equal(wears[vid], "R".repeat(9000), "Undo is the pre-dashboard image, not the previous tile");
    // A put does not consume thumbnail-new/: the new set is still there to try again.
    assert.deepEqual(await filesIn(path.join(dir, NEW_DIR)), newSet, "the new set is untouched");

    // A later re-render cut short empties thumbnail-new/ (no manifest). Undo does not depend on it.
    await swapThumbnail(id, { variant: "walking-crossed" });
    await assert.rejects(rerenderThumbnails(id, { render: cutShort }), /chromium died/);
    const before = sets.length;
    await refused(swapThumbnail(id, { variant: "walking-crossed" }), /re-render the thumbnails first/);
    assert.equal(sets.length, before, "a half-drawn set is never put on YouTube");
    await swapThumbnail(id, { undo: true });
    assert.equal(wears[vid], "R".repeat(9000), "Undo still goes back after the new set was emptied");
    assert.equal(
      await readFile(path.join(dir, undoFile(vid)), "utf8"),
      "R".repeat(9000),
      "the kept copy never changed",
    );
  }
  console.log("OK 8/9: put/undo leave the new set in place; Undo survives a cut-short re-render");

  // --- Blocked players: refused before anything reaches Google ---------------------------------
  {
    const cases: Array<[number, string, Record<string, string>]> = [
      // Archived off disk: only the title says who played.
      [
        510,
        "the title's pair",
        { "match-510.title.txt": "ONE PEARL | blockedrunner vs Other | MCSR Ranked" },
      ],
      [511, "a saved chat", { "chat-BLOCKEDRUNNER.json": "[]" }],
    ];
    for (const [id, how, files] of cases) {
      const dir = path.join(media, String(id));
      await mkdir(path.join(dir, NEW_DIR), { recursive: true });
      for (const [f, b] of Object.entries(files)) await writeFile(path.join(dir, f), b);
      await writeFile(
        path.join(dir, NEW_DIR, "thumbnail.json"),
        JSON.stringify({ chosen: "walking-crossed", variants: [{ key: "walking-crossed", file: "w.png" }] }),
      );
      await writeFile(path.join(dir, NEW_DIR, "w.png"), "stale");
      await writeFile(path.join(dir, undoFile(`blocked0${id}`)), "K".repeat(9000));
      await writeUpload(id, upload(`blocked0${id}`));
      const seen = calls.length;
      await refused(swapThumbnail(id, { variant: "walking-crossed" }), /blocked player/);
      await refused(swapThumbnail(id, { undo: true }), /blocked player/);
      // Not even the token or the video read: a runner's no is a block on every YouTube write.
      assert.equal(calls.length, seen, `${how}: nothing was asked of Google`);
    }
  }
  console.log("OK 10: a block read off a chat or the title refuses put and undo before any request");

  console.log("thumbnailSwap.contract: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = saved.mediaDir;
  config.youtubeChannelId = saved.channel;
  config.blockedPlayers = saved.blocked;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  await rm(media, { recursive: true, force: true });
}
