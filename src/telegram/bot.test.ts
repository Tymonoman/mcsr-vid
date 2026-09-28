// Self-check for bot.ts's pure helpers: HTML escaping and message splitting.
// Run: npx tsx src/telegram/bot.test.ts
import assert from "node:assert/strict";
import { escapeHtml, MESSAGE_MAX_CHARS, splitMessage } from "./bot.js";

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

console.log("bot: all checks passed");
