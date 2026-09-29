// Self-check for report.ts: every dynamic string is HTML-escaped, the morning report is three
// messages that each say a thing once, and each fits Telegram's 4096 characters.
// Run: npx tsx src/telegram/report.test.ts
import assert from "node:assert/strict";
import {
  visibleLength,
  tierCountdown,
  renderAlerts,
  renderComments,
  renderHealth,
  renderMorningReport,
  renderStats,
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

// Comments are grouped by video: the title once, every comment under it, inside an expandable
// quote; a list too long for one message stops short and says how many more are in the inbox.
{
  const mk = (i: number, videoId: string, text = "hi"): UnansweredComment => ({
    threadId: `t${i}`,
    videoId,
    author: `person${i}`,
    authorIsChannel: false,
    text,
    publishedAt: "2026-09-28T00:00:00Z",
    totalReplyCount: 0,
    replyAuthorsAreChannel: [],
    repliesTruncated: false,
  });
  const titles = {
    v1: "THE DUALITY OF MAN | Infume vs Feinberg | MCSR Ranked 1v1 | Minecraft Speedrun",
    v2: "B | x vs y | tail",
  };
  const out = renderComments(
    { ok: true, data: { unanswered: [mk(1, "v1"), mk(2, "v2"), mk(3, "v1")], videoTitles: titles } },
    "UCxyz",
  );
  assert.ok(out.includes("3 unanswered comments"), out);
  assert.equal(out.split("THE DUALITY OF MAN · Infume vs Feinberg").length - 1, 1, out); // the title once
  assert.ok(!out.includes("Minecraft Speedrun"), out); // the genre tail is left off
  assert.ok(out.includes("<blockquote expandable>"), out);
  assert.equal((out.match(/person\d/g) ?? []).length, 3);

  const many = Array.from({ length: 60 }, (_, i) => mk(i, `v${i % 3}`, "a long comment ".repeat(10)));
  const long = renderComments({ ok: true, data: { unanswered: many, videoTitles: {} } }, "UCxyz");
  assert.ok(visibleLength(long) <= MESSAGE_MAX_CHARS, `${visibleLength(long)}`);
  const shown = (long.match(/person\d+/g) ?? []).length;
  assert.ok(shown > 5 && shown < 60, `${shown}`);
  assert.ok(long.includes(`+ ${60 - shown} more in the Studio inbox`), long.slice(-200));
}

// A to-do item from agy is escaped, and numbered; agy's notes are not shown (they repeated Problems).
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
  assert.ok(!out.includes("watch"), out);
  assert.ok(out.includes("1. do &lt;x&gt;") && out.includes("2. y &amp; z"), out);
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
  assert.ok(out.includes("~45 days (12 Nov)"), out);
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

// --- The morning report: three messages, each under the limit, each thing said once. ---
{
  const now = Date.parse("2026-09-29T05:00:00Z");
  const windows = Object.fromEntries(
    ([1, 3, 7, 30] as const).map((d) => [
      d,
      {
        days: d,
        current: {
          views: 7616 * d,
          engagedViews: 2285 * d,
          estimatedMinutesWatched: 8178 * d,
          subscribersGained: 7,
          subscribersLost: 1,
          likes: 41,
          comments: 7,
        },
        previous: { views: 4700 * d },
        currentDays: d,
        previousDays: d,
      },
    ]),
  ) as unknown as Extract<ReportFacts["stats"], { ok: true }>["data"]["windows"];
  const facts = {
    todo: {
      ok: true,
      data: {
        waitingForHook: [{ matchId: 1, players: "a vs b" }],
        scheduledToday: [],
        scheduledTomorrowCount: 1,
        scheduledDayAfterCount: 1,
        diskMatchesLeft: 7,
        diskLow: false,
        playoffsSoon: null,
        queuedTonight: 0,
      },
    },
    alerts: { ok: true, data: [] },
    health: [
      { name: "MCSR", ok: true, ms: 200 },
      { name: "Twitch", ok: true, ms: 600 },
    ],
    overnight: { ok: true, data: { uploaded: [], nowPublic: [], nightlyRendered: null } },
    stats: {
      ok: true,
      data: { live: { subscribers: 92, views: 64883, videos: 36 }, dataEndsOn: "2026-09-26", windows },
    },
    comments: { ok: true, data: { unanswered: [], videoTitles: {} } },
    ypp: { ok: false, error: "no token" },
    dashboardBaseUrl: "http://actimel:8080",
  } as unknown as ReportFacts;
  const msgs = renderMorningReport(
    facts,
    { source: "agy", answer: { headline: "Covered through Thursday", todo: ["Save hooks for a vs b"] } },
    { subscribers: 92, views: 64883, videos: 36 },
    "UCxyz",
    now,
  );
  assert.equal(msgs.length, 3);
  for (const m of msgs) assert.ok(visibleLength(m) <= MESSAGE_MAX_CHARS);
  assert.ok(
    msgs[0]!.startsWith("☀️ <b>Tue 29 Sept</b>") || msgs[0]!.startsWith("☀️ <b>Tue 29 Sep</b>"),
    msgs[0],
  );
  assert.ok(msgs[0]!.includes("✅ All 2 services up"), msgs[0]); // one line, no latencies
  assert.ok(!msgs[0]!.includes("200 ms"), msgs[0]);
  assert.ok(!msgs[0]!.includes("Problems"), msgs[0]); // no problems → no section
  assert.ok(!msgs[0]!.includes("Waiting for a hook"), msgs[0]); // the to-do says it; /waiting lists them
  assert.ok(msgs[1]!.includes("<pre>") && msgs[1]!.includes("vs prev"), msgs[1]);
  assert.ok(!msgs[1]!.includes("(0)"), msgs[1]); // an unchanged count carries no "(0)"
  assert.ok(msgs[2]!.includes("No unanswered comments"), msgs[2]);
}

// The stats table: one column per window, the header and every row the same width.
{
  const windows = Object.fromEntries(
    ([1, 3, 7, 30] as const).map((d) => [
      d,
      {
        days: d,
        current: { views: 55381, estimatedMinutesWatched: 72150 },
        previous: { views: 304 },
        currentDays: d === 30 ? 28 : d,
        previousDays: d,
      },
    ]),
  ) as unknown as Extract<ReportFacts["stats"], { ok: true }>["data"]["windows"];
  const out = renderStats(
    { ok: true, data: { live: { subscribers: 92, views: 1, videos: 1 }, dataEndsOn: "2026-09-26", windows } },
    { subscribers: 90, views: 1, videos: 1 },
  );
  const table = out.slice(out.indexOf("<pre>") + 5, out.indexOf("</pre>")).split("\n");
  assert.equal(new Set(table.map((l) => l.length)).size, 1, table.join("\n"));
  assert.ok(table[0]!.includes("30d*") && out.includes("fewer days of data"), out);
  assert.ok(out.includes("92 subs (+2)"), out);
  assert.ok(
    table.some((l) => l.startsWith("views") && l.includes("55K")),
    table.join("\n"),
  );
  assert.ok(
    table.some((l) => l.startsWith("vs prev") && l.includes("×182")),
    table.join("\n"),
  );
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
