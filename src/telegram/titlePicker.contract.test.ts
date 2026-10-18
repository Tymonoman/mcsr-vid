// Contract test for the Telegram title picker (src/telegram/titlePicker.ts; CLAUDE.md "Telegram
// bot", handbook "The title picker"), driven through the public surface: the dashboard tick, a
// button press via index.ts's handleUpdate, the CLI's two helpers, and the auto-hooks edit hook.
// Every API — Telegram, MCSR, YouTube — is a stub on global fetch; `setTitleOptionsImpl` stands
// in for titleOptions.ts, the stub titles/policy replaces (never injected through that stub).
//
// Promises:
//  1. A due match is offered once (thumbnail + caption + buttons); a second tick does not resend.
//  2. A press from any chat but TELEGRAM_CHAT_ID does nothing — no API call, nothing saved.
//  3. A press saves through `saveHooks` exactly as the dashboard's Save would, when the long-form
//     is not yet uploaded; the message is edited to "Saved: …", its buttons gone.
//  4. A press on a match already on the channel retitles it instead: `videos.update` carries the
//     whole snippet back, only the hook half of the title changed.
//  5. "New options" asks `titleOptions` again (`fresh: true`) and edits in the fresh set.
//  6. An auto-hooks save edits the same pending offer to "Auto-saved: …", once.
//  7. A malformed callback (bad data, no message) is answered and otherwise ignored, never thrown.
//  8. `npm run tg -- titles <id>` (sendTitleOfferForce/titleOfferPreview, tgCli.ts's thin wrapper
//     around both) sends the offer regardless of the tick's own dedupe or "due" checks.
// Run: npx tsx src/telegram/titlePicker.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InlineKeyboard } from "./bot.js";

const root = mkdtempSync(path.join(tmpdir(), "tg-titlepicker-"));
const media = path.join(root, "media");
mkdirSync(media);

const TOKEN = "999000:titlepicker-test-token";
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
const ytVideos = new Map<string, { channelId: string; title: string; description: string; tags: string[] }>();
const ytWrites: Array<{ id: string; snippet: Record<string, unknown> }> = [];

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
                snippet: {
                  channelId: v.channelId,
                  title: v.title,
                  description: v.description,
                  categoryId: "20",
                  tags: v.tags,
                },
              },
            ]
          : [],
      });
    }
    const body = JSON.parse(String(init?.body)) as { id: string; snippet: Record<string, unknown> };
    ytWrites.push(body);
    const v = ytVideos.get(body.id);
    if (v) v.title = String(body.snippet.title);
    return json({ id: body.id, snippet: body.snippet });
  }
  if (url.hostname === "api.mcsrranked.com") {
    const ok = (data: unknown) => json({ status: "success", data });
    const m = /^\/matches\/(\d+)$/.exec(url.pathname);
    if (m) return ok(matchOf(Number(m[1])));
    const u = /^\/users\/([^/]+)$/.exec(url.pathname);
    if (u) {
      const p = fixture.players.find((x) => x.uuid === u[1])!;
      return ok({
        uuid: p.uuid,
        nickname: p.nickname,
        eloRate: 2000,
        eloRank: 5,
        country: "us",
        statistics: {},
      });
    }
    return json({ status: "error", data: "not found" });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

/* --- Modules, loaded only now -------------------------------------------------------------------- */
const { config } = await import("../config.js");
config.mediaDir = media;
config.blockedPlayers = ["SyntheticBlockedRunner"];
// `saveHooks` starts the real chain (`startChain`) on its own `liveDeps()` — uploads are already
// off by default, but shortsByHand skips the pick/render step too, so a save here never spawns a
// real `npm run short` child process trying to cut a Short that does not exist.
config.shortsByHand = true;
const bot = await import("./bot.js");
const index = await import("./index.js");
const picker = await import("./titlePicker.js");
const { readTelegramState, updateTelegramState } = await import("./state.js");
const flow = await import("../dashboard/shortFlow.js");
const { writeUpload } = await import("../youtube/youtubeStore.js");
const { metaPaths } = await import("../pipeline/title.js");

const dir = (id: number) => path.join(media, String(id));
const matchDirPath = (id: number) => path.join(media, String(id));

/** A match ready for the picker: a confident sync (so `syncWeak` passes), a readable pick, a
 *  thumbnail — the same three things `dueForTitleOffer` reads, nothing `exported()` in
 *  shortFlow.test.ts also writes but the picker never looks at. */
function readyMatch(id: number): void {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(
    path.join(dir(id), "sync.json"),
    JSON.stringify({ left: 150, right: 150, confidence: 1, detail: "", source: "detected" }),
  );
  writeFileSync(
    path.join(dir(id), `short-${id}.pick.json`),
    JSON.stringify({
      gameMatchId: id,
      startMs: 300_000,
      endMs: 330_000,
      pov: "both",
      hookSuggestion: "a stand-in",
      why: "a stand-in",
      kind: "play",
      source: "agy",
      createdAt: new Date().toISOString(),
    }),
  );
  writeFileSync(path.join(dir(id), "thumbnail.png"), "not a real png, just needs to exist");
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
  /* --- 1. A due match is offered once; a second tick does not resend ---------------------------- */
  const A = 20_000_001;
  readyMatch(A);
  picker.setTitleOptionsImpl(async (_id, opts) => {
    const options = opts?.fresh ? ["FRESH ONE", "FRESH TWO"] : ["OPTION ONE", "OPTION TWO", "OPTION THREE"];
    return {
      options,
      source: options.map(() => "chip" as const),
      styles: options.map(() => "setting" as const),
    };
  });
  await picker.titleOfferTick();
  const photosAfterFirst = tgSent("sendPhoto");
  assert.equal(photosAfterFirst.length, 1, "exactly one offer sent");
  const sentA = photosAfterFirst[0]!;
  assert.equal(sentA.body?.chat_id, CHAT);
  const keyboardA = JSON.parse(String(sentA.body?.reply_markup)) as InlineKeyboard;
  assert.equal(keyboardA.inline_keyboard.length, 4, "3 options + New options");
  assert.deepEqual(
    keyboardA.inline_keyboard.map((row) => row[0]!.text),
    ["OPTION ONE", "OPTION TWO", "OPTION THREE", "🔄 New options"],
  );
  const offerA = readTelegramState().titleOffers[String(A)];
  assert.ok(offerA, "the offer is recorded for dedupe and for the button press to read back");
  assert.deepEqual(offerA!.options, ["OPTION ONE", "OPTION TWO", "OPTION THREE"]);

  await picker.titleOfferTick();
  assert.equal(tgSent("sendPhoto").length, 1, "a second tick does not resend an already-offered match");
  console.log("OK: a due match is offered once, with its options and New options as buttons");

  /* --- 2. A press from any chat but TELEGRAM_CHAT_ID does nothing ------------------------------- */
  {
    const before = tgCalls.length;
    await index.handleUpdate(callbackUpdate(9001, offerA!.messageId, `t:${A}:0`));
    assert.equal(tgCalls.length, before, "not one Telegram call for another chat's press");
    assert.ok(!flow.readStatus(A).hooksSavedAt, "nothing was saved");
    // Someone else pressing inside the operator's chat (a group, a forwarded message) is ignored too.
    const other = callbackUpdate(Number(CHAT), offerA!.messageId, `t:${A}:0`);
    other.callback_query.from.id = 9001;
    await index.handleUpdate(other);
    assert.equal(tgCalls.length, before, "not one Telegram call for another presser");
    assert.ok(!flow.readStatus(A).hooksSavedAt, "nothing was saved");
    console.log("OK: a press from another chat or another presser does nothing");
  }

  /* --- 3. A press saves through saveHooks (not yet uploaded) ------------------------------------- */
  {
    await index.handleUpdate(callbackUpdate(Number(CHAT), offerA!.messageId, `t:${A}:0`));
    const status = flow.readStatus(A);
    assert.ok(status.hooksSavedAt, "the hooks were saved");
    const edited = readFileSync(metaPaths(A, "title").edited, "utf8");
    assert.match(edited, /^OPTION ONE \| /, "the pressed option is the title hook");
    const edits = tgSent("editMessageCaption");
    const mine = edits.find((c) => c.body?.message_id === offerA!.messageId);
    assert.ok(mine, "the message was edited");
    assert.equal(mine!.body?.caption, "Saved: OPTION ONE");
    assert.deepEqual(mine!.body?.reply_markup, { inline_keyboard: [] }, "the buttons are gone");
    assert.ok(
      tgSent("answerCallbackQuery").some((c) => c.body?.text === "saved"),
      "the loading spinner was answered",
    );
    assert.ok(readTelegramState().titleOffers[String(A)]?.settled, "the offer is settled");
    console.log("OK: a press saves the hooks exactly as the dashboard's Save would, and settles the offer");
  }

  /* --- 4. A press on a match already on the channel retitles it instead -------------------------- */
  {
    const B = 20_000_002;
    mkdirSync(dir(B), { recursive: true });
    const videoId = "LivEVidId01";
    ytVideos.set(videoId, {
      channelId: config.youtubeChannelId,
      title: `OLD HOOK | ${LEFT!.nickname} vs ${RIGHT!.nickname} | MCSR Ranked 1v1`,
      description: "the live description, untouched",
      tags: ["old tag"],
    });
    await writeUpload(
      B,
      {
        videoId,
        uploadedAt: new Date().toISOString(),
        publishAt: new Date(Date.now() + 36e5).toISOString(),
        privacyStatus: "private",
        thumbnailVariant: null,
        title: `OLD HOOK | ${LEFT!.nickname} vs ${RIGHT!.nickname} | MCSR Ranked 1v1`,
      },
      "video",
    );
    const messageId = 5555;
    updateTelegramState((s) => {
      s.titleOffers[String(B)] = {
        messageId,
        options: ["A FRESH TITLE"],
        source: ["chip"],
        at: new Date().toISOString(),
      };
    });
    const writesBefore = ytWrites.length;
    await index.handleUpdate(callbackUpdate(Number(CHAT), messageId, `t:${B}:0`));
    assert.equal(ytWrites.length, writesBefore + 1, "one videos.update");
    const write = ytWrites[ytWrites.length - 1]!;
    assert.equal(write.id, videoId);
    assert.equal(
      write.snippet.title,
      `A FRESH TITLE | ${LEFT!.nickname} vs ${RIGHT!.nickname} | MCSR Ranked 1v1`,
    );
    assert.equal(write.snippet.description, "the live description, untouched", "description sent back whole");
    assert.deepEqual(write.snippet.tags, ["old tag"], "tags sent back whole");
    const edit = tgSent("editMessageCaption").find((c) => c.body?.message_id === messageId);
    assert.equal(
      edit?.body?.caption,
      `Saved: ${write.snippet.title}`,
      "the message shows the new whole title",
    );
    const editedFile = readFileSync(metaPaths(B, "title").edited, "utf8");
    assert.match(editedFile, /^A FRESH TITLE \|/, "the local title file agrees with the channel");
    console.log("OK: a press on an uploaded video retitles it, sending the whole snippet back");
  }

  /* --- 5. "New options" asks again with fresh: true and edits in the new set --------------------- */
  {
    const C = 20_000_003;
    readyMatch(C);
    await picker.titleOfferTick();
    const offerC = readTelegramState().titleOffers[String(C)]!;
    assert.deepEqual(offerC.options, ["OPTION ONE", "OPTION TWO", "OPTION THREE"]);
    await index.handleUpdate(callbackUpdate(Number(CHAT), offerC.messageId, `t:${C}:r`));
    const edit = tgSent("editMessageCaption").find((c) => c.body?.message_id === offerC.messageId);
    assert.ok(edit, "the message was edited with the fresh options");
    const keyboard = edit!.body?.reply_markup as InlineKeyboard;
    assert.deepEqual(
      keyboard.inline_keyboard.map((r) => r[0]!.text),
      ["FRESH ONE", "FRESH TWO", "🔄 New options"],
    );
    assert.deepEqual(readTelegramState().titleOffers[String(C)]?.options, ["FRESH ONE", "FRESH TWO"]);
    assert.ok(!readTelegramState().titleOffers[String(C)]?.settled, "a refresh never settles the offer");
    console.log('OK: "New options" asks titleOptions again with fresh: true and edits in the new set');
  }

  /* --- 6. An auto-hooks save edits the same pending offer, once ---------------------------------- */
  {
    const D = 20_000_004;
    mkdirSync(dir(D), { recursive: true });
    const messageId = 7777;
    updateTelegramState((s) => {
      s.titleOffers[String(D)] = {
        messageId,
        options: ["X"],
        source: ["chip"],
        at: new Date().toISOString(),
      };
    });
    const before = tgSent("editMessageCaption").length;
    await picker.onAutoHooksSaved(D, "AUTO HOOK TEXT");
    const edits = tgSent("editMessageCaption").slice(before);
    assert.equal(edits.length, 1);
    assert.equal(edits[0]!.body?.caption, "Auto-saved: AUTO HOOK TEXT");
    assert.deepEqual(edits[0]!.body?.reply_markup, { inline_keyboard: [] });
    assert.ok(readTelegramState().titleOffers[String(D)]?.settled);

    // A second auto-save (or a race with the operator's own press) must not edit it again.
    await picker.onAutoHooksSaved(D, "A DIFFERENT HOOK");
    assert.equal(tgSent("editMessageCaption").length, before + 1, "settled once, never edited twice");
    console.log("OK: an auto-hooks save edits the pending offer to Auto-saved, once");
  }

  /* --- 7. A malformed callback is answered and otherwise ignored, never thrown ------------------- */
  {
    await assert.doesNotReject(picker.handleTitleCallback({ id: "bad1", from: { id: 42 }, data: "garbage" }));
    await assert.doesNotReject(
      picker.handleTitleCallback({
        id: "bad2",
        from: { id: 42 },
        message: { message_id: 1, chat: { id: 42 } },
        data: `t:999999999:9`, // a match with no pending offer at all
      }),
    );
    await assert.doesNotReject(picker.handleTitleCallback({ id: "bad3", from: { id: 42 } })); // no data, no message
    assert.ok(
      tgSent("answerCallbackQuery").some((c) => c.body?.callback_query_id === "bad1"),
      "even a bad payload gets its spinner cleared",
    );
    console.log("OK: a malformed callback is answered safely, never thrown");
  }

  /* --- 8. The CLI's two helpers ignore the tick's dedupe and "due" checks ----------------------- */
  {
    const E = 20_000_005;
    // None of dueForTitleOffer's prerequisites (a pick, a sound sync) — only the thumbnail
    // sendTitleOffer itself checks for — and E was never offered, so there is nothing to dedupe
    // against either; sendTitleOfferForce must not care about either kind of gate.
    mkdirSync(dir(E), { recursive: true });
    writeFileSync(path.join(dir(E), "thumbnail.png"), "x");
    const before = tgSent("sendPhoto").length;
    await picker.sendTitleOfferForce(E);
    assert.equal(tgSent("sendPhoto").length, before + 1, "sent despite no pick and no sync.json");
    assert.ok(
      readTelegramState().titleOffers[String(E)],
      "and it is now recorded, same as a tick's own offer",
    );

    const preview = await picker.titleOfferPreview(E);
    assert.match(preview, /FRESH ONE/, "the caption and the options, as --dry-run prints them");
    assert.match(preview, /#match=20000005/, "and the match link");
    assert.equal(tgSent("sendPhoto").length, before + 1, "a preview sends nothing");
    console.log("OK: the CLI's titles command bypasses both the dedupe and the due checks");
  }

  console.log("titlePicker.contract: all checks passed");
} finally {
  // No rmSync of root on purpose would be fine too, but tidy up like the other contract tests do.
  const { rmSync } = await import("node:fs");
  rmSync(root, { recursive: true, force: true });
}
