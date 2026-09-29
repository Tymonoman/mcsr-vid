// Self-check for tg-forward.mjs's pure helpers: reading the last assistant message out of a
// synthetic transcript JSONL, the 300-character gate, the Warsaw time label and the split.
// Run: npx tsx scripts/tg-forward.test.ts
import assert from "node:assert/strict";
import {
  chunkMarkdown,
  lastAssistantText,
  mdToTelegramHtml,
  readEnvFile,
  splitAt,
  warsawTimeLabel,
} from "./tg-forward.mjs";

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;
const assistantLine = (texts: string[], extra: Record<string, unknown> = {}) =>
  line({
    type: "assistant",
    message: { role: "assistant", content: texts.map((text) => ({ type: "text", text })) },
    ...extra,
  });

// No assistant line at all.
assert.equal(lastAssistantText(""), null);
assert.equal(lastAssistantText(line({ type: "user", message: { role: "user", content: "hi" } })), null);

// An assistant message with only thinking/tool_use blocks, no text: still null.
{
  const jsonl = line({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", name: "Bash", input: {} },
      ],
    },
  });
  assert.equal(lastAssistantText(jsonl), null);
}

// One assistant message, one text block.
assert.equal(lastAssistantText(assistantLine(["hello there"])), "hello there");

// Several content blocks in one message: the text ones are joined, thinking/tool_use ignored.
{
  const jsonl = line({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "planning" },
        { type: "text", text: "part one" },
        { type: "tool_use", name: "Read", input: {} },
        { type: "text", text: "part two" },
      ],
    },
  });
  assert.equal(lastAssistantText(jsonl), "part one\n\npart two");
}

// Several turns: only the LAST assistant message counts, not an earlier one.
{
  const jsonl =
    assistantLine(["first turn"]) +
    line({ type: "user", message: { content: "ok" } }) +
    assistantLine(["second turn, the real answer"]);
  assert.equal(lastAssistantText(jsonl), "second turn, the real answer");
}

// A truncated/malformed last line (the file mid-write) is skipped, not fatal — the previous
// complete assistant message still comes back.
{
  const jsonl = `${assistantLine(["complete turn"])}{"type":"assistant","message":{"content":[{"type":"text","tex`;
  assert.equal(lastAssistantText(jsonl), "complete turn");
}

// Blank lines between entries are ignored.
assert.equal(lastAssistantText(`\n\n${assistantLine(["padded"])}\n\n`), "padded");

// --- .env reading: no dependency on cwd, quotes stripped, missing file is empty. ---
assert.deepEqual(readEnvFile("/no/such/file"), {});

// --- warsawTimeLabel: a plausible, non-empty label (exact format is cosmetic; DST correctness
// is schedule.ts's job, this only has to not crash and to include the year). ---
{
  const label = warsawTimeLabel(Date.UTC(2026, 0, 15, 6, 0, 0));
  assert.ok(label.includes("2026"), label);
  assert.ok(/\d{2}:\d{2}/.test(label), label);
}

// --- splitAt: same contract as bot.ts's splitMessage. ---
assert.deepEqual(splitAt("short"), ["short"]);
{
  const parts = splitAt("z".repeat(9000), 4096);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(""), "z".repeat(9000));
  for (const p of parts) assert.ok(p.length <= 4096);
}

console.log("tg-forward: all checks passed");

// Markdown → Telegram HTML: what Claude writes renders as formatting, and nothing is left raw.
{
  const html = mdToTelegramHtml(
    [
      "## Done",
      "**Merged** to main (`633b4e0`), see [the page](https://claude.ai/artifact/x?a=1&b=2).",
      "- one <item> & more",
      "",
      "| Video | Goes public |",
      "|---|---|",
      "| **13704828** | 28 Sept 21:00 |",
      "| 9rSmpFSA0lo | 29 Sept 01:00 |",
      "",
      "```",
      "npm run tg -- report --dry-run",
      "```",
    ].join("\n"),
  );
  assert.ok(html.includes("<b>Done</b>"), html);
  assert.ok(html.includes("<b>Merged</b> to main (<code>633b4e0</code>)"), html);
  assert.ok(html.includes('<a href="https://claude.ai/artifact/x?a=1&amp;b=2">the page</a>'), html);
  assert.ok(html.includes("• one &lt;item&gt; &amp; more"), html);
  assert.ok(
    html.includes(
      "<pre>Video        Goes public\n13704828     28 Sept 21:00\n9rSmpFSA0lo  29 Sept 01:00</pre>",
    ),
    html,
  );
  assert.ok(html.includes("<pre>npm run tg -- report --dry-run</pre>"), html);
  assert.ok(!html.includes("**") && !html.includes("|---"), html);
}

// Chunks: cut between paragraphs, never inside a code fence, each at most the limit.
{
  const md = ["para one", "", "```", "a", "", "b", "```", "", "x".repeat(50)].join("\n");
  const chunks = chunkMarkdown(md, 30);
  assert.ok(
    chunks.every((c) => c.length <= 30),
    JSON.stringify(chunks),
  );
  assert.ok(
    chunks.some((c) => c.includes("```\na\n\nb\n```")),
    JSON.stringify(chunks),
  ); // the fence whole
  assert.deepEqual(chunkMarkdown("short\n\ntext"), ["short\n\ntext"]);
}

console.log("tg-forward markdown: all checks passed");
