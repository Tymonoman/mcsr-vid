/**
 * Turns `ReportFacts` (facts.ts) plus Claude's answer (claude.ts, asked from index.ts) into the
 * morning report's text — every number, list and link rendered deterministically; Claude only
 * supplies the TODAY section's headline and to-do wording. HTML-escaped throughout (Telegram's
 * `parse_mode: "HTML"`), and the whole report capped at 4096 characters.
 */
import { escapeHtml, MESSAGE_MAX_CHARS } from "./bot.js";
import type { AutoHooksRow } from "../dashboard/shortFlow.js";
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
import type { TestsSummary } from "../dashboard/experiments.js";
import type { CreatorWatchHit } from "../dashboard/creatorWatch.js";
import { netSubscribers, subsPer1kEngaged, type WindowDays } from "./windowStats.js";
import type { NightlyFacts, UpcomingRow } from "./facts.js";
import type { NightlyLastRun } from "../dashboard/nightly.js";

/** Claude's TODAY answer: a headline and an ordered to-do list, parsed from its plain text
 *  (index.ts `parseTodayPlainText`) or built by `fallbackToday` below. */
export interface TodayAnswer {
  /** At most two lines. */
  headline: string;
  /** Ordered by what matters most; at most 8. */
  todo: string[];
}

/** TODAY's result: Claude's answer, or the rule-based fallback's — and why, when it fell back.
 *  `note` is exactly "usage limit reached — try again later" on a limit (claude.ts
 *  `describeFailure`); any other reason is one line. */
export interface TodayResult {
  source: "claude" | "fallback";
  answer: TodayAnswer;
  note?: string;
}

/** One line for a nightly run's record: skipped runs (no matchId) read as just their reason. */
function nightlySummary(n: NightlyLastRun): string {
  if (n.outcome === "skipped") return n.reason ?? "skipped";
  let said = n.reason ? `${n.outcome}: ${n.reason}` : n.outcome;
  if (n.export) said += ` · export ${n.export}`;
  if (n.pick) said += ` · picked by ${n.pick === "agy" ? "the model" : "the heuristic"}`;
  return said;
}

/** A link to one match's page on the dashboard: `public/app.js` opens `#match=<id>` on its Now
 *  panel. `label` is HTML, already escaped. A link about the list is the base URL and nothing more. */
const matchLink = (dashboardBaseUrl: string, id: string | number, label: string): string =>
  `<a href="${escapeHtml(dashboardBaseUrl)}/#match=${escapeHtml(String(id))}">${label}</a>`;

/** The match a nightly run worked on, linked, then " — "; a run that skipped has none. */
const nightlyTarget = (n: NightlyLastRun, dashboardBaseUrl: string): string =>
  n.matchId === null
    ? ""
    : `${matchLink(dashboardBaseUrl, n.matchId, `#${n.matchId} ${escapeHtml(n.players.join(" vs "))}`)} — `;

const b = (s: string): string => `<b>${escapeHtml(s)}</b>`;
const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US");
const fmtDelta = (n: number): string => (n > 0 ? `+${fmtInt(n)}` : n < 0 ? fmtInt(n) : "0");
const pctDelta = (curr: number, prev: number): string => {
  if (prev === 0) return curr === 0 ? "0%" : curr > 0 ? "new" : "-";
  // |prev|: net subscribers can be negative, and a rise from -2 to +5 is not "-350%".
  const pct = ((curr - prev) / Math.abs(prev)) * 100;
  // A window compared with one from before the channel had an audience reads as "+18070%": a ratio says it plainly.
  if (pct >= 1000 && prev > 0) return `×${(curr / prev).toFixed(0)}`;
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

/** "3 Nov 2027" — the year, for a date more than a year out. */
const dayMonthYear = (ms: number): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(ms));

/** Claude's headline and numbered to-do list, one dashboard link under it. `/todo` is this alone.
 *  A `#<id>` in an item (the prompt lets Claude write one to name a match) opens that match. */
export function renderToday(
  todo: ReportFacts["todo"],
  claude: TodayResult,
  dashboardBaseUrl: string,
): string {
  const lines = [`<b>${escapeHtml(claude.answer.headline)}</b>`, "", "<b>To do</b>"];
  claude.answer.todo.forEach((item, i) =>
    lines.push(
      `${i + 1}. ${escapeHtml(item).replace(/#(\d{6,})\b/g, (tag, id: string) => matchLink(dashboardBaseUrl, id, tag))}`,
    ),
  );
  lines.push(`<a href="${escapeHtml(dashboardBaseUrl)}/">Open the dashboard</a>`);
  if (claude.source === "fallback") lines.push(`<i>${escapeHtml(claude.note ?? "Claude unavailable")}</i>`);
  if (!todo.ok) lines.push(escapeHtml(`(today's facts: ${todo.error})`));
  return lines.join("\n");
}

/** The rule-based to-do list Claude's answer stands in for — CLAUDE.md's own priority order:
 *  failed, then waiting for a hook, then running, scheduled, published. */
export function fallbackToday(
  todo: TodoFacts | null,
  alertCount: number,
  unansweredCount: number,
): TodayAnswer {
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

/** Each match's players open its page on the dashboard; "video" and "Short" open YouTube Studio. */
export function renderOvernight(
  overnight: ReportFacts["overnight"],
  dashboardBaseUrl: string,
  compact = false,
): string {
  if (!overnight.ok) return sectionError("🌙 Overnight", overnight.error);
  const { uploaded, nowPublic, nightlyRendered } = overnight.data;
  const nightly = nightlyRendered
    ? `Nightly: ${nightlyTarget(nightlyRendered, dashboardBaseUrl)}${escapeHtml(nightlySummary(nightlyRendered))}`
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
        `• ${matchLink(dashboardBaseUrl, rs[0]!.matchId, escapeHtml(rs[0]!.players))} — ` +
        rs
          .map(
            (r) =>
              `<a href="https://studio.youtube.com/video/${r.videoId}/edit">${r.kind === "short" ? "Short" : "video"}</a>`,
          )
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

/**
 * Creator watch's own hits since the previous report (src/dashboard/creatorWatch.ts) — nothing
 * for the operator to do, so this is its own line, not part of Needs you. Omitted entirely when
 * there were none, the same convention as `renderAutoHooks`.
 */
export function renderCreatorWatch(hits: readonly CreatorWatchHit[] | undefined): string {
  if (!hits || hits.length === 0) return "";
  return hits
    .map(
      (h) =>
        `${b("👀 Creator watch")} · ${escapeHtml(h.nick)} played ${escapeHtml(h.players)} — ${h.queued ? "queued for tonight" : escapeHtml(h.reason ?? "not queued")}`,
    )
    .join("\n");
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
 * by default). Net subscribers and subscribers gained per 1,000 engaged views lead — the channel
 * steered by views while subscribers per 1,000 views fell from 7.0 to 0.98 (post-mortem, 30 Sept
 * 2026) — and each of them, and views, has a "vs prev" row under it: the change against the equal
 * window before. `/stats 7d` is one column.
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
  /** The change in `f` against the equal window before; "-" where either side has nothing to divide by. */
  const vsPrev = (f: (m: Record<string, number>) => number | null) =>
    row(" vs prev", (t) => {
      const [now, before] = [f(t.current), f(t.previous)];
      return now === null || before === null ? "-" : pctDelta(now, before);
    });
  const avg = (t: (typeof w)[number]) => {
    const v = t.current.views ?? 0;
    return v > 0 ? mmss(Math.round(((t.current.estimatedMinutesWatched ?? 0) * 60) / v) * 1000) : "-";
  };
  const partial = w.some((t) => t.currentDays < t.days);
  const table = [
    `${"".padEnd(9)}${col(w.map((t) => `${t.days}d${t.currentDays < t.days ? "*" : ""}`))}`,
    row("net subs", (t) => fmtDelta(netSubscribers(t.current))),
    vsPrev(netSubscribers),
    row("subs/1k", (t) => subsPer1kEngaged(t.current)?.toFixed(2) ?? "-"),
    vsPrev(subsPer1kEngaged),
    row("views", (t) => cell(t.current.views ?? 0)),
    vsPrev((m) => m.views ?? 0),
    row("engaged", (t) => cell(t.current.engagedViews ?? 0)),
    row("hours", (t) => cell((t.current.estimatedMinutesWatched ?? 0) / 60)),
    row("avg view", avg),
    row("likes", (t) => cell(t.current.likes ?? 0)),
    row("comments", (t) => cell(t.current.comments ?? 0)),
  ].join("\n");
  const foot = dataEndsOn
    ? `<i>Analytics through ${escapeHtml(dayMonth(Date.parse(dataEndsOn)))} (it lags 1–3 days)${partial ? " · * fewer days of data than the window" : ""} · subs/1k = subscribers gained per 1,000 engaged views</i>`
    : "";
  return [liveLine, `<pre>${escapeHtml(table)}</pre>`, foot].filter(Boolean).join("\n");
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Whole days from `nowMs` to an ISO instant, never negative — "in N days" for an ETA already past
 *  reads as "in 0 days" rather than a negative count. */
const daysUntil = (iso: string, nowMs: number): number =>
  Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / DAY_MS));

type Gate = {
  have: number;
  need: number;
  eta: string | null;
  ceiling?: number;
  ratePerDay?: number;
  /** Subscribers: the date at the last week's pace, set only when that week was the faster one. */
  recent?: { ratePerDay: number; eta: string };
};
const unreachable = (g: Gate) => g.ceiling !== undefined && g.ceiling < g.need;

/** "26 Mar"; more than a year out also the year ("3 Nov 2027"), where a bare "3 Nov" reads as the next one. */
const etaDate = (ms: number, nowMs: number): string =>
  ms - nowMs > 365 * DAY_MS ? dayMonthYear(ms) : dayMonth(ms);

/** What follows the optimistic date of a subscribers range. */
const LAST_WEEK = "at the last week's pace";

function gateLine(name: string, g: Gate, nowMs: number): string {
  const pct = g.need > 0 ? Math.min(100, Math.round((g.have / g.need) * 100)) : 100;
  if (g.have >= g.need) return `${name}: ${fmtInt(g.have)}/${fmtInt(g.need)} — done`;
  if (unreachable(g))
    return `${name}: ${fmtInt(g.have)}/${fmtInt(g.need)} (${pct}%) — out of reach at this rate`;
  const range = g.recent ? `; ${etaDate(Date.parse(g.recent.eta), nowMs)} ${LAST_WEEK}` : "";
  const eta = g.eta
    ? `~${daysUntil(g.eta, nowMs)} days (${etaDate(Date.parse(g.eta), nowMs)}${range})`
    : "unknown";
  return `${name}: ${fmtInt(g.have)}/${fmtInt(g.need)} (${pct}%) — ${eta}`;
}

type Tier = { subscribers: Gate; watchHours: Gate; shortsViews: Gate };
type TierEta = { days: number; at: number; holder: keyof Tier };

/**
 * When a tier is reached: subscribers AND (watch hours OR Shorts views), so the later of the two,
 * with the gate that holds it back. "reached", or null when it is not reachable at these rates.
 */
export function tierEta(t: Tier, nowMs: number): TierEta | "reached" | null {
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

/**
 * "(3 Nov 2027; 21 May at the last week's pace)": where the tier lands at the 28-day subscriber pace,
 * and, when the last week's pace lands it sooner, where that is. The countdown used to read the week
 * alone and said 1,000 on 21 May 2027 against 3 Nov 2027 from the 28 days (post-mortem, 30 Sept 2026).
 */
function landing(t: Tier, e: TierEta, nowMs: number): string {
  const fast = tierEta(
    t.subscribers.recent ? { ...t, subscribers: { ...t.subscribers, eta: t.subscribers.recent.eta } } : t,
    nowMs,
  );
  const sooner = typeof fast === "object" && fast !== null && fast.at < e.at ? fast : null;
  return `(${etaDate(e.at, nowMs)}${sooner ? `; ${etaDate(sooner.at, nowMs)} ${LAST_WEEK}` : ""})`;
}

/** "~177 days (26 Mar; 12 Jan at the last week's pace) — subscribers hold it back": the operator's countdown. */
export function tierCountdown(t: Tier, nowMs: number): string {
  const e = tierEta(t, nowMs);
  if (e === null) return "not reachable at the current rates";
  if (e === "reached") return "reached";
  return `<b>~${e.days} days</b> ${landing(t, e, nowMs)} — ${GATE_NAME[e.holder]} hold it back`;
}

/** The morning message's YPP: the countdown, then the gate holding it back and the next one. */
export function renderYppShort(ypp: ReportFacts["ypp"], nowMs = Date.now()): string {
  if (!ypp.ok) return sectionError("🎯 YPP", ypp.error);
  const p = ypp.data;
  const when = (t: Tier) => {
    const x = tierEta(t, nowMs);
    return x === null
      ? "out of reach at this rate"
      : x === "reached"
        ? "reached"
        : `<b>~${x.days} days</b> ${landing(t, x, nowMs)}`;
  };
  const g = (name: string, x: Gate) =>
    `${name} ${fmtInt(x.have)}/${fmtInt(x.need)}` +
    (x.have >= x.need
      ? " ✔"
      : unreachable(x) || !x.eta
        ? " (out of reach)"
        : ` (~${daysUntil(x.eta, nowMs)} d)`);
  // The full tier (ads) leads: the operator, 10 Oct 2026, "we only focus on hitting the full ypp".
  const f = p.tiers.full;
  return [
    `${b("🎯 YPP")} · full tier ${when(f)} · expanded tier ${when(p).replace(/<\/?b>/g, "")}`,
    `${g("Subscribers", f.subscribers)} at ${f.subscribers.ratePerDay.toFixed(1)}/day over 28 days · ${g("watch hours", f.watchHours)}`,
  ].join("\n");
}

/** `/ypp`: both tiers, every gate. */
export function renderYpp(ypp: ReportFacts["ypp"], nowMs = Date.now()): string {
  if (!ypp.ok) return sectionError("🎯 YPP", ypp.error);
  const p = ypp.data;
  const f = p.tiers.full;
  return [
    `${b("🎯 YPP")} · full tier ${tierCountdown(f, nowMs)}`,
    `<i>at ${p.subscribers.ratePerDay.toFixed(2)} subs/day over 28 days${p.subscribers.recent ? ` (${p.subscribers.recent.ratePerDay.toFixed(2)} in the last week)` : ""} · ${p.watchHours.ratePerDay.toFixed(1)} h/day · ${fmtInt(p.shortsViews.ratePerDay)} engaged Shorts views/day</i>`,
    "",
    `<b>Full tier (ads)</b> — 1,000 subs, and ${fmtInt(f.watchHours.need)} h or ${fmtInt(f.shortsViews.need / 1e6)}M Shorts views`,
    gateLine("subs", f.subscribers, nowMs),
    gateLine("watch hours", f.watchHours, nowMs),
    gateLine("Shorts views", f.shortsViews, nowMs),
    "",
    `<b>Expanded tier</b> — ${tierCountdown(p, nowMs)}`,
    gateLine("subs", p.subscribers, nowMs),
    gateLine("watch hours", p.watchHours, nowMs),
    gateLine("Shorts views", p.shortsViews, nowMs),
    `uploads (90 days): ${p.tiers.expanded.uploads90d.have ?? "?"}/${p.tiers.expanded.uploads90d.need}`,
  ].join("\n");
}

/**
 * The channel message's one deterministic line on the experiment engine (src/dashboard/
 * experiments.ts): how many between-video tests are running, which arm renders today, and any
 * verdict or decision since the last report. Always one line, even with nothing running, the same
 * way `renderHealth`'s compact form always says something rather than going silent on a quiet day.
 */
export function renderTestsLine(tests: TestsSummary | undefined): string {
  const t = tests ?? { runningCount: 0, scheduleToday: [], since: [] };
  const bits = [`${t.runningCount} running`];
  if (t.scheduleToday.length)
    bits.push(`today: ${t.scheduleToday.map((s) => `${s.experimentId}/${s.arm}`).join(", ")}`);
  for (const s of t.since)
    bits.push(s.decision ? `${s.experimentId} decided — ${s.decision}` : `${s.experimentId}: ${s.verdict}`);
  return `${b("🧪 Tests")} · ${escapeHtml(bits.join(" · "))}`;
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
      const line = `• <b>${escapeHtml(c.author)}</b>: ${escapeHtml(cut)}${maybe} · <a href="https://studio.youtube.com/video/${c.videoId}/comments?lc=${c.threadId}">reply</a>`;
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

/**
 * Both sections below share one message with `renderToday`, `renderWorth`, `renderAlerts`,
 * `renderOvernight` and `renderHealth` (the day message, `renderMorningReport`), none of which
 * grow without bound the way a list of matches can — so each caps itself to a share of the
 * 4096-character message rather than relying on the whole day staying short by luck.
 */
const NEEDS_YOU_BUDGET_CHARS = 1500;
const AUTO_HOOKS_BUDGET_CHARS = 1000;

/**
 * "Needs you": the operator's own grant, 8 Oct 2026 ("I act only on what the 07:00 Warsaw Telegram
 * report lists under 'Needs you'") — a deterministic shortlist (`gatherNeedsYou`, facts.ts), never
 * Claude's. Empty says so in words, same as every other section here, rather than vanishing.
 */
export function renderNeedsYou(needsYou: ReportFacts["needsYou"], dashboardBaseUrl: string): string {
  if (!needsYou.ok) return sectionError("Needs you", needsYou.error);
  if (needsYou.data.items.length === 0) return `${b("Needs you")}\nNothing today.`;
  const line = (item: (typeof needsYou.data.items)[number]): string => {
    if (item.matchId === undefined) return `• ${escapeHtml(item.text)}`;
    const label = `#${item.matchId}${item.players ? ` ${escapeHtml(item.players)}` : ""}`;
    return `• ${matchLink(dashboardBaseUrl, item.matchId, label)} — ${escapeHtml(item.text)}`;
  };
  const head = b("Needs you");
  const lines: string[] = [];
  for (const item of needsYou.data.items) {
    const l = line(item);
    if (visibleLength([head, ...lines, l].join("\n")) > NEEDS_YOU_BUDGET_CHARS) break;
    lines.push(l);
  }
  const more = needsYou.data.items.length - lines.length;
  return [head, ...lines, ...(more > 0 ? [`+ ${more} more — open the dashboard`] : [])].join("\n");
}

/** The auto-hooks grant's own log (shortFlow.ts `listAutoHooks`) — not part of Needs you: these
 *  already have a hook and are already in the chain, so there is nothing left to act on unless
 *  the operator wants to change one before its upload. Omitted entirely when nothing auto-saved. */
export function renderAutoHooks(rows: readonly AutoHooksRow[], dashboardBaseUrl: string): string {
  if (rows.length === 0) return "";
  const line = (r: AutoHooksRow): string => {
    const label = matchLink(dashboardBaseUrl, r.matchId, `#${r.matchId} ${escapeHtml(r.players)}`);
    const hooks = `${escapeHtml(r.titleHook)}${r.shortHook ? ` / ${escapeHtml(r.shortHook)}` : " (no Short)"}`;
    // `uploaded` alone means only "has an upload record" — the chain's upload is a private,
    // scheduled draft, so "published" has to come from the record's own privacyStatus, not from
    // having a record at all (shortFlow.ts's AutoHooksRow.privacyStatus).
    const when =
      r.privacyStatus === "public"
        ? "published"
        : r.publishAt
          ? `goes up ${whenWarsaw(r.publishAt)}`
          : "no time set yet";
    return `• ${label} — ${hooks} — ${when}`;
  };
  const head = b("🤖 Auto-saved hooks");
  const lines: string[] = [];
  for (const r of rows) {
    const l = line(r);
    if (visibleLength([head, ...lines, l].join("\n")) > AUTO_HOOKS_BUDGET_CHARS) break;
    lines.push(l);
  }
  const more = rows.length - lines.length;
  return [head, ...lines, ...(more > 0 ? [`+ ${more} more`] : [])].join("\n");
}

/* --- /waiting, /overnight's 7-day schedule, /nightly ------------------------------------------ */

export function renderWaiting(todo: ReportFacts["todo"], dashboardBaseUrl: string): string {
  if (!todo.ok) return sectionError("WAITING FOR A HOOK", todo.error);
  const rows = todo.data.waitingForHook;
  if (rows.length === 0) return `${b("WAITING FOR A HOOK")}\nNothing waiting.`;
  return [
    b("WAITING FOR A HOOK"),
    ...rows.map((w) => matchLink(dashboardBaseUrl, w.matchId, `#${w.matchId} ${escapeHtml(w.players)}`)),
  ].join("\n");
}

const DAY_LABEL = (offset: number): string =>
  offset === 0 ? "today" : offset === 1 ? "tomorrow" : `in ${offset} days`;

export function renderUpcoming(rows: readonly UpcomingRow[], days: number, dashboardBaseUrl: string): string {
  if (rows.length === 0) return `Nothing scheduled in the next ${days} days.`;
  const lines = [`<b>Next ${days} days</b>:`];
  for (const r of rows) {
    lines.push(
      `${DAY_LABEL(r.dayOffset)} — ${matchLink(dashboardBaseUrl, r.matchId, `#${r.matchId} ${escapeHtml(r.players)}`)} (${r.kind}) at ${whenWarsaw(r.at)}`,
    );
  }
  return lines.join("\n");
}

/** The last run's match is a rendered one, so it opens; a queued or "not at night" id is a card the
 *  dashboard's `#match=` cannot open (only the Rendered list answers it), so those stay text. */
export function renderNightly(n: NightlyFacts, dashboardBaseUrl: string): string {
  const lines = [b("NIGHTLY")];
  lines.push(`Scheduled for ${n.hourUtc === null ? "off" : `${String(n.hourUtc).padStart(2, "0")}:00 UTC`}.`);
  if (n.lastRun) {
    lines.push(
      `Last run (${whenWarsaw(n.lastRun.startedAt)}): ${nightlyTarget(n.lastRun, dashboardBaseUrl)}${escapeHtml(nightlySummary(n.lastRun))}`,
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
 * The morning report as three messages, each saying a thing once: the day (Claude's to-do, the
 * matches worth rendering, problems, overnight, health), the channel (stats table and YPP), and
 * the comments. The operator's call, 29 Sept 2026: "too much repetitive info split it up into a
 * couple messages".
 */
export function renderMorningReport(
  facts: ReportFacts,
  claude: TodayResult,
  prevSnapshot: ChannelSnapshot | null,
  channelId: string,
  nowMs = Date.now(),
  autoHooks: readonly AutoHooksRow[] = [],
): string[] {
  const day = [
    `☀️ <b>${escapeHtml(warsawDay(nowMs))}</b>`,
    renderNeedsYou(facts.needsYou, facts.dashboardBaseUrl),
    renderAutoHooks(autoHooks, facts.dashboardBaseUrl),
    renderToday(facts.todo, claude, facts.dashboardBaseUrl),
    renderWorth(facts.worthRendering, facts.dashboardBaseUrl),
    renderCreatorWatch(facts.creatorWatch),
    renderAlerts(facts.alerts, true),
    renderOvernight(facts.overnight, facts.dashboardBaseUrl, true),
    renderHealth(facts.health, true),
  ];
  const channel = [
    renderStats(facts.stats, prevSnapshot),
    renderYppShort(facts.ypp, nowMs),
    renderTestsLine(facts.tests),
  ];
  return [day.filter(Boolean).join("\n\n"), channel.join("\n\n"), renderComments(facts.comments, channelId)];
}
