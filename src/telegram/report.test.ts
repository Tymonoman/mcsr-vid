// Self-check for report.ts: every dynamic string is HTML-escaped, and the whole message is
// capped at 4096 characters.
// Run: npx tsx src/telegram/report.test.ts
import assert from "node:assert/strict";
import {
  assembleReport,
  visibleLength,
  tierCountdown,
  renderAlerts,
  renderComments,
  renderHealth,
  renderToday,
  renderYpp,
} from "./report.js";
import { MESSAGE_MAX_CHARS } from "./bot.js";
import type { ReportFacts } from "./facts.js";
import type { UnansweredComment } from "./comments.js";
import type { YppProgress } from "../youtube/yppProgress.js";

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
  const out = renderComments(comments, "UCxyz");
  assert.ok(!out.includes("<i>hacker</i>"), out);
  assert.ok(!out.includes("<a href=evil>"), out);
  assert.ok(out.includes("&lt;i&gt;hacker&lt;/i&gt;"), out);
  assert.ok(out.includes("match &amp; mayhem"), out);
  assert.ok(out.includes("UCxyz"), out);
}

// The channel id is a plain parameter now, not a post-hoc string replace — a comment whose text
// happens to contain something that looks like a placeholder must never corrupt the inbox link.
{
  const comments: ReportFacts["comments"] = {
    ok: true,
    data: {
      unanswered: [
        {
          threadId: "t1",
          videoId: "v1",
          author: "someone",
          authorIsChannel: false,
          text: "__CHANNEL_ID__ lol",
          publishedAt: "2026-09-28T00:00:00Z",
          totalReplyCount: 0,
          replyAuthorsAreChannel: [],
          repliesTruncated: false,
        },
      ],
      videoTitles: {},
    },
  };
  const out = renderComments(comments, "UCreal");
  assert.ok(out.includes(`<a href="https://studio.youtube.com/channel/UCreal/comments/inbox">`), out);
  assert.ok(out.includes("__CHANNEL_ID__ lol"), out); // the comment text is untouched
}

// More than 8 unanswered: the shown 8 plus a "+N more" line — nothing left silently invisible.
{
  const unanswered: UnansweredComment[] = Array.from({ length: 14 }, (_, i) => ({
    threadId: `t${i}`,
    videoId: "v1",
    author: `person${i}`,
    authorIsChannel: false,
    text: "hi",
    publishedAt: "2026-09-28T00:00:00Z",
    totalReplyCount: 0,
    replyAuthorsAreChannel: [],
    repliesTruncated: false,
  }));
  const comments: ReportFacts["comments"] = { ok: true, data: { unanswered, videoTitles: {} } };
  const out = renderComments(comments, "UCxyz");
  assert.ok(out.includes("14 unanswered:"), out);
  assert.ok(out.includes("+ 6 more — see the inbox link below"), out);
  assert.equal((out.match(/person\d+/g) ?? []).length, 8); // exactly the shown 8, not all 14
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

// --- YPP: "an estimated countdown in days", not just an absolute ETA date. ---
{
  const gate = (have: number, need: number, eta: string | null) => ({ have, need, ratePerDay: 1, eta });
  const nowMs = Date.UTC(2026, 8, 28); // 28 Sept 2026
  const ypp: YppProgress = {
    fetchedAt: new Date(nowMs).toISOString(),
    shortsRawViews90d: 0,
    subscribers: gate(120, 500, "2026-11-12T00:00:00.000Z"), // 45 days out
    watchHours: gate(1198, 3000, "2026-11-12T00:00:00.000Z"),
    shortsViews: gate(0, 3_000_000, null),
    tiers: {
      expanded: {
        subscribers: gate(120, 500, "2026-11-12T00:00:00.000Z"),
        watchHours: gate(1198, 3000, "2026-11-12T00:00:00.000Z"),
        shortsViews: gate(0, 3_000_000, null),
        uploads90d: { have: 5, need: 3 },
      },
      full: {
        subscribers: gate(120, 1000, null),
        watchHours: gate(1198, 4000, null),
        shortsViews: gate(0, 10_000_000, null),
      },
    },
  };
  const out = renderYpp({ ok: true, data: ypp }, nowMs);
  assert.ok(out.includes("ETA 2026-11-12 (~45 days)"), out);
}

// A gate whose ETA already passed: "~0 days", never a negative count.
{
  const gate = (have: number, need: number, eta: string | null) => ({ have, need, ratePerDay: 1, eta });
  const nowMs = Date.UTC(2026, 8, 28, 12);
  const pastEta = new Date(Date.UTC(2026, 8, 27)).toISOString();
  const tier = {
    subscribers: gate(200, 500, pastEta),
    watchHours: gate(1, 3000, null),
    shortsViews: gate(0, 3_000_000, null),
  };
  const ypp: YppProgress = {
    fetchedAt: new Date(nowMs).toISOString(),
    shortsRawViews90d: 0,
    ...tier,
    tiers: { expanded: { ...tier, uploads90d: { have: 3, need: 3 } }, full: tier },
  };
  const out = renderYpp({ ok: true, data: ypp }, nowMs);
  assert.ok(out.includes("~0 days"), out);
  assert.ok(!out.includes("~-1"), out);
}

// --- The 4096 cap ---

// Comfortably under the limit: nothing dropped, no truncation note.
{
  const sections = ["short section one", "short section two", "short section three"];
  const out = assembleReport(sections, MESSAGE_MAX_CHARS);
  assert.ok(out.length <= MESSAGE_MAX_CHARS);
  assert.ok(!out.includes("left out"));
  assert.equal(out, sections.join("\n\n"));
}

// Sections that together would run well past the limit: the result never exceeds it, keeps the
// earlier (higher-priority) sections whole, and says what it left out.
{
  const sections = Array.from({ length: 20 }, (_, i) => `section ${i}: ${"x".repeat(400)}`);
  const out = assembleReport(sections, MESSAGE_MAX_CHARS);
  assert.ok(out.length <= MESSAGE_MAX_CHARS, `${out.length} > ${MESSAGE_MAX_CHARS}`);
  assert.ok(out.includes("left out"));
  assert.ok(out.startsWith("section 0:"));
  assert.ok(!out.includes("section 19:")); // the tail never made it in
}

// A section too big to fit is left out by name, and a small one after it still gets in (the
// morning report's YPP comes after COMMENTS); links' hrefs do not count, as Telegram counts text.
{
  const big = `<b>COMMENTS</b>\n${"y".repeat(3600)}`;
  const out = assembleReport(
    ["<b>TODAY</b>\nfirst", "x".repeat(500), big, "<b>YPP</b>\nsmall"],
    MESSAGE_MAX_CHARS,
  );
  assert.ok(out.includes("<b>YPP</b>"), out.slice(-200));
  assert.ok(!out.includes("yyyy"));
  assert.ok(out.includes("left out to fit one message: COMMENTS"));
  assert.equal(visibleLength(`<a href="https://example.com/${"z".repeat(500)}">reply</a> &amp;`), 7);
}

// A single section already over the limit on its own: still capped, still under the limit.
{
  const out = assembleReport(["x".repeat(5000)], MESSAGE_MAX_CHARS);
  assert.ok(out.length <= MESSAGE_MAX_CHARS, `${out.length} > ${MESSAGE_MAX_CHARS}`);
}

// The YPP countdown: subscribers AND (hours OR Shorts views) — the later of the two, named.
{
  const now = Date.parse("2026-09-28T12:00:00Z");
  const g = (have: number, need: number, eta: string | null, ceiling?: number) => ({
    have,
    need,
    eta,
    ceiling,
  });
  const t = {
    subscribers: g(92, 500, "2027-01-23"),
    watchHours: g(1198, 3000, "2026-11-12"),
    shortsViews: g(2583, 3e6, null, 9000),
  };
  const out = tierCountdown(t, now);
  assert.ok(out.includes("~117 days") && out.includes("subscribers hold it back"), out);
  assert.ok(
    tierCountdown({ ...t, subscribers: g(600, 500, null) }, now).includes("watch hours hold it back"),
  );
  assert.equal(
    tierCountdown({ ...t, watchHours: g(1, 3000, null) }, now),
    "not reachable at the current rates",
  );
  assert.equal(
    tierCountdown(
      { subscribers: g(600, 500, null), watchHours: g(3100, 3000, null), shortsViews: t.shortsViews },
      now,
    ),
    "reached",
  );
}

console.log("report: all checks passed");
