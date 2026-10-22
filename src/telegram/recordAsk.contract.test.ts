// Contract test for the record ask (src/telegram/recordAsk.ts; CLAUDE.md "Dashboard" fast-track,
// handbook "Record watch"), driven through the public surface: `sendRecordAsk` (the hook
// fastTrack.ts fires) and a button press via index.ts's `handleUpdate`. Telegram is a stub on
// global fetch; nothing here reaches the network.
//
// Promises:
//  1. The ask reads "Record pace: A vs B, m:ss. Queue it for tonight?" with Queue / Skip.
//  2. A press from any chat or presser but TELEGRAM_CHAT_ID does nothing.
//  3. Queue appends the id to tonight's queue (the dashboard's own `setNightlyQueue`), once.
//  4. Skip leaves the queue alone and marks the id seen.
//  5. "Record" and the run time reach nothing that names a video: only index.ts imports this
//     module, only fastTrack.ts reads `.record-watch.json`, and fastTrack.ts itself is imported by
//     nothing that writes a title, hook, description or model prompt.
// Run: npx tsx src/telegram/recordAsk.contract.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InlineKeyboard } from "./bot.js";

const media = mkdtempSync(path.join(tmpdir(), "tg-record-"));
const TOKEN = "999002:record-test-token";
const CHAT = "42";
process.env.TELEGRAM_BOT_TOKEN = TOKEN;
process.env.TELEGRAM_CHAT_ID = CHAT;

type TgCall = { method: string; body: Record<string, unknown> };
const tgCalls: TgCall[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.telegram.org") throw new Error(`unexpected fetch: ${url}`);
  assert.ok(url.pathname.startsWith(`/bot${TOKEN}/`), "the right token is used");
  tgCalls.push({
    method: url.pathname.split("/").pop()!,
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
}) as typeof fetch;

const { config } = await import("../config.js");
config.mediaDir = media;
const index = await import("./index.js");
const { sendRecordAsk } = await import("./recordAsk.js");
const { readRecordWatch, updateRecordWatch } = await import("../dashboard/fastTrack.js");
const { nightlyQueue, setNightlyQueue } = await import("../dashboard/matchShelf.js");

const press = (data: string, chatId = Number(CHAT), presser = Number(CHAT)) => ({
  update_id: 1,
  callback_query: {
    id: `cb-${data}`,
    from: { id: presser },
    message: { message_id: 7, chat: { id: chatId } },
    data,
  },
});
/** What fastTrack.ts's tick writes once the ask is sent. */
const asked = (id: number) =>
  updateRecordWatch((s) => {
    s.seen[String(id)] = new Date().toISOString();
    s.asks[String(id)] = { at: new Date().toISOString(), label: "Infume vs Feinberg" };
  });

/* --- 1. The ask ------------------------------------------------------------------------------ */
assert.equal(await sendRecordAsk({ matchId: 501, players: ["Infume", "Feinberg"], timeMs: 341_507 }), true);
assert.equal(tgCalls.length, 1);
const sent = tgCalls[0]!;
assert.equal(sent.method, "sendMessage");
assert.equal(sent.body.chat_id, CHAT);
const [line, link] = String(sent.body.text).split("\n");
assert.equal(line, "Record pace: Infume vs Feinberg, 5:41. Queue it for tonight?");
assert.match(link!, /magmamcsr\.com\/ranked\/player\/Infume\/matches\/501$/);
assert.deepEqual((sent.body.reply_markup as InlineKeyboard).inline_keyboard, [
  [
    { text: "Queue", callback_data: "r:501:q" },
    { text: "Skip", callback_data: "r:501:s" },
  ],
]);
console.log("OK: the ask names the pair and the run time, with Queue / Skip");

/* --- 2. Another chat or presser: nothing ----------------------------------------------------- */
asked(501);
setNightlyQueue([900]);
tgCalls.length = 0;
await index.handleUpdate(press("r:501:q", 9001, 9001));
await index.handleUpdate(press("r:501:q", Number(CHAT), 9001));
assert.equal(tgCalls.length, 0, "not one Telegram call");
assert.deepEqual(nightlyQueue(), [900], "nothing queued");
assert.equal(readRecordWatch().asks["501"]!.answer, undefined, "the ask is still open");
console.log("OK: a press from another chat or presser does nothing");

/* --- 3. Queue -------------------------------------------------------------------------------- */
await index.handleUpdate(press("r:501:q"));
assert.deepEqual(nightlyQueue(), [900, 501], "appended behind the operator's own queue");
assert.equal(readRecordWatch().asks["501"]!.answer, "queue");
const edit = tgCalls.find((c) => c.method === "editMessageText");
assert.equal(edit?.body.text, "Infume vs Feinberg: queued for tonight");
assert.deepEqual(edit?.body.reply_markup, { inline_keyboard: [] }, "the buttons are gone");
tgCalls.length = 0;
await index.handleUpdate(press("r:501:q"));
assert.deepEqual(nightlyQueue(), [900, 501], "a stale press queues nothing twice");
assert.deepEqual(
  tgCalls.map((c) => [c.method, c.body.text]),
  [["answerCallbackQuery", "that ask is gone"]],
);
console.log("OK: Queue appends to tonight's queue once");

/* --- 4. Skip --------------------------------------------------------------------------------- */
updateRecordWatch((s) => {
  s.asks["502"] = { at: new Date().toISOString(), label: "Infume vs Feinberg" };
});
await index.handleUpdate(press("r:502:s"));
assert.deepEqual(nightlyQueue(), [900, 501], "Skip queues nothing");
assert.equal(readRecordWatch().asks["502"]!.answer, "skip");
assert.ok("502" in readRecordWatch().seen, "Skip marks it seen");
console.log("OK: Skip leaves the queue alone and marks the id seen");

/* --- 5. Where "record" can travel ------------------------------------------------------------ */
{
  const src = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const files = (readdirSync(src, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => ({ f, text: readFileSync(path.join(src, f), "utf8") }));
  const importing = (re: RegExp) =>
    files
      .filter(({ text }) => re.test(text))
      .map(({ f }) => f)
      .sort();
  assert.deepEqual(importing(/from "\.\/recordAsk\.js"|telegram\/recordAsk\.js"/), ["telegram/index.ts"]);
  assert.deepEqual(importing(/\.record-watch/), ["dashboard/fastTrack.ts"]);
  assert.deepEqual(
    importing(/from "(\.\/|\.\.\/dashboard\/)fastTrack\.js"/),
    ["dashboard/server.ts", "telegram/fastTrackAsk.ts", "telegram/recordAsk.ts"],
    "nothing that writes a title, hook, description or model prompt reads fast-track's reason",
  );
  console.log("OK: only index.ts imports the ask; only fastTrack.ts reads its state");
}

console.log("ALL OK: recordAsk.contract.test.ts");
