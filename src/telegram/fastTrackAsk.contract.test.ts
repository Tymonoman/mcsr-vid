// Contract test for the fast-track ask (src/telegram/fastTrackAsk.ts; CLAUDE.md "Telegram bot",
// handbook "Fast-track ask"), driven through the public surface: `sendFastTrackAsk` directly (the
// hook `shortFlow.ts` would fire it through), and a button press via index.ts's `handleUpdate`,
// same gate the title picker's own buttons get. Every API — Telegram, MCSR, YouTube — is a stub
// on global fetch.
//
// Promises:
//  1. The message is sent once (photo, caption with the magmamcsr link), never twice.
//  2. A press from any chat but TELEGRAM_CHAT_ID does nothing — no API call, nothing settled.
//  3. Yes reschedules only that video: `videos.update` carries the whole `status` part back,
//     with only `publishAt` changed; an unrelated match's own scheduled video is untouched.
//  4. Yes on a video due within 2h (or already public) changes nothing and says so.
//  5. No changes nothing.
// Run: npx tsx src/telegram/fastTrackAsk.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InlineKeyboard } from "./bot.js";

const root = mkdtempSync(path.join(tmpdir(), "tg-fasttrack-"));
const media = path.join(root, "media");
mkdirSync(media);

const TOKEN = "999001:fasttrack-test-token";
const CHAT = "42";
process.env.TELEGRAM_BOT_TOKEN = TOKEN;
process.env.TELEGRAM_CHAT_ID = CHAT;
process.env.YOUTUBE_TOKEN_FILE = path.join(root, "youtube-token.json");
writeFileSync(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);

/* --- The fixture match: edcr vs doogile, type 2 (ranked) — no playoffs bracket fetch ------------ */
const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures");
const fixture = JSON.parse(readFileSync(path.join(FIXTURES, "match-12730175.json"), "utf8")) as {
  players: Array<{ uuid: string; nickname: string }>;
  [k: string]: unknown;
};
const [LEFT, RIGHT] = fixture.players;
const matchOf = (id: number) => ({ ...fixture, changes: [], id });

/* --- Every API, stubbed ------------------------------------------------------------------------- */
type TgCall = { method: string; body: Record<string, unknown> | null };
const tgCalls: TgCall[] = [];
let nextMessageId = 1000;
interface YtVideo {
  channelId: string;
  privacyStatus: string;
  publishAt: string | null;
}
const ytVideos = new Map<string, YtVideo>();
const ytWrites: Array<{ id: string; status: Record<string, unknown> }> = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });

  if (url.hostname === "api.telegram.org") {
    assert.ok(url.pathname.startsWith(`/bot${TOKEN}/`), "the right token is used");
    const method = url.pathname.split("/").pop()!;
    let body: Record<string, unknown> | null = null;
    if (init?.body instanceof FormData) {
      body = Object.fromEntries(
        [...init.body.entries()].map(([k, v]) => [k, v instanceof Blob ? "<blob>" : v]),
      );
    } else if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    tgCalls.push({ method, body });
    if (method === "sendPhoto" || method === "sendMessage")
      return json({ ok: true, result: { message_id: nextMessageId++ } });
    return json({ ok: true, result: true });
  }
  if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "yt-tok", expires_in: 3600 });
  if (url.hostname === "www.googleapis.com" && url.pathname === "/youtube/v3/videos") {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      const id = url.searchParams.get("id")!;
      const v = ytVideos.get(id);
      return json({
        items: v
          ? [
              {
                id,
                snippet: { channelId: v.channelId },
                status: {
                  privacyStatus: v.privacyStatus,
                  publishAt: v.publishAt ?? undefined,
                  license: "youtube",
                },
              },
            ]
          : [],
      });
    }
    const body = JSON.parse(String(init?.body)) as { id: string; status: Record<string, unknown> };
    ytWrites.push(body);
    const v = ytVideos.get(body.id);
    if (v) v.publishAt = String(body.status.publishAt);
    return json({ id: body.id, status: body.status });
  }
  if (url.hostname === "api.mcsrranked.com") {
    const ok = (data: unknown) => json({ status: "success", data });
    const m = /^\/matches\/(\d+)$/.exec(url.pathname);
    if (m) return ok(matchOf(Number(m[1])));
    return json({ status: "error", data: "not found" });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

/* --- Modules, loaded only now -------------------------------------------------------------------- */
const { config } = await import("../config.js");
config.mediaDir = media;
const bot = await import("./bot.js");
const index = await import("./index.js");
const fastTrackAsk = await import("./fastTrackAsk.js");
const { readTelegramState } = await import("./state.js");
const { writeUpload } = await import("../youtube/youtubeStore.js");

const dir = (id: number) => path.join(media, String(id));
const splitsPngPath = (id: number, i: number) => path.join(dir(id), `overlay-splits-${i}.png`);
// `.fast-track.json`'s shape (fastTrack.ts's own `FastTrackState`), built up as the test's own
// matches are readied — no exported writer, so the test writes the file directly.
const fastTrackHits: Array<{ matchId: number; players: string; at: string; reason: string }> = [];

/** A fast-tracked match ready for the ask: a splits manifest with the subscribe card as its
 *  final state, an upload record (the long-form already up), and a hit in `.fast-track.json` —
 *  the three things `sendFastTrackAsk` reads. */
async function readyFastTrack(
  id: number,
  opts: { publishAt: string; videoId?: string; privacyStatus?: string },
): Promise<string> {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(splitsPngPath(id, 0), "not a real png, just needs to exist — the race view");
  writeFileSync(splitsPngPath(id, 1), "not a real png, just needs to exist — the subscribe card");
  writeFileSync(
    path.join(dir(id), "overlay-splits.json"),
    JSON.stringify([
      { path: splitsPngPath(id, 0), startSec: 0, durationSec: 500 },
      { path: splitsPngPath(id, 1), startSec: 500, durationSec: 60 },
    ]),
  );
  fastTrackHits.push({
    matchId: id,
    players: `${LEFT!.nickname} vs ${RIGHT!.nickname}`,
    at: new Date().toISOString(),
    reason: "decided by 0.4s, 7:52",
  });
  writeFileSync(
    path.join(media, ".fast-track.json"),
    JSON.stringify({ lastDate: new Date().toISOString().slice(0, 10), hits: fastTrackHits }),
  );
  const videoId = opts.videoId ?? `vid-${id}`;
  const privacyStatus = opts.privacyStatus ?? "private";
  await writeUpload(
    id,
    {
      videoId,
      uploadedAt: new Date().toISOString(),
      publishAt: opts.publishAt,
      privacyStatus,
      thumbnailVariant: null,
      title: `A HOOK | ${LEFT!.nickname} vs ${RIGHT!.nickname} | MCSR Ranked 1v1`,
    },
    "video",
  );
  ytVideos.set(videoId, { channelId: config.youtubeChannelId, privacyStatus, publishAt: opts.publishAt });
  return videoId;
}

const tgSent = (method: string) => tgCalls.filter((c) => c.method === method);
const callbackUpdate = (chatId: number, messageId: number, data: string, id = `cb-${Math.random()}`) => ({
  update_id: Math.floor(Math.random() * 1e9),
  callback_query: {
    id,
    from: { id: chatId },
    message: { message_id: messageId, chat: { id: chatId } },
    data,
  },
});

try {
  /* --- 1. The message is sent once, with the photo and the link --------------------------------- */
  const A = 30_000_001;
  await readyFastTrack(A, { publishAt: new Date(Date.now() + 40 * 3600_000).toISOString() });
  await fastTrackAsk.sendFastTrackAsk(A);
  await fastTrackAsk.sendFastTrackAsk(A); // a second call (what the hook firing twice would do) must not resend
  const photos = tgSent("sendPhoto");
  assert.equal(photos.length, 1, "exactly one ask sent");
  const sentA = photos[0]!;
  assert.equal(sentA.body?.chat_id, CHAT);
  assert.equal(sentA.body?.photo, "<blob>", "the splits still is attached as the photo");
  const caption = String(sentA.body?.caption);
  assert.match(caption, /decided by 0\.4s, 7:52/, "the fast-track reason is shown");
  assert.match(
    caption,
    /magmamcsr\.com\/ranked\/player\/.*\/matches\/30000001/,
    "the magmamcsr match link is shown",
  );
  const keyboardA = JSON.parse(String(sentA.body?.reply_markup)) as InlineKeyboard;
  assert.deepEqual(keyboardA.inline_keyboard, [
    [
      { text: "✅ Post ASAP", callback_data: `f:${A}:y` },
      { text: "❌ Keep its slot", callback_data: `f:${A}:n` },
    ],
  ]);
  const offerA = readTelegramState().fastTrackAsks[String(A)];
  assert.ok(offerA, "the ask is recorded for dedupe");
  console.log("OK: the fast-track ask is sent once, with the splits photo and the match link");

  /* --- 2. A press from any chat but TELEGRAM_CHAT_ID does nothing -------------------------------- */
  {
    const before = tgCalls.length;
    const writesBefore = ytWrites.length;
    await index.handleUpdate(callbackUpdate(9001, offerA!.messageId, `f:${A}:y`));
    assert.equal(tgCalls.length, before, "not one Telegram call for another chat's press");
    assert.equal(ytWrites.length, writesBefore, "and nothing was moved on YouTube");
    const other = callbackUpdate(Number(CHAT), offerA!.messageId, `f:${A}:y`);
    other.callback_query.from.id = 9001;
    await index.handleUpdate(other);
    assert.equal(tgCalls.length, before, "not one Telegram call for another presser either");
    assert.equal(ytWrites.length, writesBefore);
    assert.ok(!readTelegramState().fastTrackAsks[String(A)]?.settled, "and the ask is still open");
    console.log("OK: a press from another chat or another presser does nothing");
  }

  /* --- 3. Yes reschedules only that video, the whole status part sent back ----------------------- */
  {
    // An unrelated already-scheduled match, to prove Yes never touches anyone else's slot.
    const OTHER = 30_000_002;
    const otherPublishAt = new Date(Date.now() + 50 * 3600_000).toISOString();
    const otherVideoId = await readyFastTrack(OTHER, { publishAt: otherPublishAt, videoId: "other-video" });

    const writesBefore = ytWrites.length;
    await index.handleUpdate(callbackUpdate(Number(CHAT), offerA!.messageId, `f:${A}:y`));
    assert.equal(ytWrites.length, writesBefore + 1, "exactly one videos.update");
    const write = ytWrites[ytWrites.length - 1]!;
    assert.equal(write.id, "vid-30000001");
    assert.equal(
      write.status.privacyStatus,
      "private",
      "the whole status part sent back, unchanged fields included",
    );
    assert.equal(write.status.license, "youtube", "a field the ask never touches still rides along");
    const newAt = Date.parse(String(write.status.publishAt));
    assert.ok(newAt > Date.now() && newAt < Date.now() + 25 * 60_000, "moved to about 20 minutes from now");
    assert.equal(
      ytVideos.get(otherVideoId)!.publishAt,
      otherPublishAt,
      "the other match's slot is untouched",
    );

    const edit = tgSent("editMessageCaption").find((c) => c.body?.message_id === offerA!.messageId);
    assert.match(String(edit?.body?.caption), /^Posting at /);
    assert.ok(readTelegramState().fastTrackAsks[String(A)]?.settled, "settled — a second press does nothing");

    const stalePressWrites = ytWrites.length;
    await index.handleUpdate(callbackUpdate(Number(CHAT), offerA!.messageId, `f:${A}:y`));
    assert.equal(ytWrites.length, stalePressWrites, "a stale press moves nothing a second time");
    console.log("OK: Yes reschedules only that video, with the whole status part sent back");
  }

  /* --- 4. Yes on a video due within 2h (or already public) changes nothing ----------------------- */
  {
    const B = 30_000_003;
    const soonAt = new Date(Date.now() + 90 * 60_000).toISOString(); // under 2h away
    await readyFastTrack(B, { publishAt: soonAt });
    await fastTrackAsk.sendFastTrackAsk(B);
    const offerB = readTelegramState().fastTrackAsks[String(B)]!;
    const writesBefore = ytWrites.length;
    await index.handleUpdate(callbackUpdate(Number(CHAT), offerB.messageId, `f:${B}:y`));
    assert.equal(ytWrites.length, writesBefore, "no videos.update for a slot already soon");
    const edit = tgSent("editMessageCaption").find((c) => c.body?.message_id === offerB.messageId);
    assert.equal(edit?.body?.caption, "Already soon/public — nothing changed.");
    assert.ok(readTelegramState().fastTrackAsks[String(B)]?.settled);
    console.log("OK: Yes on a slot already soon (or public) changes nothing, and says so");
  }

  /* --- 5. No changes nothing ---------------------------------------------------------------------- */
  {
    const C = 30_000_004;
    const at = new Date(Date.now() + 40 * 3600_000).toISOString();
    await readyFastTrack(C, { publishAt: at });
    await fastTrackAsk.sendFastTrackAsk(C);
    const offerC = readTelegramState().fastTrackAsks[String(C)]!;
    const writesBefore = ytWrites.length;
    const tgBefore = tgCalls.length;
    await index.handleUpdate(callbackUpdate(Number(CHAT), offerC.messageId, `f:${C}:n`));
    assert.equal(ytWrites.length, writesBefore, "no videos.update");
    assert.ok(tgCalls.length > tgBefore, "but the message is still edited and answered");
    const edit = tgSent("editMessageCaption").find((c) => c.body?.message_id === offerC.messageId);
    assert.ok(edit, "the message was edited");
    assert.match(String(edit?.body?.caption), /^Keeping /);
    assert.ok(readTelegramState().fastTrackAsks[String(C)]?.settled);
    console.log("OK: No changes nothing, and settles the ask");
  }

  console.log("ALL OK: fastTrackAsk.contract.test.ts");
} finally {
  // No real process to clean up — the media dir is a tmp dir the OS reclaims.
}
