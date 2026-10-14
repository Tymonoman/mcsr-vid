// Contract test for bot.ts (the Bot API over fetch), written from the docs (CLAUDE.md "Telegram bot",
// handbook claude-md-reference.md "Telegram bot"), not from the code. bot.test.ts pins the pure
// helpers (escapeHtml's three characters, splitMessage); this file drives the calls themselves
// through a stubbed fetch: what a send puts on the wire, that no token means no call, the 409 the
// poller backs off on, and that the token never surfaces in an error.
//
// Promises (numbering shared with index.contract.test.ts):
//  P4.  HTML parse mode; escapeHtml makes any string safe for it (the three characters it needs).
//  P5.  An HTML message that fits once parsed goes out whole, as one message.
//  P18. No token: nothing runs (no Bot API call is made); the secrets live in the env, never in output.
//       A 409 from getUpdates means another process is polling — the poller backs off on it.
// Run: npx tsx src/telegram/bot.contract.test.ts
import assert from "node:assert/strict";

const TOKEN = "123456:bot-contract-secret-token";
process.env.TELEGRAM_BOT_TOKEN = TOKEN; // before bot.ts loads, so a `.env` in the cwd changes nothing
process.env.TELEGRAM_CHAT_ID = "42";
const bot = await import("./bot.js");

type Sent = { url: string; body: Record<string, unknown> };
const sent: Sent[] = [];
let answer: () => Response = () => new Response(JSON.stringify({ ok: true, result: true }));
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
  return answer();
}) as typeof fetch;

try {
  /* --- What a send puts on the wire ------------------------------------------------------------- */
  await bot.sendMessage("<b>hello</b>", { html: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(sent[0]!.body.chat_id, "42", "to TELEGRAM_CHAT_ID");
  assert.equal(sent[0]!.body.parse_mode, "HTML", "HTML parse mode, not MarkdownV2");
  assert.equal(sent[0]!.body.disable_web_page_preview, true, "a report carries no link preview");
  await bot.sendMessage("plain <not markup>");
  assert.equal(sent[1]!.body.parse_mode, undefined, "plain text is sent as plain text");
  console.log("OK: a send goes to the operator's chat in HTML parse mode, previews off");

  /* --- P5: a comments-heavy message whose markup alone passes 4096 still goes out whole ---------- */
  {
    const line = `• <b>Viewer</b>: ${"w".repeat(40)} · <a href="https://studio.youtube.com/video/AbCdEfGhIjK/comments?lc=Ugz0000000000000000000">reply</a>`;
    const html = `<b>💬 60 unanswered comments</b>\n<blockquote expandable>${Array.from({ length: 50 }, () => line).join("\n")}</blockquote>`;
    assert.ok(
      html.length > 4096 && bot.visibleLength(html) <= 4096,
      `${html.length} raw, ${bot.visibleLength(html)} visible`,
    );
    const before = sent.length;
    await bot.sendMessage(html, { html: true });
    assert.equal(sent.length - before, 1, "one message, its <blockquote> whole");
    assert.equal(sent.at(-1)!.body.text, html);
  }
  console.log("OK: an HTML message that fits once parsed is one message");

  /* --- P4: escapeHtml makes any string inert and loses nothing ----------------------------------- */
  {
    const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const alphabet = ["<", ">", "&", "&amp;", "&lt;", "a", " ", "\n", '"', "'", "b>", "</", "é", "🎬"];
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 500; n++) {
      const s = Array.from(
        { length: 1 + Math.floor(rand() * 20) },
        () => alphabet[Math.floor(rand() * alphabet.length)],
      ).join("");
      const e = bot.escapeHtml(s);
      assert.ok(!/[<>]/.test(e), `raw markup survived: ${JSON.stringify(s)}`);
      assert.ok(!/&(?!(?:amp|lt|gt);)/.test(e), `a bare & survived: ${JSON.stringify(s)}`);
      assert.equal(unescape(e), s, "escaping is lossless");
      assert.equal(
        bot.visibleLength(e),
        s.length,
        "Telegram counts an escaped string as the original's length",
      );
    }
  }
  console.log("OK: 500 random strings escape to inert, lossless text Telegram counts at its own length");

  /* --- P18: the 409 the poller backs off on, and the token never in an error ---------------------- */
  answer = () =>
    new Response(
      JSON.stringify({
        ok: false,
        error_code: 409,
        description: "Conflict: terminated by other getUpdates request",
      }),
      { status: 409 },
    );
  const conflict = await bot.getUpdates(undefined, 1).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(conflict instanceof bot.TelegramApiError, String(conflict));
  assert.equal(
    (conflict as InstanceType<typeof bot.TelegramApiError>).status,
    409,
    "the status the poller keys its back-off on",
  );
  assert.ok(!String((conflict as Error).message).includes(TOKEN), "the token is not in the error");
  assert.ok(!String((conflict as Error).stack).includes(TOKEN), "nor in its stack");
  answer = () => new Response("<html>bad gateway</html>", { status: 502 });
  const gateway = await bot.sendMessage("x").then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(gateway && !gateway.message.includes(TOKEN), String(gateway));
  answer = () => new Response(JSON.stringify({ ok: true, result: true }));
  console.log("OK: a 409 is a TelegramApiError with status 409; no error carries the token");

  /* --- P18: no token, no call -------------------------------------------------------------------- */
  process.env.TELEGRAM_BOT_TOKEN = "  ";
  const before = sent.length;
  assert.equal(bot.isConfigured(), false, "a blank token is no token");
  await assert.rejects(bot.sendMessage("x"));
  await assert.rejects(bot.getUpdates(undefined, 1));
  await assert.rejects(bot.setMyCommands([]));
  assert.equal(sent.length, before, "not one request without a token");
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  assert.equal(bot.hasChat(), false, "a token alone cannot send the report unprompted");
  await assert.rejects(bot.sendMessage("x"), /TELEGRAM_CHAT_ID/);
  assert.equal(sent.length, before, "nor without a chat to send to");
  console.log("OK: no token (or no chat id for a report) means no request at all");

  console.log("bot.contract: all checks passed");
} finally {
  globalThis.fetch = realFetch;
}
