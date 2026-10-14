// Self-check for bot.ts's pure helpers: HTML escaping and message splitting.
// Run: npx tsx src/telegram/bot.test.ts
import assert from "node:assert/strict";
import { escapeHtml, MESSAGE_MAX_CHARS, messageParts, splitMessage } from "./bot.js";

assert.equal(escapeHtml("<script>&"), "&lt;script&gt;&amp;");
assert.equal(escapeHtml("a > b < c & d"), "a &gt; b &lt; c &amp; d");
assert.equal(escapeHtml("no special chars"), "no special chars");

// Short text is a single part.
assert.deepEqual(splitMessage("hello"), ["hello"]);
assert.deepEqual(splitMessage("x".repeat(4096)), ["x".repeat(4096)]);

// Over the limit, breaking on the last newline before it.
{
  const line = "y".repeat(100);
  const text = Array.from({ length: 50 }, () => line).join("\n"); // 50*101 - 1 = 5049 chars
  const parts = splitMessage(text, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1000, `part is ${p.length} chars`);
  // Rejoining with the newlines the split ate back is the original text.
  assert.equal(parts.join("\n"), text);
}

// No good break point (one giant line): a hard cut at the limit.
{
  const text = "z".repeat(9000);
  const parts = splitMessage(text, 4096);
  assert.equal(parts.length, 3);
  assert.equal(parts[0]!.length, 4096);
  assert.equal(parts.join(""), text);
}

assert.equal(MESSAGE_MAX_CHARS, 4096);

// Telegram counts an HTML message after parsing: one whose markup alone passes the limit goes
// whole, never cut through its <blockquote>; plain text, or HTML over the limit once parsed, splits.
{
  const line = `• <a href="https://studio.youtube.com/video/abcdefghijk/comments">${"w".repeat(40)}</a>`;
  const html = `<blockquote expandable>${Array.from({ length: 60 }, () => line).join("\n")}</blockquote>`;
  assert.ok(html.length > MESSAGE_MAX_CHARS);
  assert.deepEqual(messageParts(html, true), [html]);
  assert.ok(messageParts(html).length > 1);
  assert.ok(messageParts(html.repeat(2), true).length > 1);
}

console.log("bot: all checks passed");
