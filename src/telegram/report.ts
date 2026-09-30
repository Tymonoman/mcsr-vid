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
  // A window compared with one from before the channel had an audience reads as "+18070%": a ratio says it plainly.
  if (pct >= 1000) return `×${(curr / prev).toFixed(0)}`;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
};
const mmss = (ms: number): string =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const hoursOf = (minutes: number): string => `${(minutes / 60).toFixed(1)} h`;
const shortDate = (iso: string | null): string => (iso ? iso.slice(0, 10) : "?");
/** An instant as the operator's clock reads it: "Tue 29 Sept, 01:00" (Europe/Warsaw, DST-correct). */
export const whenWarsaw = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

function sectionError(title: string, error: string): string {
  return `${b(title)}\n${escapeHtml(error)}`;
}

/* --- Message 1: the morning (to-do, problems, overnight, health) ---------------------------- */

/** "Tue 29 Sep" on the operator's clock. */
const warsawDay = (nowMs: number): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(nowMs));

/** "9 Jan" — a date far enough out that the year and the weekday add nothing. */
const dayMonth = (ms: number): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(ms));

/** agy's headline and numbered to-do list, one dashboard link under it. `/todo` is this alone. */
export function renderToday(
  todo: ReportFacts["todo"],
  agy: { source: "agy" | "fallback"; answer: AgyAnswer; note?: string },
  dashboardBaseUrl: string,
): string {
  const lines = [`<b>${escapeHtml(agy.answer.headline)}</b>`, "", "<b>To do</b>"];
  agy.answer.todo.forEach((item, i) => lines.push(`${i + 1}. ${escapeHtml(item)}`));
  lines.push(`<a href="${escapeHtml(dashboardBaseUrl)}/">Open the dashboard</a>`);
  if (agy.source === "fallback")
    lines.push(`<i>agy unavailable (${escapeHtml(agy.note ?? "unknown reason")}) — a rule-based list</i>`);
  if (!todo.ok) lines.push(escapeHtml(`(today's facts: ${todo.error})`));
  return lines.join("\n");
}

/** The rule-based to-do list agy's answer stands in for — CLAUDE.md's own priority order:
 *  failed, then waiting for a hook, then running, scheduled, published. */
export function fallbackToday(
  todo: TodoFacts | null,
  alertCount: number,
  unansweredCount: number,
): AgyAnswer {
  const items: string[] = [];
  if (alertCount > 0) items.push(`Look at ${alertCount} problem${alertCount === 1 ? "" : "s"} (below)`);
  if (todo?.waitingForHook.length) {
    items.push(
      `Save hooks for ${todo.waitingForHook.length === 1 ? "" : `${todo.waitingForHook.length} matches: `}` +
        todo.waitingForHook
          .slice(0, 5)
          .map((w) => `#${w.matchId} ${w.players}`)
          .join(", "),
    );
  }
  if (todo && todo.scheduledToday.length === 0 && todo.scheduledTomorrowCount === 0) {
    items.push("Get something scheduled: nothing goes out today or tomorrow");
  }
  if (unansweredCount > 0)
    items.push(`Reply to ${unansweredCount} comment${unansweredCount === 1 ? "" : "s"}`);
  if (todo?.diskLow) items.push(`Free some disk: ${todo.diskMatchesLeft} matches of space left`);
  if (todo?.playoffsSoon) items.push(`Get ready for the playoffs: ${todo.playoffsSoon.round}`);
  if (items.length === 0) items.push("Nothing needs you today");
  return { headline: "What needs you today", todo: items.slice(0, 8) };
}

/** `/alerts` in full; in the morning message only when there is one, each cut to a line. */
export function renderAlerts(alerts: ReportFacts["alerts"], compact = false): string {
  if (!alerts.ok) return sectionError("⚠️ Problems", alerts.error);
  if (alerts.data.length === 0) return compact ? "" : `${b("⚠️ Problems")}\nNone.`;
  const cut = (m: string) => (compact && m.length > 150 ? `${m.slice(0, 149)}…` : m);
  return [
    b("⚠️ Problems"),
    ...alerts.data.map((a: AlertItem) => `• <b>${escapeHtml(a.source)}</b> — ${escapeHtml(cut(a.message))}`),
  ].join("\n");
}

/** `/health` lists every check; the morning message says one line, naming only what is down. */
export function renderHealth(health: HealthCheck[], compact = false): string {
  if (health.length === 0) return compact ? "" : `${b("Health")}\n(nothing to check)`;
  const down = health.filter((h) => !h.ok);
  if (compact) {
    if (down.length === 0) return `✅ All ${health.length} services up`;
    return (
      `❌ ${down.map((h) => `<b>${escapeHtml(h.name)}</b>${h.detail ? ` (${escapeHtml(h.detail)})` : ""}`).join(", ")} down` +
      ` · ${health.length - down.length} others up`
    );
  }
  const lines = health.map((h) => {
    const mark = h.ok ? "✅" : "❌";
    const ms = h.ms !== undefined ? ` <i>${h.ms} ms</i>` : "";
    const detail = h.detail ? ` — ${escapeHtml(h.detail)}` : "";
    return `${mark} ${escapeHtml(h.name)}${ms}${detail}`;
  });
  return [b("Health"), ...lines].join("\n");
}

export function renderOvernight(overnight: ReportFacts["overnight"], compact = false): string {
  if (!overnight.ok) return sectionError("🌙 Overnight", overnight.error);
  const { uploaded, nowPublic, nightlyRendered } = overnight.data;
  const nightly = nightlyRendered
    ? `Nightly: ${nightlyTarget(nightlyRendered)}${escapeHtml(nightlySummary(nightlyRendered))}`
    : null;
  if (uploaded.length === 0 && nowPublic.length === 0)
    return `🌙 Nothing uploaded or published overnight${nightly ? ` · ${nightly.replace(/^Nightly/, "nightly")}` : ""}`;
  const byMatch = (
    rows: readonly { matchId: number; players: string; kind: "video" | "short"; videoId: string }[],
  ) => {
    const m = new Map<number, (typeof rows)[number][]>();
    for (const r of rows) m.set(r.matchId, [...(m.get(r.matchId) ?? []), r]);
    return [...m.values()].map(
      (rs) =>
        `• ${escapeHtml(rs[0]!.players)} — ` +
        rs
          .map((r) => `<a href="https://youtu.be/${r.videoId}">${r.kind === "short" ? "Short" : "video"}</a>`)
          .join(" · "),
    );
  };
  const lines = [b("🌙 Overnight")];
  if (nightly) lines.push(nightly);
  if (uploaded.length) lines.push("Uploaded:", ...byMatch(uploaded));
  if (nowPublic.length) lines.push("Went public:", ...byMatch(nowPublic));
  if (nowPublic.length && !compact)
    lines.push("<i>(by its publish time — the record's status is not re-read from YouTube)</i>");
  return lines.join("\n");
}

/**
 * Matches between players people know, played lately, not yet rendered, both VODs found — one line
 * each, `players · played · run · story · id`, the id in `<code>` so a tap copies it for the
 * dashboard. The morning message shows five; `/worth` passes more and gets what was scored.
 */
export function renderWorth(worth: ReportFacts["worthRendering"], dashboardBaseUrl: string, max = 5): string {
  if (!worth.ok) return sectionError("🎬 Worth rendering", worth.error);
  const { matches, notes } = worth.data;
  const shown = matches.slice(0, max);
  const lines =
    shown.length === 0
      ? ["🎬 Nothing new worth rendering from the last 3 days"]
      : [
          `${b("🎬 Worth rendering today")} · <a href="${escapeHtml(dashboardBaseUrl)}/">dashboard</a>`,
          ...shown.map(
            (w) =>
              `• ${b(w.players)} · ${whenWarsaw(w.playedAt)} · ${mmss(w.runMs)} · ${escapeHtml(w.story)} · id <code>${w.matchId}</code>`,
          ),
        ];
  if (matches.length > shown.length) lines.push(`+ ${matches.length - shown.length} more — /worth`);
  for (const n of notes) lines.push(`<i>${escapeHtml(n)}</i>`);
  return lines.join("\n");
}

/* --- Message 2: the channel (stats table, YPP) -------------------------------------------------- */

/** 7616 → "7.6K", 55381 → "55K": a table cell on a phone, not an accountant's figure. */
const cell = (n: number): string =>
  Math.abs(n) >= 10_000
    ? `${Math.round(n / 1000)}K`
    : Math.abs(n) >= 1000
      ? `${(n / 1000).toFixed(1)}K`
      : `${Math.round(n)}`;

/**
 * The live counts, then one monospace table: a metric per row, a window per column (1/3/7/30 days
 * by default), the change in views against the equal window before. `/stats 7d` is one column.
 */
export function renderStats(
  stats: ReportFacts["stats"],
  prevSnapshot: ChannelSnapshot | null,
  windows: readonly WindowDays[] = [1, 3, 7, 30],
): string {
  if (!stats.ok) return sectionError("📈 Channel", stats.error);
  const { live, dataEndsOn } = stats.data;
  const change = (now: number, before: number | undefined) =>
    before !== undefined && now !== before ? ` (${fmtDelta(now - before)})` : "";
  const liveLine =
    `${b("📈 Channel")} · ${fmtInt(live.subscribers)} subs${change(live.subscribers, prevSnapshot?.subscribers)}` +
    ` · ${fmtInt(live.views)} views${change(live.views, prevSnapshot?.views)}` +
    ` · ${fmtInt(live.videos)} videos${change(live.videos, prevSnapshot?.videos)}`;
  const w = windows.map((d) => stats.data.windows[d]);
  const col = (vals: string[]) => vals.map((v) => v.padStart(7)).join("");
  const row = (label: string, f: (t: (typeof w)[number]) => string) => `${label.padEnd(9)}${col(w.map(f))}`;
  const net = (t: (typeof w)[number]) =>
    (t.current.subscribersGained ?? 0) - (t.current.subscribersLost ?? 0);
  const avg = (t: (typeof w)[number]) => {
    const v = t.current.views ?? 0;
    return v > 0 ? mmss(Math.round(((t.current.estimatedMinutesWatched ?? 0) * 60) / v) * 1000) : "-";
  };
  const partial = w.some((t) => t.currentDays < t.days);
  const table = [
    `${"".padEnd(9)}${col(w.map((t) => `${t.days}d${t.currentDays < t.days ? "*" : ""}`))}`,
    row("views", (t) => cell(t.current.views ?? 0)),
    row("vs prev", (t) => pctDelta(t.current.views ?? 0, t.previous.views ?? 0)),
    row("engaged", (t) => cell(t.current.engagedViews ?? 0)),
    row("hours", (t) => cell((t.current.estimatedMinutesWatched ?? 0) / 60)),
    row("subs", (t) => fmtDelta(net(t))),
    row("avg view", avg),
    row("likes", (t) => cell(t.current.likes ?? 0)),
    row("comments", (t) => cell(t.current.comments ?? 0)),
  ].join("\n");
  const foot = dataEndsOn
    ? `<i>Analytics through ${escapeHtml(dayMonth(Date.parse(dataEndsOn)))} (it lags 1–3 days)${partial ? " · * fewer days of data than the window" : ""}</i>`
    : "";
  return [liveLine, `<pre>${escapeHtml(table)}</pre>`, foot].filter(Boolean).join("\n");
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Whole days from `nowMs` to an ISO instant, never negative — "in N days" for an ETA already past
 *  reads as "in 0 days" rather than a negative count. */
const daysUntil = (iso: string, nowMs: number): number =>
  Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / DAY_MS));

type Gate = { have: number; need: number; eta: string | null; ceiling?: number; ratePerDay?: number };
const unreachable = (g: Gate) => g.ceiling !== undefined && g.ceiling < g.need;

function gateLine(name: string, g: Gate, nowMs: number): string {
  const pct = g.need > 0 ? Math.min(100, Math.round((g.have / g.need) * 100)) : 100;
  if (g.have >= g.need) return `${name}: ${fmtInt(g.have)}/${fmtInt(g.need)} — done`;
  if (unreachable(g))
    return `${name}: ${fmtInt(g.have)}/${fmtInt(g.need)} (${pct}%) — out of reach at this rate`;
  const eta = g.eta ? `~${daysUntil(g.eta, nowMs)} days (${dayMonth(Date.parse(g.eta))})` : "unknown";
  return `${name}: ${fmtInt(g.have)}/${fmtInt(g.need)} (${pct}%) — ${eta}`;
}

type Tier = { subscribers: Gate; watchHours: Gate; shortsViews: Gate };

/**
 * When a tier is reached: subscribers AND (watch hours OR Shorts views), so the later of the two,
 * with the gate that holds it back. "reached", or null when it is not reachable at these rates.
 */
export function tierEta(
  t: Tier,
  nowMs: number,
): { days: number; at: number; holder: keyof Tier } | "reached" | null {
  const at = (g: Gate) =>
    g.have >= g.need ? nowMs : g.eta && !unreachable(g) ? Date.parse(g.eta) : Infinity;
  const hours = at(t.watchHours);
  const shorts = at(t.shortsViews);
  const views = Math.min(hours, shorts);
  const subs = at(t.subscribers);
  const when = Math.max(subs, views);
  if (!Number.isFinite(when)) return null;
  const days = Math.max(0, Math.ceil((when - nowMs) / DAY_MS));
  if (days === 0) return "reached";
  return {
    days,
    at: when,
    holder: subs >= views ? "subscribers" : hours <= shorts ? "watchHours" : "shortsViews",
  };
}

const GATE_NAME: Record<keyof Tier, string> = {
  subscribers: "subscribers",
  watchHours: "watch hours",
  shortsViews: "Shorts views",
};

/** "~102 days (9 Jan) — subscribers hold it back", the countdown the operator asked for. */
export function tierCountdown(t: Tier, nowMs: number): string {
  const e = tierEta(t, nowMs);
  if (e === null) return "not reachable at the current rates";
  if (e === "reached") return "reached";
  return `<b>~${e.days} days</b> (${dayMonth(e.at)}) — ${GATE_NAME[e.holder]} hold it back`;
}

/** The morning message's YPP: the countdown, then the gate holding it back and the next one. */
export function renderYppShort(ypp: ReportFacts["ypp"], nowMs = Date.now()): string {
  if (!ypp.ok) return sectionError("🎯 YPP", ypp.error);
  const p = ypp.data;
  const e = tierEta(p, nowMs);
  const full = tierEta(p.tiers.full, nowMs);
  const when = (x: typeof e) =>
    x === null
      ? "out of reach at this rate"
      : x === "reached"
        ? "reached"
        : `<b>~${x.days} days</b> (${dayMonth(x.at)})`;
  const g = (name: string, x: Gate) =>
    `${name} ${fmtInt(x.have)}/${fmtInt(x.need)}` +
    (x.have >= x.need
      ? " ✔"
      : unreachable(x) || !x.eta
        ? " (out of reach)"
        : ` (~${daysUntil(x.eta, nowMs)} d)`);
  return [
    `${b("🎯 YPP")} · expanded tier ${when(e)} · full tier ${when(full).replace(/<\/?b>/g, "")}`,
    `${g("Subscribers", p.subscribers)} at ${p.subscribers.ratePerDay.toFixed(1)}/day · ${g("watch hours", p.watchHours)}`,
  ].join("\n");
}

/** `/ypp`: both tiers, every gate. */
export function renderYpp(ypp: ReportFacts["ypp"], nowMs = Date.now()): string {
  if (!ypp.ok) return sectionError("🎯 YPP", ypp.error);
  const p = ypp.data;
  return [
    `${b("🎯 YPP")} · expanded tier ${tierCountdown(p, nowMs)}`,
    `<i>at ${p.subscribers.ratePerDay.toFixed(2)} subs/day · ${p.watchHours.ratePerDay.toFixed(1)} h/day · ${fmtInt(p.shortsViews.ratePerDay)} engaged Shorts views/day</i>`,
    "",
    "<b>Expanded tier</b> — 500 subs, 3 uploads in 90 days, and 3,000 h or 3M Shorts views",
    gateLine("subs", p.subscribers, nowMs),
    gateLine("watch hours", p.watchHours, nowMs),
    gateLine("Shorts views", p.shortsViews, nowMs),
    `uploads (90 days): ${p.tiers.expanded.uploads90d.have ?? "?"}/${p.tiers.expanded.uploads90d.need}`,
    "",
    `<b>Full tier</b> — ${tierCountdown(p.tiers.full, nowMs)}`,
    gateLine("subs", p.tiers.full.subscribers, nowMs),
    gateLine("watch hours", p.tiers.full.watchHours, nowMs),
    gateLine("Shorts views", p.tiers.full.shortsViews, nowMs),
  ].join("\n");
}

/* --- Message 3: comments ------------------------------------------------------------------------ */

/** "THE DUALITY OF MAN · Infume vs Feinberg": our titles are `<hook> | <players> | <genre tail>`,
 *  a Short's `<hook> | <players> #mcsr #minecraft`. */
const shortTitle = (title: string): string => {
  const [hook, players] = title.replace(/(\s#\w+)+\s*$/, "").split(" | ");
  return players && players !== hook ? `${hook} · ${players}` : (hook ?? title);
};

/**
 * Unanswered comments grouped by video — each title once, with its Studio page — inside an
 * expandable quote, so the message is two lines until it is opened. Stops adding comments before
 * the message would pass Telegram's limit, and says how many more are in the inbox.
 */
export function renderComments(comments: ReportFacts["comments"], channelId: string): string {
  if (!comments.ok) return sectionError("💬 Comments", comments.error);
  const { unanswered, videoTitles } = comments.data;
  const inbox = `<a href="https://studio.youtube.com/channel/${escapeHtml(channelId)}/comments/inbox">Studio inbox</a>`;
  if (unanswered.length === 0) return `💬 No unanswered comments · ${inbox}`;
  const head = `${b(`💬 ${unanswered.length} unanswered comment${unanswered.length === 1 ? "" : "s"}`)} · ${inbox}`;
  const byVideo = new Map<string, typeof unanswered>();
  for (const c of unanswered) byVideo.set(c.videoId, [...(byVideo.get(c.videoId) ?? []), c]);
  const body: string[] = [];
  let shown = 0;
  for (const [videoId, cs] of byVideo) {
    const videoLine = `<b>${escapeHtml(shortTitle(videoTitles[videoId] ?? videoId))}</b> · <a href="https://studio.youtube.com/video/${videoId}/comments">Studio</a>`;
    const lines = [videoLine];
    for (const c of cs) {
      const excerpt = c.text.replace(/\s+/g, " ").trim();
      const cut = excerpt.length > 110 ? `${excerpt.slice(0, 109)}…` : excerpt;
      const maybe = c.repliesTruncated ? " <i>(may be answered)</i>" : "";
      const line = `• <b>${escapeHtml(c.author)}</b>: ${escapeHtml(cut)}${maybe} · <a href="https://www.youtube.com/watch?v=${c.videoId}&amp;lc=${c.threadId}">reply</a>`;
      if (visibleLength([head, ...body, ...lines, line].join("\n")) > MESSAGE_MAX_CHARS - 200) break;
      lines.push(line);
      shown++;
    }
    if (lines.length > 1) body.push(lines.join("\n"));
    if (shown < unanswered.length && visibleLength([head, ...body].join("\n")) > MESSAGE_MAX_CHARS - 400)
      break;
  }
  const more = unanswered.length - shown;
  return [
    head,
    `<blockquote expandable>${body.join("\n\n")}</blockquote>`,
    ...(more > 0 ? [`+ ${more} more in the Studio inbox`] : []),
  ].join("\n");
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

const DAY_LABEL = (offset: number): string =>
  offset === 0 ? "today" : offset === 1 ? "tomorrow" : `in ${offset} days`;

export function renderUpcoming(rows: readonly UpcomingRow[], days: number): string {
  if (rows.length === 0) return `Nothing scheduled in the next ${days} days.`;
  const lines = [`<b>Next ${days} days</b>:`];
  for (const r of rows) {
    lines.push(
      `${DAY_LABEL(r.dayOffset)} — #${r.matchId} ${escapeHtml(r.players)} (${r.kind}) at ${whenWarsaw(r.at)}`,
    );
  }
  return lines.join("\n");
}

export function renderNightly(n: NightlyFacts): string {
  const lines = [b("NIGHTLY")];
  lines.push(`Scheduled for ${n.hourUtc === null ? "off" : `${String(n.hourUtc).padStart(2, "0")}:00 UTC`}.`);
  if (n.lastRun) {
    lines.push(
      `Last run (${whenWarsaw(n.lastRun.startedAt)}): ${nightlyTarget(n.lastRun)}${escapeHtml(nightlySummary(n.lastRun))}`,
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

/* --- The morning report: three messages ----------------------------------------------------- */

/** What Telegram counts against the 4096: the text after its HTML is parsed — tags out, entities one character. */
export const visibleLength = (html: string): number =>
  html.replace(/<[^>]+>/g, "").replace(/&(?:lt|gt|amp|quot|#39);/g, "x").length;

/**
 * The morning report as three messages, each saying a thing once: the day (agy's to-do, the
 * matches worth rendering, problems, overnight, health), the channel (stats table and YPP), and
 * the comments. The operator's call, 29 Sept 2026: "too much repetitive info split it up into a
 * couple messages".
 */
export function renderMorningReport(
  facts: ReportFacts,
  agy: { source: "agy" | "fallback"; answer: AgyAnswer; note?: string },
  prevSnapshot: ChannelSnapshot | null,
  channelId: string,
  nowMs = Date.now(),
): string[] {
  const day = [
    `☀️ <b>${escapeHtml(warsawDay(nowMs))}</b>`,
    renderToday(facts.todo, agy, facts.dashboardBaseUrl),
    renderWorth(facts.worthRendering, facts.dashboardBaseUrl),
    renderAlerts(facts.alerts, true),
    renderOvernight(facts.overnight, true),
    renderHealth(facts.health, true),
  ];
  const channel = [renderStats(facts.stats, prevSnapshot), renderYppShort(facts.ypp, nowMs)];
  return [day.filter(Boolean).join("\n\n"), channel.join("\n\n"), renderComments(facts.comments, channelId)];
}
