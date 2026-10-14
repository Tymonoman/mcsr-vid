// Contract test for the upload side of "Blocked players" (src/youtube/youtubeUpload.ts), from the docs
// alone (CLAUDE.md "Blocked players"; handbook/claude-md-reference.md, same bullet). Promises:
//
//   1. A blocked match is never uploaded, long-form or Short — refused with one clear line, the way
//      `hookRefusal` refuses — even with its hooks saved and everything else in order.
//   2. The check is `hasBlockedPlayer` = `blockedOnDisk`: clips, chats and the title pair, so a
//      match archived off disk is refused too, and no network is needed to refuse.
//   3. `videos.insert` (the `send` seam of `beginUpload`) is never reached for a blocked match.
//   4. `finishOnYouTube` carries the same refusal: no playlist, thumbnail, comment or tag write; a
//      still-pending step's note says why; already-done steps are left alone; nothing is persisted
//      (the record on disk is unchanged), so unblocking needs no repair. The Studio pin step too.
//   5. All three callers inherit it: Adopt, the Finish button and the nightly's
//      `retryFailedPlaylists`/`retryPendingComments` ticks — the ticks reach a blocked match and make
//      no YouTube call for it.
//   6. Unblocking applies live: the same match, the runner taken off the list, is no longer refused
//      for being blocked.
// Run: MCSR_CONFIG=/nonexistent npx tsx src/youtube/youtubeUpload.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, DEFAULTS, matchDir } from "../config.js";
import type { UploadRecord } from "./youtubeStore.js";
import {
  beginUpload,
  finishOnYouTube,
  hookRefusal,
  retryFailedPlaylists,
  retryPendingComments,
} from "./youtubeUpload.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-upload-contract-"));
const saved = {
  mediaDir: config.mediaDir,
  blocked: config.blockedPlayers,
  enabled: config.youtubeUploadEnabled,
  studio: config.studioAutomation,
  fetch: globalThis.fetch,
};
config.mediaDir = media;
config.blockedPlayers = [...DEFAULTS.blockedPlayers];
config.youtubeUploadEnabled = true;

// No network at all: every request is recorded and refused, so "no YouTube call" is checkable.
const requests: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  requests.push(String(input instanceof Request ? input.url : input));
  throw new Error("no network in this test");
}) as typeof fetch;

/** A match ready to go up but for the block: the saved title hook and the Short's saved hook. */
const ready = (id: number, files: Record<string, string>): string => {
  const dir = matchDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `match-${id}.title.edited.txt`),
    `WHO BLINKS FIRST? | ${files.pair ?? "a vs b"} | MCSR Ranked 1v1 | Minecraft Speedrun\n`,
  );
  writeFileSync(path.join(dir, `short-${id}.hook.txt`), "WHO BLINKS FIRST?\n");
  for (const [name, text] of Object.entries(files))
    if (name !== "pair") writeFileSync(path.join(dir, name), text);
  return dir;
};
const record = (finished: UploadRecord["finished"], publishAt: string | null = null): UploadRecord => ({
  videoId: "abcdefghijk",
  uploadedAt: "2026-10-10T19:00:00Z",
  publishAt,
  privacyStatus: "private",
  thumbnailVariant: null,
  title: "WHO BLINKS FIRST? | hackingnoises vs BeefSalad | MCSR Ranked 1v1 | Minecraft Speedrun",
  source: "dashboard",
  finished,
});

try {
  // --- 1/2. hookRefusal: both kinds, live clips and archived -------------------------------------
  const LIVE = 60_000_001; // a freshly rendered match: both POV clips on disk
  ready(LIVE, { "hackingnoises.mp4": "", "BeefSalad.mp4": "", pair: "hackingnoises vs BeefSalad" });
  for (const kind of ["video", "short"] as const) {
    const refused = await hookRefusal(LIVE, kind);
    assert.equal(refused?.status, 403, `${kind}: a blocked player's match is refused, not merely held`);
    assert.match(refused!.error, /blocked player/, `${kind}: the line says why`);
    assert.doesNotMatch(refused!.error, /\n/, "one line");
  }
  // Archived: no clips, the chats only — then the title only. Still refused, still offline.
  const CHATS = 60_000_002;
  ready(CHATS, { "chat-Aquacorde.json": "[]", "chat-BlazeMind.json": "[]", pair: "x vs y" });
  const TITLE = 60_000_003;
  ready(TITLE, { pair: "BlazeMind vs Aquacorde" });
  for (const id of [CHATS, TITLE]) {
    assert.equal((await hookRefusal(id, "video"))?.status, 403, `archived #${id}: the long-form is refused`);
    assert.equal((await hookRefusal(id, "short"))?.status, 403, `archived #${id}: the Short is refused`);
  }
  // The control: the same files for a clean pair pass the long-form gate (so the 403 above is the block).
  const CLEAN = 60_000_004;
  ready(CLEAN, { "edcr.mp4": "", "doogile.mp4": "", pair: "edcr vs doogile" });
  assert.equal(await hookRefusal(CLEAN, "video"), null, "a clean match with its hook saved is not refused");
  assert.deepEqual(requests, [], "no network was needed to decide any of it");
  console.log("OK: hookRefusal refuses a blocked match, long-form and Short, live or archived, offline");

  // --- 3. beginUpload never reaches videos.insert -------------------------------------------------
  const sent: number[] = [];
  const send = (async () => {
    sent.push(1);
    throw new Error("videos.insert must not be reached");
  }) as unknown as Parameters<typeof beginUpload>[2];
  for (const kind of ["video", "short"] as const) {
    const begun = await beginUpload(LIVE, { kind, privacyStatus: "private" }, send);
    assert.ok("error" in begun, `${kind}: refused`);
    assert.equal(begun.status, 403);
    assert.match(begun.error, /blocked player/);
  }
  assert.deepEqual(sent, [], "videos.insert is never called for a blocked match");
  console.log("OK: beginUpload refuses before videos.insert");

  // --- 4. finishOnYouTube: notes on pending steps, done steps kept, nothing persisted -------------
  config.studioAutomation = true; // the pin step is in play too
  const FIN = 60_000_005;
  const finDir = ready(FIN, {
    "hackingnoises.mp4": "",
    "BeefSalad.mp4": "",
    pair: "hackingnoises vs BeefSalad",
  });
  // Uploaded before the block: the thumbnail went on (null = done), the rest never ran or failed.
  const before = record({ thumbnail: null, playlists: "quota", comment: undefined, tags: "boom" });
  writeFileSync(path.join(finDir, "youtube.json"), JSON.stringify(before));
  const onDisk = readFileSync(path.join(finDir, "youtube.json"), "utf8");
  const pins: string[] = [];
  const pinAction = (async (...args: unknown[]) => {
    pins.push(String(args[0]));
    return null;
  }) as unknown as Parameters<typeof finishOnYouTube>[3];
  const steps = await finishOnYouTube(FIN, before.videoId, "video", pinAction);
  assert.equal(steps.thumbnail, null, "an already-done step is left alone — nothing true becomes a lie");
  for (const step of ["playlists", "comment", "tags", "pin"] as const) {
    assert.equal(typeof steps[step], "string", `${step}: still pending, so it carries a note`);
    assert.match(steps[step]!, /blocked/, `${step}: the note says why`);
  }
  assert.deepEqual(pins, [], "the Studio pin is never attempted");
  assert.equal(readFileSync(path.join(finDir, "youtube.json"), "utf8"), onDisk, "nothing is persisted");
  assert.deepEqual(requests, [], "no YouTube read or write");
  console.log(
    "OK: finishOnYouTube refuses every pending step, keeps done ones, persists nothing, calls nobody",
  );

  // --- 5. The nightly's ticks go through the same refusal ------------------------------------------
  // A failed playlist step (retryFailedPlaylists' trigger) and a due comment (retryPendingComments').
  const TICK = 60_000_006;
  const tickDir = ready(TICK, { "chat-BeefSalad.json": "[]", pair: "hackingnoises vs BeefSalad" });
  const due = record({ playlists: "RATE_LIMIT_EXCEEDED", comment: "private" }, "2026-10-01T19:00:00Z");
  writeFileSync(path.join(tickDir, "youtube.json"), JSON.stringify({ ...due, videoId: "TICKvideo01" }));
  const tickBefore = readFileSync(path.join(tickDir, "youtube.json"), "utf8");
  await retryFailedPlaylists();
  await retryPendingComments();
  assert.deepEqual(requests, [], "neither tick makes a YouTube call for a blocked match");
  assert.equal(
    readFileSync(path.join(tickDir, "youtube.json"), "utf8"),
    tickBefore,
    "and neither rewrites its record",
  );
  console.log("OK: retryFailedPlaylists and retryPendingComments inherit the refusal");

  // --- 6. Unblocking applies live, with no repair ---------------------------------------------------
  config.blockedPlayers = [];
  const unblocked = await hookRefusal(LIVE, "video");
  assert.ok(
    unblocked === null || !/blocked/.test(unblocked.error),
    "off the list, the block refusal is gone",
  );
  config.blockedPlayers = [...DEFAULTS.blockedPlayers];
  console.log("OK: taking a runner off the list lifts the refusal at once");
} finally {
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  config.youtubeUploadEnabled = saved.enabled;
  config.studioAutomation = saved.studio;
  globalThis.fetch = saved.fetch;
}

console.log("youtubeUpload.contract: all checks passed");
