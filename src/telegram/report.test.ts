// Self-check for report.ts: every dynamic string is HTML-escaped, the morning report is three
// messages that each say a thing once, and each fits Telegram's 4096 characters.
// Run: npx tsx src/telegram/report.test.ts
import assert from "node:assert/strict";
import {
  visibleLength,
  tierCountdown,
  renderAlerts,
  renderAutoHooks,
  renderComments,
  renderHealth,
  renderMorningReport,
  renderNeedsYou,
  renderNightly,
  renderOvernight,
  renderStats,
  renderToday,
  renderUpcoming,
  renderWaiting,
  renderYpp,
  renderYppShort,
  renderWorth,
  whenWarsaw,
} from "./report.js";
import { MESSAGE_MAX_CHARS, messageParts } from "./bot.js";
import type { ReportFacts } from "./facts.js";
import type { AutoHooksRow } from "../dashboard/shortFlow.js";
import type { UnansweredComment } from "./comments.js";
import type { WorthMatch } from "./worth.js";
import type { NightlyLastRun } from "../dashboard/nightly.js";
import { projectYpp, type YppProgress } from "../youtube/yppProgress.js";

/** The channel as the 30 Sept 2026 post-mortem read it: 102 subscribers, 63 net in the last 28 days and 27 in the last 7. */
const postMortemAt = Date.UTC(2026, 8, 30, 12);
const postMortemYpp = (over: Partial<Parameters<typeof projectYpp>[0]> = {}): YppProgress =>
  projectYpp(
    {
      fetchedAt: new Date(postMortemAt).toISOString(),
      subscribers: 102,
      subscribersPer7d: 27,
      subscribersPer28d: 63,
      watchHours365d: 1456,
      watchHoursPer28d: 47 * 28,
      shortsViews90d: 0,
      shortsViewsPer28d: 0,
      shortsRawViews90d: 0,
      uploads90d: 12,
      ...over,
    },
    postMortemAt,
  );

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
          replies: [],
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
          replies: [],
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

// --- Needs you: a deterministic shortlist, never Claude's --------------------------------------

// Empty says so in words, like every other section — never blank, never missing.
{
  const base = "http://actimel:8080";
  const out = renderNeedsYou({ ok: true, data: { items: [] } }, base);
  assert.equal(out, "<b>Needs you</b>\nNothing today.");
}

// A failed section is this section's own error line, same as every other.
{
  const out = renderNeedsYou({ ok: false, error: "boom" }, "http://actimel:8080");
  assert.match(out, /Needs you/);
  assert.match(out, /boom/);
}

// An item with a match deep-links it ("#id players"); one with none (Studio, no upload in 48 h,
// a comment-only sighting, a test needing a human call) is just its line — and every dynamic
// string, the players included, is escaped.
{
  const base = "http://actimel:8080";
  const out = renderNeedsYou(
    {
      ok: true,
      data: {
        items: [
          { matchId: 1, players: "<b>a</b> vs b", text: "upload-video failed: boom" },
          { text: "Studio is signed out — sign in again" },
        ],
      },
    },
    base,
  );
  assert.ok(out.includes(`<a href="${base}/#match=1">#1 &lt;b&gt;a&lt;/b&gt; vs b</a>`), out);
  assert.ok(out.includes("upload-video failed: boom"), out);
  assert.ok(out.includes("Studio is signed out"), out);
  // The second item has no match: just its line, not a bare "• —".
  assert.ok(out.includes("• Studio is signed out — sign in again"), out);
}

// A list too long for its own budget stops short and says how many more, same shape as /comments'.
{
  const base = "http://actimel:8080";
  const items = Array.from({ length: 200 }, (_, i) => ({
    matchId: i,
    players: "a vs b",
    text: "x".repeat(60),
  }));
  const out = renderNeedsYou({ ok: true, data: { items } }, base);
  assert.ok(visibleLength(out) <= 1600, `${visibleLength(out)}`);
  assert.match(out, /\+ \d+ more — open the dashboard/);
}

// --- Auto-saved hooks: not part of Needs you, omitted entirely when nothing auto-saved ---------

{
  const base = "http://actimel:8080";
  assert.equal(renderAutoHooks([], base), "", "nothing auto-saved: nothing printed");

  const row = (over: Partial<AutoHooksRow>): AutoHooksRow => ({
    matchId: 1,
    players: "doogile vs Feinberg",
    titleHook: "A sub-8 to win it",
    shortHook: "Down to one heart",
    at: "2026-10-08T06:00:00Z",
    stillCurrent: true,
    publishAt: "2026-10-09T19:00:00Z",
    uploaded: false,
    privacyStatus: null,
    ...over,
  });
  const out = renderAutoHooks([row({})], base);
  assert.ok(out.includes("Auto-saved hooks"), out);
  assert.ok(out.includes(`<a href="${base}/#match=1">#1 doogile vs Feinberg</a>`), out);
  assert.ok(out.includes("A sub-8 to win it / Down to one heart"), out);
  assert.ok(out.includes(whenWarsaw("2026-10-09T19:00:00Z")), out);

  // No Short, and really published (privacyStatus "public"), read in words.
  const noShortUp = renderAutoHooks(
    [row({ shortHook: null, uploaded: true, privacyStatus: "public" })],
    base,
  );
  assert.ok(noShortUp.includes("(no Short)"), noShortUp);
  assert.ok(noShortUp.includes("published"), noShortUp);

  // Uploaded is not published: the chain's own upload is a private, scheduled draft, so a row
  // with an upload record but privacyStatus still "private" must say when it goes up, not
  // "published" — the exact mislabelling a real row would hit within minutes of every Short
  // rendering (reviewer finding, 8 Oct 2026).
  const uploadedButPrivate = renderAutoHooks(
    [row({ uploaded: true, privacyStatus: "private", publishAt: "2026-10-09T19:00:00Z" })],
    base,
  );
  assert.ok(!uploadedButPrivate.includes("published"), uploadedButPrivate);
  assert.ok(uploadedButPrivate.includes(whenWarsaw("2026-10-09T19:00:00Z")), uploadedButPrivate);

  // The budget caps this section on its own, the same way: it must not crowd out the rest of the
  // day message just because many matches went un-hooked at once.
  const many = Array.from({ length: 100 }, (_, i) => row({ matchId: i }));
  const capped = renderAutoHooks(many, base);
  assert.ok(visibleLength(capped) <= 1100, `${visibleLength(capped)}`);
  assert.match(capped, /\+ \d+ more/);
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
    replies: [],
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

  // Real-length ids put each line's links past the limit raw while the parsed text still fits:
  // the message goes out as one part, its <blockquote> whole.
  const real = Array.from({ length: 30 }, (_, i) => ({
    ...mk(i, ["dQw4w9WgXcQ", "aBcDeFgHiJk", "zYxWvUtSrQp"][i % 3]!, "c".repeat(80)),
    threadId: `UgzQ7xK2mN4pR8sT1vW3yZ5${String(i).padStart(2, "0")}4AaABAg`,
  }));
  const html = renderComments({ ok: true, data: { unanswered: real, videoTitles: {} } }, "UCxyz");
  assert.ok(html.length > MESSAGE_MAX_CHARS, `${html.length}`);
  assert.ok(visibleLength(html) <= MESSAGE_MAX_CHARS, `${visibleLength(html)}`);
  const parts = messageParts(html, true);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.split("<blockquote").length, parts[0]!.split("</blockquote>").length);
}

// A to-do item from Claude is escaped, and numbered.
{
  const todo: ReportFacts["todo"] = { ok: false, error: "boom" };
  const out = renderToday(
    todo,
    { source: "claude", answer: { headline: "hi <b>", todo: ["do <x>", "y & z"] } },
    "http://actimel:8080",
  );
  assert.ok(!out.includes("hi <b>"), out);
  assert.ok(out.includes("hi &lt;b&gt;"), out);
  assert.ok(out.includes("do &lt;x&gt;"), out);
  assert.ok(out.includes("y &amp; z"), out);
  assert.ok(out.includes("1. do &lt;x&gt;") && out.includes("2. y &amp; z"), out);
  assert.ok(out.includes("boom"), out); // the facts error still shows
}

// A link about one match opens that match (`#match=<id>`, which public/app.js routes); a link
// about the list stays the base URL. The row's players are escaped inside the anchor text.
{
  const base = "http://actimel:8080";
  const todo = {
    ok: true,
    data: { waitingForHook: [{ matchId: 13559245, players: "a & b" }] },
  } as unknown as ReportFacts["todo"];
  const row = renderWaiting(todo, base);
  assert.ok(row.includes(`<a href="${base}/#match=13559245">#13559245 a &amp; b</a>`), row);
  const today = renderToday(
    todo,
    {
      source: "claude",
      answer: { headline: "h", todo: ["Save hooks for #13559245 and #2", "<b>#13559250</b>"] },
    },
    base,
  );
  assert.ok(
    today.includes(`1. Save hooks for <a href="${base}/#match=13559245">#13559245</a> and #2`),
    today,
  );
  assert.ok(today.includes(`&lt;b&gt;<a href="${base}/#match=13559250">#13559250</a>&lt;/b&gt;`), today);
  assert.ok(today.includes(`<a href="${base}/">Open the dashboard</a>`), today); // the list: no #match
}

// The nightly, overnight and upcoming lines open the match they name: a rendered one (the last run,
// an upload, a scheduled video) links to `<base>/#match=<id>` with its players escaped inside the
// anchor. A queued or "not at night" id is a card, which `#match=` cannot open (only the Rendered
// list answers it), so those stay text; the worth-rendering ids stay `<code>` for the same reason.
{
  const base = "http://actimel:8080";
  const link = (id: number, label: string) => `<a href="${base}/#match=${id}">${label}</a>`;
  const lastRun: NightlyLastRun = {
    startedAt: "2026-09-30T01:00:00.000Z",
    matchId: 13559245,
    players: ["a & b", "<i>c</i>"],
    outcome: "done",
    export: "done",
    pick: "agy",
  };
  const target = link(13559245, "#13559245 a &amp; b vs &lt;i&gt;c&lt;/i&gt;");

  // /nightly: the last run's match opens; the queue and the skip list are text.
  const nightly = renderNightly(
    { lastRun, hourUtc: 3, queue: [{ matchId: 13559300, players: "x vs y" }], skipped: [13559301] },
    base,
  );
  assert.ok(nightly.includes(`): ${target} — done · export done · picked by the model`), nightly);
  assert.ok(nightly.includes("Queued tonight: #13559300 x vs y"), nightly);
  assert.ok(nightly.includes('Marked "not at night": #13559301'), nightly);
  assert.ok(!nightly.includes("#match=13559300") && !nightly.includes("#match=13559301"), nightly);
  assert.ok(!nightly.includes("<i>c</i>"), nightly);
  // A run that skipped chose no match: its reason alone, no link.
  const skipped = renderNightly(
    {
      lastRun: {
        startedAt: lastRun.startedAt,
        matchId: null,
        players: [],
        outcome: "skipped",
        reason: "a render is running",
      },
      hourUtc: 3,
      queue: [],
      skipped: [],
    },
    base,
  );
  assert.ok(skipped.includes("a render is running") && !skipped.includes("<a "), skipped);

  // /overnight and the morning message: the Nightly line, and each upload's players, open the match;
  // "video" and "Short" open YouTube Studio. A match whose players could not be read shows its id,
  // now a link.
  const upload = (kind: "video" | "short", videoId: string) => ({
    matchId: 13559245,
    kind,
    players: "a & b",
    videoId,
    uploadedAt: "2026-09-30T02:00:00.000Z",
    publishAt: null,
  });
  const overnight: ReportFacts["overnight"] = {
    ok: true,
    data: {
      uploaded: [upload("video", "vid1"), upload("short", "sho1")],
      nowPublic: [
        {
          matchId: 13559250,
          kind: "video",
          players: "#13559250",
          videoId: "vid2",
          publishAt: "2026-09-30T05:00:00.000Z",
        },
      ],
      nightlyRendered: lastRun,
    },
  };
  const night = renderOvernight(overnight, base);
  assert.ok(night.includes(`Nightly: ${target} — done`), night);
  assert.ok(
    night.includes(
      `• ${link(13559245, "a &amp; b")} — <a href="https://studio.youtube.com/video/vid1/edit">video</a> · <a href="https://studio.youtube.com/video/sho1/edit">Short</a>`,
    ),
    night,
  );
  assert.ok(
    night.includes(
      `• ${link(13559250, "#13559250")} — <a href="https://studio.youtube.com/video/vid2/edit">video</a>`,
    ),
    night,
  );
  const quiet = renderOvernight(
    { ok: true, data: { uploaded: [], nowPublic: [], nightlyRendered: lastRun } },
    base,
    true,
  );
  assert.ok(quiet.startsWith("🌙 Nothing uploaded or published overnight"), quiet);
  assert.ok(quiet.includes(` · nightly: ${target} — done`), quiet);

  // The next days' schedule: each row's match opens.
  const rows = [
    {
      matchId: 13559245,
      players: "a & b",
      kind: "video" as const,
      at: "2026-09-30T17:00:00.000Z",
      dayOffset: 0,
    },
    {
      matchId: 13559245,
      players: "a & b",
      kind: "short" as const,
      at: "2026-10-01T11:00:00.000Z",
      dayOffset: 1,
    },
  ];
  const upcoming = renderUpcoming(rows, 7, base);
  assert.ok(
    upcoming.includes(
      `today — ${link(13559245, "#13559245 a &amp; b")} (video) at ${whenWarsaw(rows[0]!.at)}`,
    ),
    upcoming,
  );
  assert.ok(upcoming.includes(`tomorrow — ${link(13559245, "#13559245 a &amp; b")} (short) at`), upcoming);
  assert.equal(renderUpcoming([], 7, base), "Nothing scheduled in the next 7 days.");
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
/** One scored match for the worth-rendering block. */
const worthMatch = (i: number, over: Partial<WorthMatch> = {}): WorthMatch => ({
  matchId: 13800000 + i,
  players: `a${i} vs b${i}`,
  playedAt: "2026-09-29T20:46:27.000Z",
  runMs: 819986,
  story: "lead changes 3x, 0.2 s apart at Stronghold",
  score: 0.5,
  ...over,
});

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
    needsYou: {
      ok: true,
      data: { items: [{ matchId: 2, players: "c vs d", text: "upload-video failed: boom" }] },
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
    worthRendering: { ok: true, data: { matches: [worthMatch(1)], notes: [] } },
    dashboardBaseUrl: "http://actimel:8080",
    tests: {
      runningCount: 1,
      scheduleToday: [{ experimentId: "publish-hour", arm: "19" }],
      since: [{ experimentId: "short-delay", decision: "kept control: numbers only" }],
    },
    creatorWatch: [],
  } as unknown as ReportFacts;
  const autoHooksRow: AutoHooksRow = {
    matchId: 3,
    players: "e vs f",
    titleHook: "A quiet one",
    shortHook: null,
    at: "2026-09-29T05:00:00Z",
    stillCurrent: true,
    publishAt: null,
    uploaded: false,
    privacyStatus: null,
  };
  const msgs = renderMorningReport(
    facts,
    { source: "claude", answer: { headline: "Covered through Thursday", todo: ["Save hooks for a vs b"] } },
    { subscribers: 92, views: 64883, videos: 36 },
    "UCxyz",
    now,
    [autoHooksRow],
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
  // Needs you is the top of the day, by the operator's own rule; Auto-saved hooks sits right
  // under it, both above Claude's own to-do.
  assert.ok(msgs[0]!.indexOf("Needs you") < msgs[0]!.indexOf("Auto-saved hooks"), msgs[0]);
  assert.ok(msgs[0]!.indexOf("Auto-saved hooks") < msgs[0]!.indexOf("To do"), msgs[0]);
  assert.ok(msgs[0]!.includes("upload-video failed: boom"), msgs[0]);
  assert.ok(msgs[0]!.includes("A quiet one (no Short)"), msgs[0]);
  // The matches worth rendering sit in the day message, under the to-do and above the problems.
  assert.ok(msgs[0]!.indexOf("To do") < msgs[0]!.indexOf("Worth rendering today"), msgs[0]);
  assert.ok(msgs[0]!.includes("id <code>13800001</code>"), msgs[0]);
  assert.ok(!msgs[1]!.includes("Worth rendering") && !msgs[2]!.includes("Worth rendering"));
  assert.ok(msgs[1]!.includes("<pre>") && msgs[1]!.includes("vs prev"), msgs[1]);
  // The channel message leads with net subscribers (a table row before views) and, with YPP data,
  // carries the countdown's range in its one line.
  assert.ok(msgs[1]!.indexOf("\nnet subs") < msgs[1]!.indexOf("\nviews"), msgs[1]);
  // The Tests line: running count, today's schedule entry, and the decision since the last report.
  assert.ok(msgs[1]!.includes("🧪"), msgs[1]);
  assert.ok(msgs[1]!.includes("1 running"), msgs[1]);
  assert.ok(msgs[1]!.includes("publish-hour/19"), msgs[1]);
  assert.ok(msgs[1]!.includes("short-delay decided"), msgs[1]);
  const withYpp = renderMorningReport(
    { ...facts, ypp: { ok: true, data: postMortemYpp() } },
    { source: "claude", answer: { headline: "Covered through Thursday", todo: ["Save hooks for a vs b"] } },
    { subscribers: 92, views: 64883, videos: 36 },
    "UCxyz",
    postMortemAt,
  );
  assert.equal(withYpp.length, 3);
  assert.ok(
    withYpp[1]!.includes("full tier <b>~400 days</b> (3 Nov 2027; 21 May at the last week's pace)"),
    withYpp[1],
  );
  assert.ok(visibleLength(withYpp[1]!) <= MESSAGE_MAX_CHARS);
  // The day message hands the base URL to the overnight lines: the nightly's match opens.
  const withNightly = renderMorningReport(
    {
      ...facts,
      overnight: {
        ok: true,
        data: {
          uploaded: [],
          nowPublic: [],
          nightlyRendered: {
            startedAt: "2026-09-29T01:00:00.000Z",
            matchId: 13559245,
            players: ["a", "b"],
            outcome: "done",
          },
        },
      },
    },
    { source: "claude", answer: { headline: "Covered through Thursday", todo: ["Save hooks for a vs b"] } },
    { subscribers: 92, views: 64883, videos: 36 },
    "UCxyz",
    now,
  );
  assert.ok(
    withNightly[0]!.includes(
      'nightly: <a href="http://actimel:8080/#match=13559245">#13559245 a vs b</a> — done',
    ),
    withNightly[0],
  );
  assert.ok(!msgs[1]!.includes("(0)"), msgs[1]); // an unchanged count carries no "(0)"
  assert.ok(msgs[2]!.includes("No unanswered comments"), msgs[2]);
}

// "Worth rendering": one line per match — players, when (Warsaw), run, story, the id in <code> so a
// tap copies it — five in the morning message, everything scored for /worth; all dynamic text escaped.
{
  const base = "http://actimel:8080";
  const eight = Array.from({ length: 8 }, (_, i) => worthMatch(i));
  const out = renderWorth({ ok: true, data: { matches: eight, notes: [] } }, base);
  const rows = out.split("\n").filter((l) => l.startsWith("• "));
  assert.equal(rows.length, 5, out);
  assert.equal(
    rows[0],
    `• <b>a0 vs b0</b> · ${whenWarsaw("2026-09-29T20:46:27.000Z")} · 13:39 · lead changes 3x, 0.2 s apart at Stronghold · id <code>13800000</code>`,
  );
  assert.ok(out.startsWith(`<b>🎬 Worth rendering today</b> · <a href="${base}/">dashboard</a>`), out);
  assert.ok(out.endsWith("+ 3 more — /worth"), out);
  const all = renderWorth({ ok: true, data: { matches: eight, notes: [] } }, base, Infinity);
  assert.equal(all.split("\n").filter((l) => l.startsWith("• ")).length, 8);
  assert.ok(!all.includes("more — /worth"), all);

  const evil = renderWorth(
    {
      ok: true,
      data: {
        matches: [worthMatch(1, { players: "<i>x</i> & y", story: "a < b" })],
        notes: ["twitch.tv/<b> could not be listed"],
      },
    },
    base,
  );
  assert.ok(!evil.includes("<i>x</i>") && !evil.includes("<b> could"), evil);
  assert.ok(evil.includes("&lt;i&gt;x&lt;/i&gt; &amp; y") && evil.includes("a &lt; b"), evil);
  assert.ok(evil.includes("<i>twitch.tv/&lt;b&gt; could not be listed</i>"), evil);

  assert.equal(
    renderWorth({ ok: true, data: { matches: [], notes: [] } }, base),
    "🎬 Nothing new worth rendering from the last 3 days",
  );
  const quiet = renderWorth(
    { ok: true, data: { matches: [], notes: ["Infume's matches could not be read (x)"] } },
    base,
  );
  assert.ok(
    quiet.includes("Nothing new") && quiet.includes("<i>Infume's matches could not be read (x)</i>"),
    quiet,
  );
  assert.ok(renderWorth({ ok: false, error: "boom" }, base).includes("boom"));

  // Five long lines still leave the day message under Telegram's limit.
  const long = Array.from({ length: 5 }, (_, i) =>
    worthMatch(i, {
      players: "SomeVeryLongNickname vs AnotherLongNickname",
      story: "lead changes 3x, 12 deaths, 100.3 s apart at Blind travel",
    }),
  );
  assert.ok(visibleLength(renderWorth({ ok: true, data: { matches: long, notes: [] } }, base)) < 1200);
}

// The stats table: one column per window, the header and every row the same width. Net subscribers
// and subscribers gained per 1,000 engaged views lead, each with its own "vs prev" row, then views.
{
  const side = ([views, engagedViews, subscribersGained, subscribersLost]: number[]) => ({
    views,
    engagedViews,
    subscribersGained,
    subscribersLost,
    estimatedMinutesWatched: 72150,
  });
  // [days, current, previous], each [views, engaged views, gained, lost].
  const fixture: [number, number[], number[]][] = [
    [1, [55381, 0, 3, 1], [304, 900, 2, 0]], // no engaged views today: no rate
    [3, [55381, 3000, 6, 4], [304, 3000, 1, 5]], // the window before it lost more than it gained (net -4)
    [7, [55381, 20000, 30, 6], [304, 10000, 10, 2]], // 30 gained over 20,000 engaged: 1.50 against 1.00
    [30, [55381, 40000, 60, 12], [304, 0, 0, 0]], // the window before was flat and drew no engaged views
  ];
  const windows = Object.fromEntries(
    fixture.map(([days, current, previous]) => [
      days,
      {
        days,
        current: side(current),
        previous: side(previous),
        currentDays: days === 30 ? 28 : days,
        previousDays: days,
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
  // The order is the point: net subscribers, subscribers per 1,000 engaged views, then views and the rest.
  assert.deepEqual(
    table.map((l) => l.slice(0, 9).trim()),
    [
      "",
      "net subs",
      "vs prev",
      "subs/1k",
      "vs prev",
      "views",
      "vs prev",
      "engaged",
      "hours",
      "avg view",
      "likes",
      "comments",
    ],
  );
  const cells = (label: string, nth = 0) =>
    table
      .filter((l) => l.slice(0, 9).trim() === label)
      [nth]!.slice(9)
      .match(/.{7}/g)!
      .map((c) => c.trim());
  assert.deepEqual(cells("net subs"), ["+2", "+2", "+24", "+48"], "gained minus lost");
  // 2 vs 2; 2 vs -4 is a rise, not "-150%"; 24 vs 8; 48 vs a flat 0.
  assert.deepEqual(cells("vs prev", 0), ["0%", "+150%", "+200%", "new"]);
  assert.deepEqual(cells("subs/1k"), ["-", "2.00", "1.50", "1.50"], "no engaged views, no rate");
  assert.deepEqual(
    cells("vs prev", 1),
    ["-", "+500%", "+50%", "-"],
    "a rate needs engaged views on both sides",
  );
  assert.ok(cells("views")[0] === "55K" && cells("vs prev", 2)[0] === "×182");
  // The footer says what subs/1k is: gained, not net.
  assert.ok(out.includes("subs/1k = subscribers gained per 1,000 engaged views"), out);
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

// The range: the 28-day pace is the date, the last week's pace — when it was faster — the optimistic end.
{
  const now = Date.parse("2026-09-28T12:00:00Z");
  const g = (have: number, need: number, eta: string | null, recentEta?: string) => ({
    have,
    need,
    eta,
    recent: recentEta ? { ratePerDay: 5, eta: recentEta } : undefined,
  });
  const shorts = g(2583, 3e6, null);
  const t = {
    subscribers: g(92, 500, "2027-01-23", "2026-12-08"),
    watchHours: g(1198, 3000, "2026-11-12"),
    shortsViews: shorts,
  };
  assert.equal(
    tierCountdown(t, now),
    "<b>~117 days</b> (23 Jan; 8 Dec at the last week's pace) — subscribers hold it back",
  );
  // Hours would still be missing at the week's pace: the optimistic end is when hours land it.
  assert.ok(
    tierCountdown({ ...t, watchHours: g(1198, 3000, "2026-12-20") }, now).includes(
      "(23 Jan; 20 Dec at the last week's pace)",
    ),
  );
  // Hours hold the tier at either pace: nothing for the week to add.
  const hoursHold = tierCountdown({ ...t, watchHours: g(1198, 3000, "2027-03-01") }, now);
  assert.equal(hoursHold, "<b>~154 days</b> (1 Mar) — watch hours hold it back");
  // No faster week, no range.
  assert.ok(!tierCountdown({ ...t, subscribers: g(92, 500, "2027-01-23") }, now).includes("last week"));
  // More than a year out the date carries its year (a bare "3 Nov" reads as the coming one); the optimistic end, under a year, does not.
  const far = tierCountdown(
    { ...t, subscribers: g(92, 1000, "2027-11-03", "2027-05-21"), watchHours: g(1198, 3000, "2026-11-12") },
    now,
  );
  assert.ok(far.includes("(3 Nov 2027; 21 May at the last week's pace)"), far);
}

// The same range from a snapshot, through every Telegram surface that prints a subscriber ETA: the
// 28-day pace's date first, the week's after it in the same parentheses.
{
  const ypp = postMortemYpp();
  const full = renderYpp({ ok: true, data: ypp }, postMortemAt);
  assert.ok(
    full.includes(
      "<b>Expanded tier</b> — <b>~177 days</b> (26 Mar; 11 Jan at the last week's pace) — subscribers hold it back",
    ),
    full,
  );
  assert.ok(
    full.includes("<b>~400 days</b> (3 Nov 2027; 21 May at the last week's pace) — subscribers hold it back"),
    full,
  );
  assert.ok(full.includes("subs: 102/500 (20%) — ~177 days (26 Mar; 11 Jan at the last week's pace)"), full);
  assert.ok(
    full.includes("subs: 102/1,000 (10%) — ~400 days (3 Nov 2027; 21 May at the last week's pace)"),
    full,
  );
  assert.ok(
    full.includes("watch hours: 1,456/3,000 (49%) — ~33 days (2 Nov)\n"),
    "hours keep their own date, no range",
  );
  assert.ok(full.includes("at 2.25 subs/day over 28 days (3.86 in the last week)"), full);
  // The full tier leads, judged by the 2027 thresholds since it lands after 1 Feb 2027.
  assert.ok(full.startsWith("<b>🎯 YPP</b> · full tier <b>~400 days</b>"), full);
  assert.ok(full.includes("<b>Full tier (ads)</b> — 1,000 subs, and 8,000 h or 20M Shorts views"), full);

  const [head, subs] = renderYppShort({ ok: true, data: ypp }, postMortemAt).split("\n");
  assert.equal(
    head,
    "<b>🎯 YPP</b> · full tier <b>~400 days</b> (3 Nov 2027; 21 May at the last week's pace) · expanded tier ~177 days (26 Mar; 11 Jan at the last week's pace)",
  );
  assert.equal(
    subs,
    "Subscribers 102/1,000 (~400 d) at 2.3/day over 28 days · watch hours 1,456/8,000 (~140 d)",
  );

  // A week no faster than the month adds nothing: the date alone, and no last-week rate.
  const calm = postMortemYpp({ subscribersPer7d: 14 });
  const calmFull = renderYpp({ ok: true, data: calm }, postMortemAt);
  assert.ok(
    !calmFull.includes("last week") &&
      !renderYppShort({ ok: true, data: calm }, postMortemAt).includes("last week"),
  );
  assert.ok(calmFull.includes("subs: 102/1,000 (10%) — ~400 days (3 Nov 2027)"), calmFull);
}

console.log("report: all checks passed");
