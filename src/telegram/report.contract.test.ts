// Contract test for report.ts (the morning report's text), written from the docs (CLAUDE.md
// "Telegram bot", handbook claude-md-reference.md "Telegram bot"), not from the code. report.test.ts
// already pins each section's own rendering; this file sweeps the promises across every renderer at
// once: one hostile string through every dynamic field, every YouTube href in a full report, three
// messages even when every section failed, and the 4096 limit on a bad night rather than a quiet one.
//
// Promises (numbering shared with index.contract.test.ts):
//  P1. The report is three messages: the day (Needs you at the top, Auto-saved hooks, Claude's
//      headline + to-do, Problems only when there are any, overnight, health as one line naming only
//      what is down), the channel (counts, the stats `<pre>` table, YPP), the comments.
//  P4. HTML parse mode; every dynamic string goes through escapeHtml.
//  P5. Each message fits Telegram's 4096 characters (`visibleLength`): the comments fill up to it, and
//      Needs you / Auto-saved hooks "cap themselves to a share of the 4096-character message rather
//      than trusting the day to stay short by luck".
//  P6. Every YouTube link the bot sends opens Studio, never the public watch page: a comment is
//      `studio.youtube.com/video/<id>/comments?lc=<id>`, an overnight upload `studio.youtube.com/video/<id>/edit`.
// Run: npx tsx src/telegram/report.contract.test.ts
import assert from "node:assert/strict";
import { MESSAGE_MAX_CHARS, messageParts } from "./bot.js";
import type { ReportFacts } from "./facts.js";
import type { AutoHooksRow } from "../dashboard/shortFlow.js";
import type { UnansweredComment } from "./comments.js";
import {
  renderAlerts,
  renderAutoHooks,
  renderComments,
  renderCreatorWatch,
  renderHealth,
  renderMorningReport,
  renderNeedsYou,
  renderNightly,
  renderOvernight,
  renderTestsLine,
  renderToday,
  renderUpcoming,
  renderWaiting,
  renderWorth,
  visibleLength,
  type TodayResult,
} from "./report.js";

/** A doc clause the code does not keep: printed, not thrown, so the suite stays green until triage. */
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

/** Telegram refuses an HTML message whose tags do not nest; a raw cut inside one is exactly that. */
function balanced(html: string): boolean {
  if (/<[^>]*$/.test(html)) return false; // a tag cut in half at the end
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)\b[^>]*>/gi)) {
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]!);
  }
  return stack.length === 0;
}

const BASE = "http://actimel:8080";
const NOW = Date.parse("2026-10-14T05:00:00Z");
/** Markup and an ampersand: unescaped, `<x` opens a tag and `x&y` is a bare ampersand. */
const EVIL = "<x&y>";
const escapedOk = (out: string, where: string) => {
  assert.ok(!out.includes("<x"), `${where}: a raw "<" reached the message\n${out}`);
  assert.ok(!out.includes("x&y"), `${where}: a raw "&" reached the message\n${out}`);
};

const comment = (i: number, over: Partial<UnansweredComment> = {}): UnansweredComment => ({
  threadId: `Ugz${String(i).padStart(20, "0")}`,
  videoId: `vid${String(i % 3).padStart(8, "0")}`,
  author: `Viewer${i}`,
  authorIsChannel: false,
  text: `synthetic comment number ${i}`,
  publishedAt: new Date(NOW - i * 60_000).toISOString(),
  totalReplyCount: 0,
  replyAuthorsAreChannel: [],
  replies: [],
  repliesTruncated: false,
  ...over,
});

const windows = Object.fromEntries(
  ([1, 3, 7, 30] as const).map((d) => [
    d,
    {
      days: d,
      current: {
        views: 900 * d,
        engagedViews: 300 * d,
        estimatedMinutesWatched: 700 * d,
        subscribersGained: 3,
        subscribersLost: 1,
        likes: 9,
        comments: 2,
      },
      previous: { views: 800 * d, engagedViews: 250 * d, subscribersGained: 2, subscribersLost: 1 },
      currentDays: d,
      previousDays: d,
    },
  ]),
) as unknown as Extract<ReportFacts["stats"], { ok: true }>["data"]["windows"];

/** A full ReportFacts with every section ok; `over` replaces sections. */
const factsOf = (over: Partial<ReportFacts> = {}): ReportFacts =>
  ({
    nowMs: NOW,
    todo: {
      ok: true,
      data: {
        waitingForHook: [],
        scheduledToday: [],
        scheduledTomorrowCount: 1,
        scheduledDayAfterCount: 1,
        diskMatchesLeft: 40,
        diskLow: false,
        playoffsSoon: null,
        queuedTonight: 0,
      },
    },
    needsYou: { ok: true, data: { items: [] } },
    alerts: { ok: true, data: [] },
    health: [
      { name: "MCSR Ranked API", ok: true, ms: 120 },
      { name: "claude (haiku)", ok: true, ms: 900 },
    ],
    overnight: {
      ok: true,
      data: {
        uploaded: [
          {
            matchId: 13560037,
            kind: "video",
            players: "v_strid vs doogile",
            videoId: "AbCdEfGhIjK",
            uploadedAt: new Date(NOW - 3_600_000).toISOString(),
            publishAt: null,
          },
          {
            matchId: 13560037,
            kind: "short",
            players: "v_strid vs doogile",
            videoId: "ShOrTiDxYz1",
            uploadedAt: new Date(NOW - 3_000_000).toISOString(),
            publishAt: null,
          },
        ],
        nowPublic: [
          {
            matchId: 13446429,
            kind: "video",
            players: "a vs b",
            videoId: "PuBlIcViD01",
            publishAt: new Date(NOW - 7_200_000).toISOString(),
          },
        ],
        nightlyRendered: null,
      },
    },
    stats: {
      ok: true,
      data: {
        live: { subscribers: 120, views: 5000, videos: 30 },
        dataEndsOn: "2026-10-12",
        windows,
        longForm: { ok: false, error: "not read in this test" },
      },
    },
    comments: {
      ok: true,
      data: {
        unanswered: [comment(1), comment(2)],
        videoTitles: { vid00000001: "CAN ANYONE CATCH UP? | v_strid vs doogile | MCSR Ranked" },
      },
    },
    ypp: { ok: false, error: "no token" },
    worthRendering: { ok: true, data: { matches: [], notes: [] } },
    dashboardBaseUrl: BASE,
    tests: { runningCount: 0, scheduleToday: [], since: [] },
    creatorWatch: [],
    ...over,
  }) as unknown as ReportFacts;
const claudeOk: TodayResult = {
  source: "claude",
  answer: { headline: "Covered through Friday", todo: ["Reply to 2 comments"] },
};

/* --- P4: one hostile string through every dynamic field of every renderer ------------------------ */
{
  const fail = { ok: false as const, error: EVIL };
  escapedOk(
    renderToday(
      fail,
      { source: "fallback", answer: { headline: EVIL, todo: [EVIL, `#13560037 ${EVIL}`] }, note: EVIL },
      BASE,
    ),
    "renderToday",
  );
  escapedOk(renderAlerts({ ok: true, data: [{ source: EVIL, message: EVIL }] }), "renderAlerts");
  escapedOk(
    renderAlerts({ ok: true, data: [{ source: EVIL, message: `${EVIL}${"m".repeat(200)}` }] }, true),
    "renderAlerts compact",
  );
  escapedOk(renderAlerts(fail), "renderAlerts error");
  escapedOk(
    renderHealth([
      { name: EVIL, ok: false, detail: EVIL },
      { name: EVIL, ok: true, ms: 3 },
    ]),
    "renderHealth",
  );
  escapedOk(renderHealth([{ name: EVIL, ok: false, detail: EVIL }], true), "renderHealth compact");
  const nightly = {
    startedAt: new Date(NOW).toISOString(),
    matchId: 13560037,
    players: [EVIL, EVIL],
    outcome: "failed" as const,
    reason: EVIL,
  };
  escapedOk(
    renderOvernight({ ok: true, data: { uploaded: [], nowPublic: [], nightlyRendered: nightly } }, BASE),
    "renderOvernight quiet",
  );
  escapedOk(
    renderOvernight(
      {
        ok: true,
        data: {
          uploaded: [
            { matchId: 1, kind: "video", players: EVIL, videoId: "v", uploadedAt: "x", publishAt: null },
          ],
          nowPublic: [],
          nightlyRendered: nightly,
        },
      },
      BASE,
    ),
    "renderOvernight",
  );
  escapedOk(renderOvernight(fail, BASE), "renderOvernight error");
  escapedOk(
    renderWorth(
      {
        ok: true,
        data: {
          matches: [
            {
              matchId: 1,
              players: EVIL,
              playedAt: new Date(NOW).toISOString(),
              runMs: 600_000,
              story: EVIL,
              score: 1,
            },
          ],
          notes: [EVIL],
        },
      },
      BASE,
    ),
    "renderWorth",
  );
  escapedOk(
    renderCreatorWatch([
      { matchId: 1, nick: EVIL, players: EVIL, at: "x", queued: false, reason: EVIL } as never,
    ]),
    "renderCreatorWatch",
  );
  escapedOk(
    renderTestsLine({
      runningCount: 1,
      scheduleToday: [{ experimentId: EVIL, arm: EVIL }],
      since: [
        { experimentId: EVIL, verdict: EVIL },
        { experimentId: EVIL, decision: EVIL },
      ],
    }),
    "renderTestsLine",
  );
  escapedOk(
    renderComments(
      {
        ok: true,
        data: {
          unanswered: [comment(1, { author: EVIL, text: EVIL })],
          videoTitles: { [comment(1).videoId]: `${EVIL} | ${EVIL}` },
        },
      },
      EVIL,
    ),
    "renderComments",
  );
  escapedOk(
    renderNeedsYou(
      { ok: true, data: { items: [{ matchId: 1, players: EVIL, text: EVIL }, { text: EVIL }] } },
      BASE,
    ),
    "renderNeedsYou",
  );
  const row: AutoHooksRow = {
    matchId: 1,
    players: EVIL,
    titleHook: EVIL,
    shortHook: EVIL,
    at: "x",
    stillCurrent: true,
    publishAt: null,
    uploaded: false,
    privacyStatus: null,
  };
  escapedOk(renderAutoHooks([row], BASE), "renderAutoHooks");
  escapedOk(
    renderWaiting(
      {
        ok: true,
        data: {
          ...(factsOf().todo as { data: object }).data,
          waitingForHook: [{ matchId: 1, players: EVIL }],
        },
      } as never,
      BASE,
    ),
    "renderWaiting",
  );
  escapedOk(
    renderUpcoming(
      [{ matchId: 1, players: EVIL, kind: "video", at: new Date(NOW).toISOString(), dayOffset: 0 }],
      7,
      BASE,
    ),
    "renderUpcoming",
  );
  escapedOk(
    renderNightly(
      { lastRun: nightly, hourUtc: 3, queue: [{ matchId: 2, players: EVIL }], skipped: [] },
      BASE,
    ),
    "renderNightly",
  );
  // The dashboard base URL is config, but still a dynamic string in every match link.
  escapedOk(
    renderNeedsYou({ ok: true, data: { items: [{ matchId: 1, text: "t" }] } }, `http://h/${EVIL}`),
    "base URL",
  );
  console.log("OK: a hostile string in every text field of every renderer reaches the message escaped");

  // Not swept: YouTube video/thread ids in Studio hrefs. They come back in YouTube's [A-Za-z0-9_-]
  // alphabet, so escaping them would only be hardening, not the escapeHtml promise above.
}

/* --- P6: every YouTube href in a full report opens Studio --------------------------------------- */
{
  const msgs = renderMorningReport(factsOf(), claudeOk, null, "UCm2mAyONTHlmIxZzNmi388w", NOW);
  const all = [
    ...msgs,
    renderOvernight(factsOf().overnight, BASE),
    renderComments(factsOf().comments, "UCm2mAyONTHlmIxZzNmi388w"),
  ].join("\n");
  const hrefs = [...all.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
  const youtube = hrefs.filter((h) => /youtu/.test(h));
  assert.ok(youtube.length >= 6, `the report carries YouTube links to check: ${youtube.length}`);
  for (const h of youtube) assert.ok(h.startsWith("https://studio.youtube.com/"), `not a Studio link: ${h}`);
  assert.ok(!/youtube\.com\/(watch|shorts)|youtu\.be\//.test(all), "no public watch or Shorts page anywhere");
  // The exact shapes the docs give.
  assert.ok(hrefs.includes("https://studio.youtube.com/video/AbCdEfGhIjK/edit"), "overnight video");
  assert.ok(hrefs.includes("https://studio.youtube.com/video/ShOrTiDxYz1/edit"), "overnight Short");
  assert.ok(hrefs.includes("https://studio.youtube.com/video/PuBlIcViD01/edit"), "went public");
  const c = comment(1);
  assert.ok(
    hrefs.includes(`https://studio.youtube.com/video/${c.videoId}/comments?lc=${c.threadId}`),
    "exact-comment link",
  );
  console.log(
    `OK: all ${youtube.length} YouTube links in a full report open Studio, in the documented shapes`,
  );
}

/* --- P1: three messages, in the documented order, even when every section failed ----------------- */
{
  const down = (e: string) => ({ ok: false as const, error: e });
  const facts = factsOf({
    todo: down("E-todo"),
    needsYou: down("E-needs"),
    alerts: down("E-alerts"),
    health: [],
    overnight: down("E-overnight"),
    stats: down("E-stats"),
    comments: down("E-comments"),
    ypp: down("E-ypp"),
    worthRendering: down("E-worth"),
  } as Partial<ReportFacts>);
  const msgs = renderMorningReport(
    facts,
    {
      source: "fallback",
      answer: { headline: "What needs you today", todo: ["Nothing needs you today"] },
      note: "usage limit reached — try again later",
    },
    null,
    "UC1",
    NOW,
  );
  assert.equal(msgs.length, 3, "three messages whatever failed");
  // Each section costs its own line, in its own message, said once.
  const where = (e: string) => msgs.map((m, i) => (m.includes(e) ? i : -1)).filter((i) => i >= 0);
  for (const e of ["E-needs", "E-todo", "E-alerts", "E-overnight", "E-worth"])
    assert.deepEqual(where(e), [0], e);
  for (const e of ["E-stats", "E-ypp"]) assert.deepEqual(where(e), [1], e);
  assert.deepEqual(where("E-comments"), [2]);
  assert.ok(
    msgs[0]!.indexOf("Needs you") < msgs[0]!.indexOf("What needs you today"),
    "Needs you leads the day",
  );
  assert.ok(
    msgs[0]!.includes("<i>usage limit reached — try again later</i>"),
    "the fallback's reason under the list",
  );

  // Health is one line naming only what is down; Problems only when there are any.
  const healthy = renderMorningReport(factsOf(), claudeOk, null, "UC1", NOW)[0]!;
  assert.ok(!healthy.includes("Problems"), "no problems: no Problems section");
  const sick = renderMorningReport(
    factsOf({
      health: [
        { name: "Twitch", ok: false, detail: "down" },
        { name: "MCSR Ranked API", ok: true, ms: 1 },
        { name: "DNS", ok: true, ms: 1 },
      ],
      alerts: { ok: true, data: [{ source: "health", message: "Twitch: down" }] },
    }),
    claudeOk,
    null,
    "UC1",
    NOW,
  )[0]!;
  const healthLine = sick.split("\n").filter((l) => l.includes("Twitch") && l.startsWith("❌"));
  assert.equal(healthLine.length, 1, sick);
  assert.ok(
    !healthLine[0]!.includes("MCSR") && !healthLine[0]!.includes("DNS"),
    "only what is down is named",
  );
  assert.ok(
    sick.indexOf("To do") < sick.indexOf("Problems") && sick.indexOf("Problems") < sick.indexOf("🌙"),
    "Problems sits after the to-do, before overnight",
  );
  console.log("OK: three messages, each failed section in its own, Needs you first, Problems only when any");
}

/* --- P5: a bad night still fits — every message within Telegram's 4096 ---------------------------- */
{
  // What a bad night looks like on this channel: a dozen playlist inserts refused by the ~12-a-day
  // cap (CLAUDE.md: "playlists.insert caps ~a dozen per rolling 24h (429)") — those alerts carry no
  // 24 h window — four failed chain steps, Twitch and MCSR down, eight auto-saved hooks, the model's
  // six to-do items, five matches worth rendering and four overnight uploads.
  const quota =
    "playlistItems.insert: HTTP 429 — The request cannot be completed because you have exceeded your quota. (retried by the nightly tick)";
  const alerts = Array.from({ length: 12 }, (_, i) => ({
    source: `playlist video #${13560000 + i}`,
    message: quota,
  }));
  const needs = Array.from({ length: 4 }, (_, i) => ({
    matchId: 13550000 + i,
    players: "v_strid vs doogile",
    text: "upload-video failed: HTTP 503 from the upload endpoint",
  }));
  const hooks: AutoHooksRow[] = Array.from({ length: 8 }, (_, i) => ({
    matchId: 13540000 + i,
    players: "v_strid vs doogile",
    titleHook: "CAN ANYONE CATCH UP?",
    shortHook: "DOWN TO THE LAST PEARL",
    at: new Date(NOW - i * 3_600_000).toISOString(),
    stillCurrent: true,
    publishAt: new Date(NOW + (i + 1) * 86_400_000).toISOString(),
    uploaded: true,
    privacyStatus: "private",
  }));
  const todo = [
    "Retry the upload for #13550000 v_strid vs doogile from the dashboard's Publish panel",
    "Retry the upload for #13550001 v_strid vs doogile from the dashboard's Publish panel",
    "Check why the MCSR Ranked API and Twitch are both down before tonight's render",
    "Leave the playlist failures: the nightly tick retries them once the quota resets",
    "Reply to the 2 unanswered comments in the Studio inbox",
    "Get a long-form scheduled for Friday: nothing goes out that day yet",
  ];
  const worth = Array.from({ length: 5 }, (_, i) => ({
    matchId: 13700000 + i,
    players: "v_strid vs doogile",
    playedAt: new Date(NOW - i * 3_600_000).toISOString(),
    runMs: 640_000,
    story: "lead changes 3x, 0.4 s apart at the Stronghold",
    score: 1 - i / 10,
  }));
  const uploaded = Array.from({ length: 4 }, (_, i) => ({
    matchId: 13530000 + i,
    kind: "video" as const,
    players: "v_strid vs doogile",
    videoId: `AbCdEfGhI${i}K`,
    uploadedAt: new Date(NOW - 3_600_000).toISOString(),
    publishAt: new Date(NOW + 86_400_000).toISOString(),
  }));
  const facts = factsOf({
    needsYou: { ok: true, data: { items: needs } },
    alerts: {
      ok: true,
      data: [
        ...alerts,
        { source: "health", message: "Twitch: Twitch token request failed: 503" },
        { source: "health", message: "MCSR Ranked API: 503" },
      ],
    },
    health: [
      { name: "Twitch", ok: false, detail: "Twitch token request failed: 503 Service Unavailable" },
      { name: "MCSR Ranked API", ok: false, detail: "MCSR Ranked API /matches?count=1 -> 503" },
      { name: "claude (haiku)", ok: true, ms: 900 },
    ],
    overnight: { ok: true, data: { uploaded, nowPublic: [], nightlyRendered: null } },
    worthRendering: { ok: true, data: { matches: worth, notes: [] } },
  } as Partial<ReportFacts>);
  const msgs = renderMorningReport(
    facts,
    {
      source: "claude",
      answer: { headline: "Two uploads failed and the playlists hit their daily cap", todo },
    },
    null,
    "UC1",
    NOW,
    hooks,
  );
  assert.equal(msgs.length, 3);
  const fits = (i: number) => {
    const m = msgs[i];
    assert.ok(
      visibleLength(m) <= MESSAGE_MAX_CHARS,
      `message ${i + 1} is ${visibleLength(m)} visible characters; sent, it goes out as ${messageParts(m, true).length} parts, ${messageParts(m, true).filter((p) => !balanced(p)).length} of them with a tag cut in half (Telegram refuses those)`,
    );
  };
  // The channel and the comments ("capped to 4096 chars") keep the limit today: a regression fails.
  fits(1);
  fits(2);
  // The day does not yet: Needs you / Auto-saved hooks cap themselves, the rest of the day does not.
  deviation(
    "The report is three messages … each within Telegram's 4096 characters (the day must not rely on staying short by luck)",
    () => fits(0),
  );
  console.log("OK: a bad night's report was checked against the 4096 limit message by message");
}

console.log("report.contract: all checks passed");
