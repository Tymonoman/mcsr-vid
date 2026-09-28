/**
 * Turns `ReportFacts` (facts.ts) plus agy's answer (agy.ts) into the morning report's text —
 * every number, list and link rendered deterministically; agy only supplies the headline and the
 * to-do list's wording. HTML-escaped throughout (Telegram's `parse_mode: "HTML"`), and the whole
 * report capped at 4096 characters.
 */
import { escapeHtml, MESSAGE_MAX_CHARS } from "./bot.js";
import type { AgyAnswer } from "./agy.js";
import type {
  AlertItem,
  ChannelSnapshot,
  CommentsFacts,
  HealthCheck,
  OvernightFacts,
  ReportFacts,
  StatsFacts,
  TodoFacts,
} from "./facts.js";
import type { WindowDays } from "./windowStats.js";
import type { NightlyFacts, UpcomingRow } from "./facts.js";
import type { NightlyLastRun } from "../dashboard/nightly.js";

/** One line for a nightly run's record: skipped runs (no matchId) read as just their reason. */
function nightlySummary(n: NightlyLastRun): string {
  if (n.outcome === "skipped") return n.reason ?? "skipped";
  let said = n.reason ? `${n.outcome}: ${n.reason}` : n.outcome;
  if (n.export) said += ` · export ${n.export}`;
  if (n.pick) said += ` · picked by ${n.pick === "agy" ? "the model" : "the heuristic"}`;
  return said;
}

const nightlyTarget = (n: NightlyLastRun): string =>
  n.matchId === null ? "" : `#${n.matchId} ${escapeHtml(n.players.join(" vs "))} — `;

const b = (s: string): string => `<b>${escapeHtml(s)}</b>`;
const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US");
const fmtDelta = (n: number): string => (n > 0 ? `+${fmtInt(n)}` : n < 0 ? fmtInt(n) : "0");
const pctDelta = (curr: number, prev: number): string => {
  if (prev === 0) return curr === 0 ? "0%" : "new";
  const pct = ((curr - prev) / prev) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
};
const mmss = (ms: number): string =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const hoursOf = (minutes: number): string => `${(minutes / 60).toFixed(1)} h`;
const shortDate = (iso: string | null): string => (iso ? iso.slice(0, 10) : "?");
const whenUtc = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;

function sectionError(title: string, error: string): string {
  return `${b(title)}\n${escapeHtml(error)}`;
}

/* --- 1. TODAY ------------------------------------------------------------------------------ */

export function renderToday(
  todo: ReportFacts["todo"],
  agy: { source: "agy" | "fallback"; answer: AgyAnswer; note?: string },
  dashboardBaseUrl: string,
): string {
  const lines = [b(agy.answer.headline)];
  for (const item of agy.answer.todo) lines.push(`• ${escapeHtml(item)}`);
  if (agy.source === "fallback") lines.push(`<i>agy unavailable: ${escapeHtml(agy.note ?? "unknown reason")}</i>`);
  if (agy.answer.notes?.length) {
    lines.push("", ...agy.answer.notes.map((n) => `⚠ ${escapeHtml(n)}`));
  }
  if (todo.ok && todo.data.waitingForHook.length) {
    lines.push(
      "",
      `<b>Waiting for a hook</b> (${todo.data.waitingForHook.length}):`,
      ...todo.data.waitingForHook
        .slice(0, 10)
        .map((w) => `#${w.matchId} ${escapeHtml(w.players)} — ${escapeHtml(dashboardBaseUrl)}/`),
    );
  }
  if (!todo.ok) lines.push("", escapeHtml(`(today's facts: ${todo.error})`));
  return lines.join("\n");
}

/** The rule-based to-do list agy's answer stands in for — CLAUDE.md's own priority order:
 *  failed, then waiting for a hook, then running, scheduled, published. */
export function fallbackToday(todo: TodoFacts | null, alertCount: number, unansweredCount: number): AgyAnswer {
  const items: string[] = [];
  if (alertCount > 0) items.push(`${alertCount} alert${alertCount === 1 ? "" : "s"} ${alertCount === 1 ? "needs" : "need"} a look (see ALERTS)`);
  if (todo?.waitingForHook.length) {
    items.push(
      `save hooks for ${todo.waitingForHook.length} match${todo.waitingForHook.length === 1 ? "" : "es"}: ` +
        todo.waitingForHook
          .slice(0, 5)
          .map((w) => `#${w.matchId}`)
          .join(", "),
    );
  }
  if (todo && todo.scheduledToday.length === 0 && todo.scheduledTomorrowCount === 0) {
    items.push("nothing scheduled today or tomorrow — the channel goes quiet without a new hook saved");
  }
  if (unansweredCount > 0) items.push(`${unansweredCount} unanswered comment${unansweredCount === 1 ? "" : "s"}`);
  if (todo?.diskLow) items.push(`disk is low (${todo.diskMatchesLeft} matches left) — archive or free space`);
  if (todo?.playoffsSoon) items.push(`playoffs: ${todo.playoffsSoon.round} coming up`);
  if (items.length === 0) items.push("nothing needs you — check /stats for how the channel is doing");
  return { headline: "Morning report", todo: items.slice(0, 8) };
}

/* --- 2. ALERTS ------------------------------------------------------------------------------ */

export function renderAlerts(alerts: ReportFacts["alerts"]): string {
  if (!alerts.ok) return sectionError("ALERTS", alerts.error);
  if (alerts.data.length === 0) return `${b("ALERTS")}\nNo alerts.`;
  return [b("ALERTS"), ...alerts.data.map((a: AlertItem) => `✗ <b>${escapeHtml(a.source)}</b>: ${escapeHtml(a.message)}`)].join(
    "\n",
  );
}

/* --- 3. HEALTH ------------------------------------------------------------------------------ */

export function renderHealth(health: HealthCheck[]): string {
  if (health.length === 0) return `${b("HEALTH")}\n(nothing to check)`;
  const lines = health.map((h) => {
    const mark = h.ok ? "✔" : "✗";
    const ms = h.ms !== undefined ? ` (${h.ms} ms)` : "";
    const detail = h.detail ? ` — ${escapeHtml(h.detail)}` : "";
    return `${mark} ${escapeHtml(h.name)}${ms}${detail}`;
  });
  return [b("HEALTH"), ...lines].join("\n");
}

/* --- 4. OVERNIGHT --------------------------------------------------------------------------- */

export function renderOvernight(overnight: ReportFacts["overnight"]): string {
  if (!overnight.ok) return sectionError("OVERNIGHT", overnight.error);
  const { uploaded, nowPublic, nightlyRendered } = overnight.data;
  const lines = [b("OVERNIGHT")];
  if (nightlyRendered) {
    lines.push(`Nightly: ${nightlyTarget(nightlyRendered)}${escapeHtml(nightlySummary(nightlyRendered))}`);
  }
  if (uploaded.length === 0 && nowPublic.length === 0 && !nightlyRendered) {
    lines.push("Nothing uploaded and nothing went public overnight.");
  }
  for (const u of uploaded) {
    lines.push(
      `Uploaded (${u.kind}): #${u.matchId} ${escapeHtml(u.players)} — https://youtu.be/${u.videoId}`,
    );
  }
  for (const p of nowPublic) {
    lines.push(
      `Now public (${p.kind}, by its publish time): #${p.matchId} ${escapeHtml(p.players)} — https://youtu.be/${p.videoId}`,
    );
  }
  if (nowPublic.length) {
    lines.push("<i>(publish time passed — not a live re-check; a record's status is never updated after upload)</i>");
  }
  return lines.join("\n");
}

/* --- 5. STATS -------------------------------------------------------------------------------- */

const STATS_METRIC_LABELS: Record<string, string> = {
  views: "views",
  engagedViews: "engaged views",
  estimatedMinutesWatched: "watch time",
  subscribersGained: "subs gained",
  subscribersLost: "subs lost",
  likes: "likes",
  comments: "comments",
};

function renderWindow(days: WindowDays, stats: StatsFacts): string {
  const w = stats.windows[days];
  const views = w.current.views ?? 0;
  const viewsPrev = w.previous.views ?? 0;
  const engaged = w.current.engagedViews ?? 0;
  const watch = hoursOf(w.current.estimatedMinutesWatched ?? 0);
  const netSubs = (w.current.subscribersGained ?? 0) - (w.current.subscribersLost ?? 0);
  const avgViewSec = views > 0 ? Math.round(((w.current.estimatedMinutesWatched ?? 0) * 60) / views) : 0;
  const short = w.currentDays < days ? ` (${w.currentDays}/${days} d)` : "";
  return (
    `<b>${days}d</b>${short}: ${fmtInt(views)} views (${pctDelta(views, viewsPrev)}) · ` +
    `${fmtInt(engaged)} engaged · ${watch} · ${fmtDelta(netSubs)} subs · ` +
    `avg ${mmss(avgViewSec * 1000)} · ${fmtInt(w.current.likes ?? 0)} likes · ${fmtInt(w.current.comments ?? 0)} comments`
  );
}

export function renderStats(
  stats: ReportFacts["stats"],
  prevSnapshot: ChannelSnapshot | null,
  windows: readonly WindowDays[] = [1, 3, 7, 30],
): string {
  if (!stats.ok) return sectionError("STATS", stats.error);
  const { live, dataEndsOn } = stats.data;
  const lines = [b("STATS")];
  const liveLine = prevSnapshot
    ? `${fmtInt(live.subscribers)} subs (${fmtDelta(live.subscribers - prevSnapshot.subscribers)}) · ` +
      `${fmtInt(live.views)} views (${fmtDelta(live.views - prevSnapshot.views)}) · ` +
      `${fmtInt(live.videos)} videos (${fmtDelta(live.videos - prevSnapshot.videos)})`
    : `${fmtInt(live.subscribers)} subs · ${fmtInt(live.views)} views · ${fmtInt(live.videos)} videos (no earlier snapshot yet)`;
  lines.push(liveLine);
  if (dataEndsOn) lines.push(`<i>Analytics data through ${escapeHtml(dataEndsOn)} (it lags 1–3 days)</i>`);
  for (const d of windows) lines.push(renderWindow(d, stats.data));
  return lines.join("\n");
}

/* --- 6. COMMENTS ------------------------------------------------------------------------------ */

export function renderComments(comments: ReportFacts["comments"]): string {
  if (!comments.ok) return sectionError("COMMENTS", comments.error);
  const { unanswered, videoTitles } = comments.data;
  const lines = [b("COMMENTS")];
  if (unanswered.length === 0) {
    lines.push("No unanswered comments.");
    return lines.join("\n");
  }
  lines.push(`${unanswered.length} unanswered:`);
  for (const c of unanswered.slice(0, 8)) {
    const title = videoTitles[c.videoId] ?? c.videoId;
    const excerpt = c.text.replace(/\s+/g, " ").slice(0, 80);
    const studio = `https://studio.youtube.com/video/${c.videoId}/comments`;
    const uncertain = c.repliesTruncated ? " <i>(more replies than shown — may be answered)</i>" : "";
    lines.push(
      `<b>${escapeHtml(c.author)}</b> on “${escapeHtml(title)}”: ${escapeHtml(excerpt)}${uncertain}\n` +
        `https://www.youtube.com/watch?v=${c.videoId}&lc=${c.threadId} · ${studio}`,
    );
  }
  lines.push(`Inbox: https://studio.youtube.com/channel/${escapeHtml(CHANNEL_ID_PLACEHOLDER)}/comments/inbox`);
  return lines.join("\n");
}
/** Filled in by report.ts's caller (the channel id is config, not a fact worth threading through). */
export const CHANNEL_ID_PLACEHOLDER = "__CHANNEL_ID__";

/* --- 7. YPP ------------------------------------------------------------------------------------ */

function gateLine(name: string, g: { have: number; need: number; eta: string | null; ceiling?: number }): string {
  const pct = g.need > 0 ? Math.min(100, Math.round((g.have / g.need) * 100)) : 100;
  if (g.have >= g.need) return `${name}: ${fmtInt(g.have)}/${fmtInt(g.need)} — done`;
  if (g.ceiling !== undefined && g.ceiling < g.need) {
    return `${name}: ${fmtInt(g.have)}/${fmtInt(g.need)} (${pct}%) — unreachable at the current rate`;
  }
  const eta = g.eta ? shortDate(g.eta) : "unknown";
  return `${name}: ${fmtInt(g.have)}/${fmtInt(g.need)} (${pct}%) — ETA ${eta}`;
}

export function renderYpp(ypp: ReportFacts["ypp"]): string {
  if (!ypp.ok) return sectionError("YPP", ypp.error);
  const p = ypp.data;
  const lines = [
    b("YPP"),
    `<i>Rates: ${p.subscribers.ratePerDay.toFixed(2)} subs/d · ${p.watchHours.ratePerDay.toFixed(1)} h/d · ${fmtInt(p.shortsViews.ratePerDay)} engaged Shorts views/d</i>`,
    "<u>Expanded tier</u> (500 subs, 3 uploads/90d, 3,000 h or 3M Shorts views):",
    gateLine("subs", p.subscribers),
    gateLine("watch hours", p.watchHours),
    gateLine("Shorts views", p.shortsViews),
    `uploads (90d): ${p.tiers.expanded.uploads90d.have ?? "?"}/${p.tiers.expanded.uploads90d.need}`,
    "<u>Full tier</u>:",
    gateLine("subs", p.tiers.full.subscribers),
    gateLine("watch hours", p.tiers.full.watchHours),
    gateLine("Shorts views", p.tiers.full.shortsViews),
  ];
  return lines.join("\n");
}

/* --- /waiting, /overnight's 7-day schedule, /nightly ------------------------------------------ */

export function renderWaiting(todo: ReportFacts["todo"], dashboardBaseUrl: string): string {
  if (!todo.ok) return sectionError("WAITING FOR A HOOK", todo.error);
  const rows = todo.data.waitingForHook;
  if (rows.length === 0) return `${b("WAITING FOR A HOOK")}\nNothing waiting.`;
  return [
    b("WAITING FOR A HOOK"),
    ...rows.map((w) => `#${w.matchId} ${escapeHtml(w.players)} — ${escapeHtml(dashboardBaseUrl)}/`),
  ].join("\n");
}

const DAY_LABEL = (offset: number): string => (offset === 0 ? "today" : offset === 1 ? "tomorrow" : `in ${offset} days`);

export function renderUpcoming(rows: readonly UpcomingRow[], days: number): string {
  if (rows.length === 0) return `Nothing scheduled in the next ${days} days.`;
  const lines = [`<b>Next ${days} days</b>:`];
  for (const r of rows) {
    lines.push(`${DAY_LABEL(r.dayOffset)} — #${r.matchId} ${escapeHtml(r.players)} (${r.kind}) at ${whenUtc(r.at)}`);
  }
  return lines.join("\n");
}

export function renderNightly(n: NightlyFacts): string {
  const lines = [b("NIGHTLY")];
  lines.push(`Scheduled for ${n.hourUtc === null ? "off" : `${String(n.hourUtc).padStart(2, "0")}:00 UTC`}.`);
  if (n.lastRun) {
    lines.push(
      `Last run (${whenUtc(n.lastRun.startedAt)}): ${nightlyTarget(n.lastRun)}${escapeHtml(nightlySummary(n.lastRun))}`,
    );
  } else {
    lines.push("No run recorded yet.");
  }
  if (n.queue.length) {
    lines.push(`Queued tonight: ${n.queue.map((q) => `#${q.matchId} ${escapeHtml(q.players)}`).join(", ")}`);
  } else {
    lines.push("Nothing queued — tonight renders the top of the dashboard's own suggestion order.");
  }
  if (n.skipped.length) lines.push(`Marked "not at night": ${n.skipped.map((id) => `#${id}`).join(", ")}`);
  return lines.join("\n");
}

/* --- Assembling one message ------------------------------------------------------------------- */

/**
 * Fits as many sections as it can, in the given (priority) order, into `max` characters. Stops at
 * the first one that would not fit — later sections are lower priority by the spec's own
 * ordering, so skipping ahead to a smaller one out of order would misrepresent the report.
 */
export function assembleReport(sections: readonly string[], max = MESSAGE_MAX_CHARS): string {
  const note = "\n\n(truncated — the rest is a command away: /alerts /health /overnight /stats /comments /ypp)";
  let out = "";
  let dropped = false;
  for (const s of sections) {
    const candidate = out ? `${out}\n\n${s}` : s;
    if (candidate.length > max - note.length) {
      dropped = true;
      break;
    }
    out = candidate;
  }
  return dropped ? `${out}${note}` : out;
}

/** The whole morning report, one message. */
export function renderMorningReport(
  facts: ReportFacts,
  agy: { source: "agy" | "fallback"; answer: AgyAnswer; note?: string },
  prevSnapshot: ChannelSnapshot | null,
  channelId: string,
): string {
  const sections = [
    renderToday(facts.todo, agy, facts.dashboardBaseUrl),
    renderAlerts(facts.alerts),
    renderHealth(facts.health),
    renderOvernight(facts.overnight),
    renderStats(facts.stats, prevSnapshot),
    renderComments(facts.comments).replace(CHANNEL_ID_PLACEHOLDER, channelId),
    renderYpp(facts.ypp),
  ];
  return assembleReport(sections);
}
