// The growth line (src/telegram/growthLine.ts): the line's text from fixed numbers; once per
// Warsaw date from the report hour + 10 min, silent, under a More button; the first run only
// saves a baseline; an unreadable count sends nothing and logs once; "best" is the fresh
// long-form that grew most (old, private and blocked videos never count). The More button:
// another chat or presser gets "that button isn't yours", a second press "already sent", a line
// over 7 days old "expired". `growthLine` is a file-only boolean, on. Telegram is a stub on
// global fetch that never leaves the process; every YouTube read is a dep.
// Run: npx tsx src/telegram/growthLine.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { VideoStats } from "../youtube/youtube.js";
import type { UploadRecord } from "../youtube/youtubeStore.js";

process.env.TELEGRAM_BOT_TOKEN = "999003:growth-test";
process.env.TELEGRAM_CHAT_ID = "42";
const tg: Array<{ method: string; body: Record<string, unknown> }> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.telegram.org") throw new Error(`unexpected fetch: ${url.hostname}`);
  tg.push({ method: url.pathname.split("/").pop()!, body: JSON.parse(String(init?.body)) });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
}) as typeof fetch;

const { config, DEFAULTS } = await import("../config.js");
const media = mkdtempSync(path.join(tmpdir(), "tg-growth-"));
config.mediaDir = media;
const { growthLineDue, growthLineText, growthLineTick, handleGrowthCallback } =
  await import("./growthLine.js");
const { handleUpdate } = await import("./index.js");
const { readTelegramState } = await import("./state.js");

const at = (iso: string) => Date.parse(iso);
const record = (videoId: string, title: string, publishAt: string): UploadRecord => ({
  videoId,
  uploadedAt: "2026-10-15T00:00:00Z",
  publishAt,
  privacyStatus: "private",
  thumbnailVariant: null,
  title,
});
const uploads = [
  record("aaa", "WHO BLINKS | Pinne vs lowk3y_ | MCSR Ranked", "2026-10-20T17:00:00Z"),
  record("bbb", "THE GAMBLE | doogile vs Feinberg", "2026-10-21T17:00:00Z"),
  record("ccc", "ONE PEARL | Infume vs edcr", "2026-10-19T17:00:00Z"),
  record("ddd", "LATE | silverrruns vs Infume", "2026-10-21T18:00:00Z"),
  record("old", "OLD | A vs B", "2026-10-10T17:00:00Z"),
  record("blk", "HOOK | Aquacorde vs B", "2026-10-21T17:00:00Z"),
  record("prv", "SOON | C vs D", "2026-10-25T17:00:00Z"),
].map((r, i) => ({ matchId: i + 1, record: r }));

// Lifetime views per reading; a video not public yet at a reading is private.
let views: Record<string, number> = {};
let channel = { subscribers: 412, views: 60_000, videos: 69 };
let now = at("2026-10-21T05:15:00Z"); // 07:15 Warsaw
let failChannel = false;
let statsFail = false;
const deps = {
  channel: async () => {
    if (failChannel) throw new Error("quotaExceeded");
    return channel;
  },
  uploads: async () => uploads,
  stats: async (ids: string[]): Promise<VideoStats[]> =>
    ids.map((id) => {
      const r = uploads.find((u) => u.record.videoId === id)!.record;
      return {
        videoId: id,
        title: r.title,
        publishedAt: "2026-10-15T00:00:00Z",
        privacyStatus: Date.parse(r.publishAt!) <= now ? "public" : "private",
        publishAt: r.publishAt,
        views: views[id] ?? 0,
        likes: 0,
        comments: 0,
        duration: "PT10M",
      };
    }),
  statsText: async () => {
    if (statsFail) throw new Error("Analytics: 503");
    return "STATS-7D";
  },
  now: () => now,
};
const errors: string[] = [];
console.error = (...a: unknown[]) => void errors.push(a.join(" "));
const sends = () => tg.filter((c) => c.method === "sendMessage");

try {
  /* --- config: file-only boolean, on ------------------------------------------------------- */
  assert.equal(DEFAULTS.growthLine, true);
  const example = JSON.parse(readFileSync(path.join(process.cwd(), "mcsr-vid.config.example.json"), "utf8"));
  assert.equal(example.growthLine, true, "npm run config:example carries the key");
  const settingsSrc = readFileSync(path.join(process.cwd(), "src/dashboard/settings.ts"), "utf8");
  assert.ok(!settingsSrc.includes('"growthLine"'), "not writable from the Settings tab");

  /* --- the line's text from fixed numbers -------------------------------------------------- */
  const live = { subscribers: 1415, views: 61_240, videos: 70 };
  const best = { videoId: "v1", title: "A & B | x vs y", views: 1310 };
  assert.equal(
    growthLineText(live, { subscribers: 1412, views: 60_000, videos: 69 }, "yesterday", best),
    '+3 subs yesterday (1,415 total) · 1,240 views · best: <a href="https://studio.youtube.com/video/v1/analytics/tab-overview/period-default">A &amp; B | x vs y</a> (1,310)',
  );
  assert.equal(
    growthLineText(live, { subscribers: 1416, views: 61_240, videos: 70 }, "since 2026-10-19", undefined),
    "-1 subs since 2026-10-19 (1,415 total) · 0 views",
  );

  /* --- due: report hour + 10 min, for three hours ------------------------------------------ */
  assert.equal(growthLineDue(at("2026-10-22T05:09:00Z"), 7), false, "07:09 Warsaw");
  assert.equal(growthLineDue(at("2026-10-22T05:10:00Z"), 7), true, "07:10 Warsaw");
  assert.equal(growthLineDue(at("2026-10-22T07:59:00Z"), 7), true, "09:59 Warsaw");
  assert.equal(growthLineDue(at("2026-10-22T08:00:00Z"), 7), false, "10:00 Warsaw");
  assert.equal(growthLineDue(at("2026-10-26T06:10:00Z"), 7), true, "07:10 Warsaw in CET");

  /* --- off, or not due: nothing read, nothing sent ----------------------------------------- */
  config.growthLine = false;
  await growthLineTick(deps);
  config.growthLine = true;
  now = at("2026-10-21T05:05:00Z");
  await growthLineTick(deps);
  assert.equal(readTelegramState().growthLine, null);

  /* --- day 1: the first run only saves a baseline ------------------------------------------ */
  now = at("2026-10-21T05:15:00Z");
  views = { aaa: 100, ccc: 50, old: 9000, blk: 4000 };
  await growthLineTick(deps);
  assert.equal(sends().length, 0, "no line without a previous reading");
  assert.deepEqual(readTelegramState().growthLine, {
    date: "2026-10-21",
    snapshot: { subscribers: 412, views: 60_000, videos: 69 },
    videoViews: { aaa: 100, ccc: 50 },
    lines: {},
  });

  /* --- day 2: one silent line under a More button; once ------------------------------------ */
  now = at("2026-10-22T05:15:00Z");
  channel = { subscribers: 415, views: 61_240, videos: 70 };
  // aaa has more views in all, bbb (public since day 1's reading) gained more since.
  views = { aaa: 400, bbb: 350, ccc: 60, ddd: 5, old: 9999, blk: 5000 };
  await growthLineTick(deps);
  now += 15 * 60_000;
  await growthLineTick(deps);
  assert.equal(sends().length, 1, "once per Warsaw date");
  const line = sends()[0]!.body;
  assert.equal(
    line.text,
    '+3 subs yesterday (415 total) · 1,240 views · best: <a href="https://studio.youtube.com/video/bbb/analytics/tab-overview/period-default">THE GAMBLE | doogile vs Feinberg</a> (350)',
  );
  assert.equal(line.disable_notification, true, "delivered silently");
  assert.deepEqual(line.reply_markup, {
    inline_keyboard: [[{ text: "More", callback_data: "g:more:2026-10-22" }]],
  });
  assert.deepEqual(
    readTelegramState().growthLine!.lines["2026-10-22"]!.top.map((v) => [v.videoId, v.views]),
    [
      ["bbb", 350],
      ["aaa", 300],
      ["ccc", 10],
    ],
    "top 3 by views since the last line; old, private and blocked never count",
  );

  /* --- an unreadable count sends nothing, logs once, and the next tick tries again --------- */
  now = at("2026-10-23T05:15:00Z");
  failChannel = true;
  await growthLineTick(deps);
  now += 15 * 60_000;
  await growthLineTick(deps);
  assert.equal(sends().length, 1);
  assert.equal(errors.filter((e) => e.includes("numbers unreadable")).length, 1, "logged once");
  failChannel = false;
  channel = { subscribers: 420, views: 62_000, videos: 70 };
  await growthLineTick(deps);
  assert.equal(sends().length, 2);
  assert.match(String(sends()[1]!.body.text), /^\+5 subs yesterday \(420 total\) · 760 views · best: /);

  /* --- a missed day says since when -------------------------------------------------------- */
  now = at("2026-10-25T06:15:00Z"); // 07:15 Warsaw, CET from today
  await growthLineTick(deps);
  assert.match(String(sends()[2]!.body.text), /^\+0 subs since 2026-10-23 \(420 total\)/);

  /* --- More: the gate ---------------------------------------------------------------------- */
  const press = (chat: number, presser: number, data: string) => ({
    update_id: 1,
    callback_query: { id: "cq", from: { id: presser }, message: { message_id: 1, chat: { id: chat } }, data },
  });
  for (const [chat, presser] of [
    [7, 7],
    [42, 7],
  ] as const) {
    tg.length = 0;
    await handleUpdate(press(chat, presser, "g:more:2026-10-22"));
    assert.deepEqual(tg, [
      { method: "answerCallbackQuery", body: { callback_query_id: "cq", text: "that button isn't yours" } },
    ]);
  }
  tg.length = 0;
  await handleUpdate(press(42, 42, "g:more:2026-01-01"));
  assert.deepEqual(
    tg.map((c) => [c.method, c.body.text]),
    [["answerCallbackQuery", "that button has expired"]],
    "the operator's press reaches the handler; a line not on file has expired",
  );

  /* --- More: the reply, then "already sent" ------------------------------------------------ */
  const cq = (date: string) => ({ id: "cq", from: { id: 42 }, data: `g:more:${date}` });
  tg.length = 0;
  await handleGrowthCallback(cq("2026-10-22"), deps);
  assert.deepEqual(
    tg.map((c) => c.method),
    ["answerCallbackQuery", "sendMessage"],
  );
  const more = String(tg[1]!.body.text);
  assert.match(
    more,
    /^STATS-7D\n\n<b>Top long-forms, yesterday<\/b>\n1\. <a href="[^"]+\/video\/bbb\/[^"]+">THE GAMBLE \| doogile vs Feinberg<\/a> — 350 views\n2\. .*aaa.* — 300 views\n3\. .*ccc.* — 10 views$/,
  );
  tg.length = 0;
  await handleGrowthCallback(cq("2026-10-22"), deps);
  assert.deepEqual(
    tg.map((c) => [c.method, c.body.text]),
    [["answerCallbackQuery", "already sent"]],
  );

  /* --- More: a failed stats read can be pressed again -------------------------------------- */
  statsFail = true;
  tg.length = 0;
  await handleGrowthCallback(cq("2026-10-23"), deps);
  assert.match(String(sends()[0]!.body.text), /^More failed: /);
  statsFail = false;
  tg.length = 0;
  await handleGrowthCallback(cq("2026-10-23"), deps);
  assert.match(String(sends()[0]!.body.text), /^STATS-7D/);

  /* --- More: over 7 days old has expired --------------------------------------------------- */
  now = at("2026-11-01T09:00:00Z");
  tg.length = 0;
  await handleGrowthCallback(cq("2026-10-25"), deps);
  assert.equal(sends().length, 1, "7 days old still answers");
  tg.length = 0;
  await handleGrowthCallback(cq("2026-10-23"), deps);
  assert.deepEqual(
    tg.map((c) => [c.method, c.body.text]),
    [["answerCallbackQuery", "that button has expired"]],
  );

  console.log("growthLine.test.ts: ok");
} finally {
  rmSync(media, { recursive: true, force: true });
}
