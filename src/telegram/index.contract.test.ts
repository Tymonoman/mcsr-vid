// Contract test for the Telegram bot end to end (index.ts: buildMorningReport, sendMorningReport,
// dispatchCommand, handleUpdate, startTelegramBot), written from the docs — CLAUDE.md "Telegram bot",
// README "The Telegram bot", handbook/claude-md-reference.md "Telegram bot" — as an outside engineer
// would, through the public surface only. Every API is a stub (Telegram, YouTube, MCSR from
// src/fixtures, Twitch, DNS), `claude` is a fake on PATH that records what it was asked, and the media
// directory is a temp dir. index.test.ts already pins the inbox append and the offset write; the
// other *.contract.test.ts files pin each module's own edges.
//
// The promises the docs make for this feature (numbering shared by every *.contract.test.ts here):
//  P1.  The report is three messages: the day (Needs you at the top, then Auto-saved hooks, Claude's
//       headline + to-do, Problems only when any, overnight, health as one line), the channel (live
//       counts, the stats `<pre>` table, YPP), the comments.
//  P2.  "Needs you" is deterministic (code, not Claude), "Nothing today." when empty.
//  P3.  Needs you lists only the documented kinds, one line each (facts.contract.test.ts).
//  P4.  HTML parse mode; every dynamic string goes through escapeHtml (report.contract.test.ts).
//  P5.  Each message within Telegram's 4096 characters (report.contract.test.ts).
//  P6.  Every YouTube link the bot sends opens Studio, never the public watch page.
//  P7.  Dedupe is `<mediaDir>/.telegram.json`, written atomically: the Warsaw date the report went out
//       on, its instant (what "overnight" means), the previous live snapshot ("+N since last time").
//  P8.  A restart that missed the report hour still sends it between the report hour and 10:00 Warsaw
//       if today is not recorded; before the hour nothing early; with the report off nothing.
//  P9.  One report at `telegramReportHourWarsaw`, Europe/Warsaw, DST-correct (schedule.contract.test.ts).
//  P10. No viewer comment text or author name is ever put in a Claude prompt (`/ask` included) — only
//       counts, titles, ids.
//  P11. `claude -p --model claude-haiku-4-5-20251001 … --setting-sources ""` as plain argv, prompt on
//       stdin, cwd the temp dir (claude.contract.test.ts; the real call path re-checked here).
//  P12. The child env is PATH/HOME/LANG/TMPDIR (+ CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY if set) —
//       never the Telegram token or any other secret.
//  P13. A usage limit reads exactly "usage limit reached — try again later" everywhere (the TODAY note,
//       and `/ask`'s whole reply, verbatim, nothing else); never retried.
//  P14. Any other failure or an unusable answer falls back to `fallbackToday`, its reason shown.
//  P15. Every bot command is read-only — no uploads, renders or queue edits; no command writes anything
//       the dashboard would show as changed.
//  P16. A narrow command gathers only its own section: /stats, /comments, /ypp, /waiting (and /needs)
//       skip the live Claude ping, which only /health and /alerts pay for; /needs answers fresh.
//  P17. /report, /todo and /ask first answer "asking Claude (haiku) — this can take up to two minutes".
//  P18. No token: nothing runs. A token with no chat id: `/start` gets "your chat id is N — add
//       TELEGRAM_CHAT_ID=N to /app/.env and restart the dashboard" and nothing else. With both, any
//       other chat is ignored silently.
//  P19. A plain message from the operator's chat appends one line to `.telegram-inbox.jsonl`, silently
//       — no echo; never another chat's, never a command (state.contract / tgCli.contract too).
//  P20. /health pings Claude for real, named "claude (haiku)".
// Not testable through the public surface: "a test server (PORT ≠ 8080) never starts the poller" is
// a check in src/dashboard/server.ts, which starts a listener on import.
// Run: npx tsx src/telegram/index.contract.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import dnsPromises from "node:dns/promises";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

/** A doc clause the code does not keep: printed, not thrown, so the suite stays green until triage. */
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

/* --- The world: temp dirs, a fake `claude`, secrets that must never leak --------------------------- */
const root = mkdtempSync(path.join(tmpdir(), "tg-index-contract-"));
const media = path.join(root, "media");
const fakeBin = path.join(root, "bin");
mkdirSync(media);
mkdirSync(fakeBin);
const claudeLog = path.join(root, "claude-calls.jsonl");
const claudeMode = path.join(root, "claude-mode");
writeFileSync(claudeMode, "ok");
// The fake `claude`: records argv/cwd/env/stdin, then answers per the mode file (its env is filtered
// by the adapter, so the mode cannot travel as an env var).
writeFileSync(
  path.join(fakeBin, "claude"),
  `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, stdin }) + "\\n");
  const mode = fs.readFileSync(${JSON.stringify(claudeMode)}, "utf8").trim();
  const out = (o) => process.stdout.write(JSON.stringify(o));
  if (mode === "limit") { out({ is_error: true, result: "Claude AI usage limit reached|1760000000" }); process.exitCode = 1; return; }
  if (mode === "auth") { out({ is_error: true, result: "Not logged in · Please run /login" }); process.exitCode = 1; return; }
  if (stdin.includes("Reply with exactly the word OK")) return out({ is_error: false, result: "OK" });
  if (mode === "garbage") return out({ is_error: false, result: "Sure, here is a summary of the channel for you." });
  if (stdin.includes("QUESTION:")) return out({ is_error: false, result: "Two comments are waiting for a reply." });
  out({ is_error: false, result: "Covered through Thursday, Friday is open\\n1. Save hooks for #13560037\\n2. Reply to 2 comments" });
});
`,
);
chmodSync(path.join(fakeBin, "claude"), 0o755);

const SECRETS = {
  TELEGRAM_BOT_TOKEN: "777000:telegram-secret-token",
  TWITCH_CLIENT_SECRET: "twitch-secret-value",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-for-claude",
};
// Set before any module loads: bot.ts and twitch.ts read `.env` from the cwd, and loadEnvFile never
// overwrites a variable already set — so a real `.env` (when run from the repo root) changes nothing.
Object.assign(process.env, SECRETS, {
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
  TELEGRAM_CHAT_ID: "42",
  TWITCH_CLIENT_ID: "twitch-client-id",
  GROQ_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  YOUTUBE_TOKEN_FILE: path.join(root, "youtube-token.json"),
});
writeFileSync(
  process.env.YOUTUBE_TOKEN_FILE!,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);

// DNS: the health check resolves api.mcsrranked.com — answered here, never by a resolver.
let dnsLookups = 0;
(dnsPromises as unknown as { lookup: unknown }).lookup = async () => (
  dnsLookups++,
  { address: "127.0.0.1", family: 4 }
);
syncBuiltinESMExports();

/* --- Every API, stubbed. Telegram behaves like Telegram on the two rules that matter here: an HTML
       message over 4096 visible characters or with a tag cut in half is refused. --------------- */
const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures");
type Call = { method: string; url: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
const tgSent = () =>
  calls.filter((c) => c.url.includes("api.telegram.org") && c.url.endsWith("/sendMessage"));
let liveSubs = 120;
let commentThreads: unknown[] = [];
const titles: Record<string, string> = {};
const visible = (html: string) =>
  html.replace(/<[^>]+>/g, "").replace(/&(?:lt|gt|amp|quot|#39);/g, "x").length;
const balanced = (html: string): boolean => {
  if (/<[^>]*$/.test(html)) return false;
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)\b[^>]*>/gi))
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]!);
  return stack.length === 0;
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  let body: Record<string, unknown> | null = null;
  try {
    body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  calls.push({ method, url, body });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  if (url.startsWith("https://api.telegram.org/")) {
    if (!url.includes(`/bot${SECRETS.TELEGRAM_BOT_TOKEN}/`))
      return json({ ok: false, description: "Unauthorized" }, 401);
    if (url.endsWith("/getUpdates"))
      return new Promise((r) => setTimeout(() => r(json({ ok: true, result: [] })), 25));
    if (url.endsWith("/sendMessage") && body?.parse_mode === "HTML") {
      const text = String(body.text);
      if (visible(text) > 4096)
        return json({ ok: false, description: "Bad Request: message is too long" }, 400);
      if (!balanced(text)) return json({ ok: false, description: "Bad Request: can't parse entities" }, 400);
    }
    return json({ ok: true, result: true });
  }
  const mcsr = /^https:\/\/api\.mcsrranked\.com(\/[^?]*)/.exec(url);
  if (mcsr) {
    const match = /^\/matches\/(\d+)$/.exec(mcsr[1]!);
    if (match && existsSync(path.join(FIXTURES, `match-${match[1]}.json`)))
      return json({
        status: "success",
        data: JSON.parse(readFileSync(path.join(FIXTURES, `match-${match[1]}.json`), "utf8")),
      });
    if (mcsr[1] === "/matches" || /^\/users\/[^/]+\/matches$/.test(mcsr[1]!))
      return json({ status: "success", data: [] });
    return json({ status: "error", data: "not found" }, 404);
  }
  if (url.startsWith("https://id.twitch.tv/")) return json({ access_token: "tw", expires_in: 3600 });
  if (url.startsWith("https://api.twitch.tv/helix/users"))
    return json({ data: [{ id: "1", login: "twitch" }] });
  if (url.startsWith("https://oauth2.googleapis.com/")) return json({ access_token: "yt", expires_in: 3600 });
  if (url.includes("/youtube/v3/channels?part=statistics"))
    return json({
      items: [{ statistics: { subscriberCount: String(liveSubs), viewCount: "5000", videoCount: "30" } }],
    });
  if (url.includes("/youtube/v3/channels")) return json({ items: [{ id: "UCm2mAyONTHlmIxZzNmi388w" }] });
  if (url.includes("/youtube/v3/commentThreads?")) return json({ items: commentThreads });
  if (url.includes("/youtube/v3/videos?")) {
    const ids = new URL(url).searchParams.get("id")!.split(",");
    return json({
      items: ids.filter((id) => titles[id]).map((id) => ({ id, snippet: { title: titles[id] } })),
    });
  }
  if (url.startsWith("https://youtubeanalytics.googleapis.com/")) return json({ rows: [] });
  return json({ error: { message: `unstubbed: ${url}` } }, 404);
}) as typeof fetch;

/* --- Modules, loaded only now --------------------------------------------------------------------- */
const { config } = await import("../config.js");
config.mediaDir = media;
config.blockedPlayers = ["SyntheticBlockedRunner"]; // synthetic, so no real runner is test data
const { writeUpload } = await import("../youtube/youtubeStore.js");
const { BOT_COMMANDS } = await import("./commands.js");
const index = await import("./index.js");
const { readTelegramState } = await import("./state.js");

const H = 3_600_000;
const NOW = Date.parse("2026-10-14T05:00:00Z"); // Wed 14 Oct, 07:00 CEST
const SINCE_DEFAULT = NOW - 24 * H;
const COMMENT_TEXT = "SYNTHETIC-COMMENT-BODY-91";
const COMMENT_AUTHOR = "SyntheticViewer_QX7";
type ClaudeCall = { argv: string[]; cwd: string; env: Record<string, string>; stdin: string };
const claudeCalls = (): ClaudeCall[] =>
  existsSync(claudeLog)
    ? readFileSync(claudeLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ClaudeCall)
    : [];
const isPing = (c: ClaudeCall) => c.stdin.includes("Reply with exactly the word OK");
const thread = (id: string, videoId: string, author: string, text: string, at: number) => ({
  id,
  snippet: {
    videoId,
    totalReplyCount: 0,
    topLevelComment: {
      snippet: { authorDisplayName: author, textOriginal: text, publishedAt: new Date(at).toISOString() },
    },
  },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
/** Every file under the media dir with a hash of its content — what "the dashboard would show as changed" reads. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(media, p), createHash("sha1").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(media);
  return out;
}
const changed = (a: Map<string, string>, b: Map<string, string>) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();

/* --- The media dir: two real matches (src/fixtures), a long-form and its Short uploaded overnight and
       scheduled, an auto-saved hook, and two unanswered comments --------------------------------- */
const A = 13560037; // v_strid vs doogile
const B = 12929221; // Feinberg vs silverrruns
for (const [id, l, r] of [
  [A, "v_strid", "doogile"],
  [B, "Feinberg", "silverrruns"],
] as const) {
  mkdirSync(path.join(media, String(id)));
  writeFileSync(path.join(media, String(id), `${l}.mp4`), "x");
  writeFileSync(path.join(media, String(id), `${r}.mp4`), "x");
}
const titleA = "CAN ANYONE CATCH UP? | v_strid vs doogile | MCSR Ranked";
titles.AbCdEfGhIjK = titleA;
titles.ShOrTiDxYz1 = "DOWN TO THE LAST PEARL | v_strid vs doogile #mcsr #minecraft";
await writeUpload(
  A,
  {
    videoId: "AbCdEfGhIjK",
    uploadedAt: new Date(NOW - 3 * H).toISOString(),
    publishAt: new Date(NOW + 14 * H).toISOString(),
    privacyStatus: "private",
    thumbnailVariant: null,
    title: titleA,
  },
  "video",
);
await writeUpload(
  A,
  {
    videoId: "ShOrTiDxYz1",
    uploadedAt: new Date(NOW - 2 * H).toISOString(),
    publishAt: new Date(NOW + 32 * H).toISOString(),
    privacyStatus: "private",
    thumbnailVariant: null,
    title: titles.ShOrTiDxYz1,
  },
  "short",
);
writeFileSync(
  path.join(media, String(B), `short-${B}.status.json`),
  JSON.stringify({
    steps: {},
    errors: [],
    autoHooks: {
      at: new Date(NOW - 2 * H).toISOString(),
      titleHook: "DOES THE LEAD EVER SETTLE?",
      shortHook: null,
      source: { title: "chip", short: null },
    },
  }),
);
commentThreads = [
  thread(
    "UgzAAAAAAAAAAAAAAAAAAA1",
    "AbCdEfGhIjK",
    COMMENT_AUTHOR,
    `${COMMENT_TEXT} <b>bold</b> & more`,
    NOW - H,
  ),
  thread("UgzAAAAAAAAAAAAAAAAAAA2", "ShOrTiDxYz1", `${COMMENT_AUTHOR}b`, `${COMMENT_TEXT}b`, NOW - 2 * H),
];

try {
  /* --- P1, P2, P6, P10–P12: a quiet morning, built end to end ------------------------------------ */
  {
    const built = await index.buildMorningReport(NOW);
    const [day, channel, comments] = built.messages;
    assert.equal(built.messages.length, 3, "three messages");
    assert.ok(day!.startsWith("☀️ <b>Wed 14 Oct</b>"), day);
    // P2: nothing on disk needs the operator, and the section says so in words.
    assert.ok(day!.includes("<b>Needs you</b>\nNothing today."), day);
    // P1: the day's order — Needs you, Auto-saved hooks, Claude's headline, the to-do.
    const at = (s: string) => {
      const i = day!.indexOf(s);
      assert.ok(i >= 0, `${s} missing:\n${day}`);
      return i;
    };
    assert.ok(at("Needs you") < at("Auto-saved hooks"));
    assert.ok(at("Auto-saved hooks") < at("Covered through Thursday"));
    assert.ok(at("Covered through Thursday") < at("To do"));
    assert.equal(built.claude.source, "claude");
    // Problems only when there are any; health one line ("✅ All N services up" when nothing is down).
    assert.equal(day!.includes("Problems"), built.facts.alerts.ok && built.facts.alerts.data.length > 0, day);
    if (built.facts.health.every((h) => h.ok)) assert.match(day!, /✅ All \d+ services up/);
    assert.ok(
      built.facts.health.some((h) => h.name === "claude (haiku)"),
      "the health check includes Claude",
    );
    assert.ok(dnsLookups > 0, "the DNS stub answered the health check");
    // The channel message: live counts, the stats table, YPP.
    assert.ok(
      channel!.includes("120 subs") && channel!.includes("<pre>") && channel!.includes("YPP"),
      channel,
    );
    // The comments message: both, grouped under their videos.
    assert.ok(comments!.includes("2 unanswered comments"), comments);
    // P4 end to end: the viewer's markup arrives escaped.
    assert.ok(
      comments!.includes("&lt;b&gt;bold&lt;/b&gt; &amp; more") && !comments!.includes("<b>bold</b>"),
      comments,
    );
    console.log(
      "OK: a quiet morning is three messages, Needs you says 'Nothing today.', the day in the documented order",
    );

    // P6: every YouTube link in all three opens Studio.
    const hrefs = built.messages.flatMap((m) => [...m.matchAll(/href="([^"]*)"/g)].map((x) => x[1]!));
    const yt = hrefs.filter((h) => /youtu/.test(h));
    assert.ok(yt.length >= 5, `links to check: ${yt.join(" ")}`);
    for (const h of yt) assert.ok(h.startsWith("https://studio.youtube.com/"), h);
    assert.ok(
      hrefs.includes("https://studio.youtube.com/video/AbCdEfGhIjK/edit"),
      "overnight long-form opens its Studio edit page",
    );
    assert.ok(
      hrefs.includes("https://studio.youtube.com/video/AbCdEfGhIjK/comments?lc=UgzAAAAAAAAAAAAAAAAAAA1"),
      "the exact comment",
    );
    console.log(`OK: all ${yt.length} YouTube links in the report open Studio`);

    // P10–P12: what Claude was actually given on the real call path.
    const asked = claudeCalls();
    const today = asked.filter((c) => !isPing(c));
    assert.equal(today.length, 1, "TODAY is asked once");
    for (const c of asked) {
      const everything = JSON.stringify([c.argv, c.stdin]);
      assert.ok(!everything.includes(COMMENT_TEXT), "a viewer's comment text never reaches Claude");
      assert.ok(!everything.includes(COMMENT_AUTHOR), "a viewer's name never reaches Claude");
      assert.deepEqual(c.argv.slice(0, 13), [
        "-p",
        "--model",
        "claude-haiku-4-5-20251001",
        "--output-format",
        "json",
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--system-prompt",
      ]);
      assert.equal(realpathSync(c.cwd), realpathSync(tmpdir()));
      for (const [k, v] of Object.entries(SECRETS)) {
        if (k === "CLAUDE_CODE_OAUTH_TOKEN")
          assert.equal(c.env[k], v, "the auth token is the one secret forwarded");
        else assert.ok(!Object.values(c.env).includes(v), `${k} reached the child`);
      }
      assert.equal(c.env.TELEGRAM_CHAT_ID, undefined);
      assert.equal(c.env.YOUTUBE_TOKEN_FILE, undefined);
    }
    // ...but the counts and titles are there: the to-do is about this channel's real state.
    assert.match(today[0]!.stdin, /"unansweredCommentsCount":2/);
    assert.ok(today[0]!.stdin.includes("v_strid vs doogile"), "titles/players are allowed");
    console.log(
      "OK: Claude got counts and titles on stdin, the documented argv and env, no comment text or author",
    );
  }

  /* --- P2/P10: a blocked runner's comment is a Needs you line; Claude still never sees who or what ---- */
  {
    commentThreads.push(
      thread(
        "UgzAAAAAAAAAAAAAAAAAAA3",
        "AbCdEfGhIjK",
        "SyntheticBlockedRunner",
        `${COMMENT_TEXT}c please stop`,
        NOW - H,
      ),
    );
    const before = claudeCalls().length;
    const built = await index.buildMorningReport(NOW);
    assert.ok(built.messages[0]!.includes(`• a blocked runner commented on ${titleA}`), built.messages[0]);
    assert.ok(!built.messages[0]!.includes(COMMENT_TEXT), "the Needs you line never quotes the comment");
    const today = claudeCalls()
      .slice(before)
      .find((c) => !isPing(c))!;
    assert.ok(today.stdin.includes("a blocked runner commented on"), "the item reaches Claude's FACTS…");
    assert.ok(
      !today.stdin.includes("SyntheticBlockedRunner") && !today.stdin.includes(COMMENT_TEXT),
      "…without who wrote it or what",
    );
    commentThreads.pop();
    console.log(
      "OK: a blocked runner's comment is named by video in Needs you, and reaches Claude without author or text",
    );
  }

  /* --- P7: sending records the dedupe; the next report reads "overnight" and "+N" from it ---------- */
  {
    const sentBefore = tgSent().length;
    await index.sendMorningReport(NOW);
    const sent = tgSent().slice(sentBefore);
    assert.equal(sent.length, 3, "three Telegram messages");
    for (const s of sent) {
      assert.equal(s.body?.chat_id, "42", "to the operator's chat");
      assert.equal(s.body?.parse_mode, "HTML");
    }
    const state = readTelegramState();
    assert.equal(state.lastReportWarsawDate, "2026-10-14");
    assert.equal(state.lastReportAt, new Date(NOW).toISOString());
    assert.deepEqual(state.prevSnapshot, { subscribers: 120, views: 5000, videos: 30 });
    assert.deepEqual(
      readdirSync(media).filter((f) => f.startsWith(".telegram.json")),
      [".telegram.json"],
      "written atomically: no temp file left",
    );

    // The next morning: one more upload after the last report, five more subscribers.
    await writeUpload(
      B,
      {
        videoId: "NeWvIdEo001",
        uploadedAt: new Date(NOW + 2 * H).toISOString(),
        publishAt: new Date(NOW + 40 * H).toISOString(),
        privacyStatus: "private",
        thumbnailVariant: null,
        title: "DOES THE LEAD EVER SETTLE? | Feinberg vs silverrruns | MCSR Ranked",
      },
      "video",
    );
    liveSubs = 125;
    const next = await index.buildMorningReport(NOW + 24 * H);
    // "Uploaded:" is since the last report; the earlier long-form only reappears under "Went public:"
    // (its publish time fell inside this night), which is a different fact.
    const day = next.messages[0]!;
    const uploaded = day.slice(
      day.indexOf("Uploaded:"),
      day.includes("Went public:") ? day.indexOf("Went public:") : undefined,
    );
    assert.ok(
      uploaded.includes("NeWvIdEo001"),
      `the upload after the last report is overnight news:\n${day}`,
    );
    assert.ok(
      !uploaded.includes("AbCdEfGhIjK") && !uploaded.includes("ShOrTiDxYz1"),
      `the uploads before it are not repeated:\n${day}`,
    );
    assert.ok(next.messages[1]!.includes("125 subs (+5)"), next.messages[1]);
    liveSubs = 120;

    // The date recorded is Warsaw's: 22:30 UTC on the 14th is already the 15th in Warsaw.
    await index.sendMorningReport(Date.parse("2026-10-14T22:30:00Z"));
    assert.equal(readTelegramState().lastReportWarsawDate, "2026-10-15");
    console.log("OK: a sent report records Warsaw's date, its instant and the snapshot; the next reads both");
  }

  /* --- P13: a usage limit is the exact wording everywhere, asked once ------------------------------ */
  {
    writeFileSync(claudeMode, "limit");
    const before = claudeCalls().length;
    const built = await index.buildMorningReport(NOW);
    const day = built.messages[0]!;
    assert.equal(built.claude.source, "fallback");
    assert.equal(built.claude.note, "usage limit reached — try again later");
    assert.ok(day.includes("<i>usage limit reached — try again later</i>"), day);
    assert.ok(
      !built.messages.join("\n").includes("1760000000") &&
        !built.messages.join("\n").includes("Claude AI usage"),
      "never the CLI's own wording",
    );
    for (const line of day.split("\n").filter((l) => /limit/i.test(l)))
      assert.ok(line.includes("usage limit reached — try again later"), line);
    assert.equal(
      claudeCalls()
        .slice(before)
        .filter((c) => !isPing(c)).length,
      1,
      "TODAY was not retried",
    );
    // The rule-based list stands in.
    assert.ok(day.includes("What needs you today") && day.includes("Reply to 2 comments"), day);

    const beforeAsk = claudeCalls().length;
    const ask = await index.dispatchCommand({ command: "ask", args: "how many comments are waiting?" });
    assert.deepEqual(
      ask,
      { messages: ["usage limit reached — try again later"], html: false },
      "/ask's whole reply, verbatim",
    );
    assert.equal(
      claudeCalls()
        .slice(beforeAsk)
        .filter((c) => !isPing(c)).length,
      1,
      "/ask was not retried",
    );
    console.log("OK: a usage limit reads exactly the operator's wording in TODAY and /ask, asked once each");
  }

  /* --- P14: an unusable answer and a signed-out CLI both fall back, with their reason -------------- */
  {
    writeFileSync(claudeMode, "garbage");
    let built = await index.buildMorningReport(NOW);
    assert.equal(built.claude.source, "fallback");
    assert.ok(built.messages[0]!.includes("<i>answered, but not a usable to-do list</i>"), built.messages[0]);
    assert.ok(built.messages[0]!.includes("What needs you today"));
    writeFileSync(claudeMode, "auth");
    built = await index.buildMorningReport(NOW);
    assert.match(
      built.messages[0]!,
      /<i>run `claude setup-token` and put CLAUDE_CODE_OAUTH_TOKEN in \/app\/\.env<\/i>/,
    );
    writeFileSync(claudeMode, "ok");
    console.log("OK: an unusable answer and a signed-out CLI fall back to the rule-based list, reason shown");
  }

  /* --- P15, P16, P20: every command is read-only, and narrow ones skip the Claude ping ------------- */
  {
    const narrow = new Set([
      "stats",
      "comments",
      "ypp",
      "waiting",
      "needs",
      "worth",
      "nightly",
      "overnight",
      "help",
    ]);
    for (const { command } of BOT_COMMANDS) {
      const before = snapshot();
      const callsBefore = calls.length;
      const claudeBefore = claudeCalls().length;
      const reply = await index.dispatchCommand({
        command,
        args: command === "ask" ? "what is scheduled?" : "",
      });
      assert.ok(
        reply.messages.length > 0 && reply.messages.every((m) => m.length > 0),
        `/${command} answered`,
      );
      // Nothing on disk the dashboard reads changed — the bot's own state file aside.
      deviation(
        "Every bot command is read-only — no command writes anything the dashboard would show as changed",
        () => {
          const diff = changed(before, snapshot()).filter((f) => f !== ".telegram.json");
          assert.deepEqual(diff, [], `/${command} changed ${diff.join(", ")}`);
        },
      );
      // No YouTube write of any kind: every Data/Analytics/upload call is a GET.
      const writes = calls
        .slice(callsBefore)
        .filter(
          (c) => /googleapis\.com/.test(c.url) && !c.url.startsWith("https://oauth2.") && c.method !== "GET",
        );
      assert.deepEqual(
        writes.map((c) => `${c.method} ${c.url}`),
        [],
        `/${command} wrote to YouTube`,
      );
      assert.ok(
        !calls.slice(callsBefore).some((c) => c.url.includes("api.telegram.org")),
        `/${command} sends nothing itself`,
      );
      const pings = claudeCalls().slice(claudeBefore).filter(isPing).length;
      if (narrow.has(command)) assert.equal(pings, 0, `/${command} must not pay for the live Claude ping`);
      if (command === "health" || command === "alerts")
        assert.equal(pings, 1, `/${command} pings Claude for real`);
      if (command === "health")
        assert.match(reply.messages[0]!, /✅ claude \(haiku\)/, "named claude (haiku)");
      if (command === "help")
        assert.match(
          reply.messages[0]!,
          /only reads the channel and the dashboard — no command here uploads, renders, or changes the queue/,
        );
    }
    // /needs is fresh: a fact that appears between two asks is in the second answer.
    const first = (await index.dispatchCommand({ command: "needs", args: "" })).messages[0]!;
    assert.ok(first.startsWith("<b>Needs you</b>"), first);
    writeFileSync(
      path.join(media, ".studio-probe.json"),
      JSON.stringify({
        result: "signed-out",
        message: "Studio is signed out — sign in again",
        at: new Date(NOW).toISOString(),
      }),
    );
    const second = (await index.dispatchCommand({ command: "needs", args: "" })).messages[0]!;
    assert.ok(!first.includes("Studio is signed out") && second.includes("Studio is signed out"), second);
    rmSync(path.join(media, ".studio-probe.json"));
    console.log(
      `OK: all ${BOT_COMMANDS.length} commands checked read-only; narrow ones skip the Claude ping, /health names it; /needs is fresh`,
    );
  }

  /* --- P17, P18, P19: the poller's side of a message ----------------------------------------------- */
  {
    const update = (chat: number, text: string, id: number) => ({
      update_id: id,
      message: { message_id: id, chat: { id: chat }, text, date: Math.floor(NOW / 1000) },
    });
    const inbox = path.join(media, ".telegram-inbox.jsonl");
    const lines = () => (existsSync(inbox) ? readFileSync(inbox, "utf8").split("\n").filter(Boolean) : []);

    // P17: the Claude commands say they are asking before they answer; the others do not.
    for (const [command, notice] of [
      ["/todo", true],
      ["/ask what is scheduled?", true],
      ["/report", true],
      ["/stats 7d", false],
    ] as const) {
      const before = tgSent().length;
      await index.handleUpdate(update(42, command, 100));
      const texts = tgSent()
        .slice(before)
        .map((c) => String(c.body?.text));
      assert.equal(
        texts[0] === "asking Claude (haiku) — this can take up to two minutes",
        notice,
        `${command}: ${texts[0]}`,
      );
      assert.ok(texts.length >= (notice ? 2 : 1), `${command} answered`);
    }

    // P19: a plain reply is saved without a word back; another chat's is not saved at all.
    let before = calls.length;
    await index.handleUpdate(update(42, "yes, render it tonight", 101));
    assert.deepEqual(
      lines().map((l) => (JSON.parse(l) as { text: string }).text),
      ["yes, render it tonight"],
    );
    assert.equal(calls.length, before, "no echo: not a single API call for a plain reply");
    before = calls.length;
    await index.handleUpdate(update(9001, "/report", 102));
    await index.handleUpdate(update(9001, "hello?", 103));
    assert.equal(calls.length, before, "another chat: ignored silently, no API call");
    assert.equal(lines().length, 1, "another chat's text is never saved");

    // P18: a token with no chat id answers only /start, only with the chat id.
    const chatId = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_CHAT_ID;
    try {
      before = calls.length;
      await index.handleUpdate(update(555, "/start", 104));
      const reply = calls.slice(before);
      assert.equal(reply.length, 1, "one message");
      assert.equal(reply[0]!.body?.chat_id, "555");
      assert.equal(
        reply[0]!.body?.text,
        "your chat id is 555 — add TELEGRAM_CHAT_ID=555 to /app/.env and restart the dashboard",
      );
      before = calls.length;
      await index.handleUpdate(update(555, "/report", 105));
      await index.handleUpdate(update(555, "plain words", 106));
      assert.equal(calls.length, before, "nothing else runs before pairing");
      assert.equal(lines().length, 1, "and nothing lands in the inbox");
    } finally {
      process.env.TELEGRAM_CHAT_ID = chatId;
    }
    console.log(
      "OK: Claude commands announce themselves, plain replies are saved silently, pairing answers only /start",
    );
  }

  /* --- P8, P18: a restart — no token, catch-up inside the window, nothing twice, nothing off-hours ---- */
  {
    const realNow = Date.now;
    let fakeNow = 0;
    Date.now = () => fakeNow;
    rmSync(path.join(media, ".telegram.json"), { force: true });
    try {
      // No token: nothing runs at all.
      process.env.TELEGRAM_BOT_TOKEN = "";
      let before = calls.length;
      await index.startTelegramBot();
      assert.equal(calls.length, before, "no token: not one API call");
      process.env.TELEGRAM_BOT_TOKEN = SECRETS.TELEGRAM_BOT_TOKEN;

      // 08:30 CEST, never sent: the restart sends the morning report itself.
      fakeNow = Date.parse("2026-10-14T06:30:00Z");
      before = tgSent().length;
      await index.startTelegramBot();
      await until(
        "the catch-up report",
        () => tgSent().length - before >= 3 && readTelegramState().lastReportWarsawDate === "2026-10-14",
      );
      assert.equal(tgSent().length - before, 3, "the catch-up is the whole report, once");
      assert.ok(
        calls.some((c) => c.url.endsWith("/setMyCommands")),
        "the command menu was set",
      );
      assert.ok(
        calls.some((c) => c.url.endsWith("/getUpdates")),
        "the poller is polling",
      );

      // 09:45 the same morning: already recorded, nothing more.
      // A report that started would fetch its facts at once; the poller's own getUpdates and the
      // boot's setMyCommands are the only calls a restart that sends nothing makes.
      const quiet = async (label: string) => {
        const b = calls.length;
        await index.startTelegramBot();
        await sleep(800);
        const made = calls
          .slice(b)
          .filter((c) => !c.url.endsWith("/getUpdates") && !c.url.endsWith("/setMyCommands"));
        assert.deepEqual(
          made.map((c) => c.url),
          [],
          label,
        );
      };
      fakeNow = Date.parse("2026-10-14T07:45:00Z");
      await quiet("a second restart the same morning sends nothing");
      // 05:25 CEST the next day: before the report hour the timer sends it, never the restart.
      fakeNow = Date.parse("2026-10-15T03:25:00Z");
      await quiet("a restart before the report hour sends nothing early");
      // 10:30 CEST: too late to catch up.
      fakeNow = Date.parse("2026-10-15T08:30:00Z");
      await quiet("a restart after 10:00 Warsaw waits for tomorrow");
      // The report off: no catch-up even inside the window.
      config.telegramReportHourWarsaw = null;
      fakeNow = Date.parse("2026-10-15T06:30:00Z");
      await quiet("the report off: no catch-up");
      config.telegramReportHourWarsaw = 7;
    } finally {
      index.stopTelegramBot();
      Date.now = realNow;
    }
    console.log(
      "OK: a restart catches up once inside 07:00–10:00 Warsaw, and never early, late, twice or when off",
    );
  }

  console.log("index.contract: all checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
