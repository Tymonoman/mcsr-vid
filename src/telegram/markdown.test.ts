// Self-check for markdown.ts: what Claude writes renders as Telegram formatting, and a long report
// is cut between paragraphs, never inside a code fence.
// Run: npx tsx src/telegram/markdown.test.ts
import assert from "node:assert/strict";
import { chunkMarkdown, mdToTelegramHtml } from "./markdown.js";

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

console.log("markdown: all checks passed");
