// Self-check for report.ts: every dynamic string is HTML-escaped, and the whole message is
// capped at 4096 characters.
// Run: npx tsx src/telegram/report.test.ts
import assert from "node:assert/strict";
import {
  assembleReport,
  renderAlerts,
  renderComments,
  renderHealth,
  renderToday,
  CHANNEL_ID_PLACEHOLDER,
} from "./report.js";
import { MESSAGE_MAX_CHARS } from "./bot.js";
import type { ReportFacts } from "./facts.js";

// --- HTML escaping: a malicious/odd string in any dynamic field must never reach the message
// unescaped — Telegram's HTML parse_mode would otherwise choke on it or, worse, let it act as
// markup. ---
{
  const evil = "<b>bold</b> & <script>alert(1)</script>";
  const alerts: ReportFacts["alerts"] = { ok: true, data: [{ source: evil, message: evil }] };
  const out = renderAlerts(alerts);
  assert.ok(!out.includes("<script>"), out);
  assert.ok(!out.includes("<b>bold</b>"), out); // the escaped one, not our own <b> wrapper
  assert.ok(out.includes("&lt;script&gt;"), out);
  assert.ok(out.includes("&amp;"), out);
}

{
  const health = [{ name: "<img src=x>", ok: false, detail: "a & b < c" }];
  const out = renderHealth(health);
  assert.ok(!out.includes("<img"), out);
  assert.ok(out.includes("&lt;img src=x&gt;"), out);
  assert.ok(out.includes("a &amp; b &lt; c"), out);
}

{
  const comments: ReportFacts["comments"] = {
    ok: true,
    data: {
      unanswered: [
        {
          threadId: "t1",
          videoId: "v1",
          author: "<i>hacker</i>",
          authorIsChannel: false,
          text: "click <a href=evil>here</a>",
          publishedAt: "2026-09-28T00:00:00Z",
          totalReplyCount: 0,
          replyAuthorsAreChannel: [],
          repliesTruncated: false,
        },
      ],
      videoTitles: { v1: "match & mayhem" },
    },
  };
  const out = renderComments(comments).replace(CHANNEL_ID_PLACEHOLDER, "UCxyz");
  assert.ok(!out.includes("<i>hacker</i>"), out);
  assert.ok(!out.includes("<a href=evil>"), out);
  assert.ok(out.includes("&lt;i&gt;hacker&lt;/i&gt;"), out);
  assert.ok(out.includes("match &amp; mayhem"), out);
  assert.ok(out.includes("UCxyz"), out);
}

// A to-do item and a note from agy are escaped the same way.
{
  const todo: ReportFacts["todo"] = { ok: false, error: "boom" };
  const out = renderToday(
    todo,
    { source: "agy", answer: { headline: "hi <b>", todo: ["do <x>", "y & z"], notes: ["watch <this>"] } },
    "http://actimel:8080",
  );
  assert.ok(!out.includes("hi <b>"), out);
  assert.ok(out.includes("hi &lt;b&gt;"), out);
  assert.ok(out.includes("do &lt;x&gt;"), out);
  assert.ok(out.includes("y &amp; z"), out);
  assert.ok(out.includes("watch &lt;this&gt;"), out);
  assert.ok(out.includes("boom"), out); // the facts error still shows
}

// --- The 4096 cap ---

// Comfortably under the limit: nothing dropped, no truncation note.
{
  const sections = ["short section one", "short section two", "short section three"];
  const out = assembleReport(sections, MESSAGE_MAX_CHARS);
  assert.ok(out.length <= MESSAGE_MAX_CHARS);
  assert.ok(!out.includes("truncated"));
  assert.equal(out, sections.join("\n\n"));
}

// Sections that together would run well past the limit: the result never exceeds it, keeps the
// earlier (higher-priority) sections whole, and says it was truncated.
{
  const sections = Array.from({ length: 20 }, (_, i) => `section ${i}: ${"x".repeat(400)}`);
  const out = assembleReport(sections, MESSAGE_MAX_CHARS);
  assert.ok(out.length <= MESSAGE_MAX_CHARS, `${out.length} > ${MESSAGE_MAX_CHARS}`);
  assert.ok(out.includes("truncated"));
  assert.ok(out.startsWith("section 0:"));
  assert.ok(!out.includes("section 19:")); // the tail never made it in
}

// A single section already over the limit on its own: still capped, still under the limit.
{
  const out = assembleReport(["x".repeat(5000)], MESSAGE_MAX_CHARS);
  assert.ok(out.length <= MESSAGE_MAX_CHARS, `${out.length} > ${MESSAGE_MAX_CHARS}`);
}

console.log("report: all checks passed");
