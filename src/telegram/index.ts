/**
 * Wires the Telegram bot into the dashboard process (server.ts calls `startTelegramBot()` once,
 * at boot) and is also what `npm run tg` and the command dispatcher share, so the CLI and the
 * live poller answer identically.
 *
 * No token: one log line, nothing else runs. A token with no `TELEGRAM_CHAT_ID`: `/start` answers
 * with the chat id and the bot does nothing unprompted. Both: the poller and the 07:00 report run;
 * every update from any other chat is ignored silently.
 */
import { config } from "../config.js";
import { describeError } from "../errorText.js";
import * as bot from "./bot.js";
import { askAgyForReport, askAgyFreeform, type AgyResult } from "./agy.js";
import {
  BOT_COMMANDS,
  HELP_TEXT,
  parseCommand,
  parseStatsWindows,
  type ParsedCommand,
} from "./commands.js";
import { gatherFacts, gatherNightlyInfo, gatherUpcoming, type ReportFacts } from "./facts.js";
import { fallbackToday, renderAlerts, renderComments, renderHealth, renderMorningReport, renderNightly, renderOvernight, renderStats, renderToday, renderUpcoming, renderWaiting, renderYpp, CHANNEL_ID_PLACEHOLDER } from "./report.js";
import { msUntilNextWarsawRun, shouldCatchUp, warsawDateStr } from "./schedule.js";
import { readTelegramState, updateTelegramState } from "./state.js";

/** Only counts, ids and titles ever reach agy — never a comment's own text or author. */
function factsForAgy(f: ReportFacts): object {
  return {
    todo: f.todo.ok ? f.todo.data : { error: f.todo.error },
    alerts: f.alerts.ok ? f.alerts.data : { error: f.alerts.error },
    health: f.health.map((h) => ({ name: h.name, ok: h.ok, ms: h.ms, detail: h.detail })),
    overnight: f.overnight.ok
      ? {
          uploadedCount: f.overnight.data.uploaded.length,
          nowPublicCount: f.overnight.data.nowPublic.length,
          nightlyRendered: f.overnight.data.nightlyRendered,
        }
      : { error: f.overnight.error },
    unansweredCommentsCount: f.comments.ok ? f.comments.data.unanswered.length : null,
    stats: f.stats.ok ? { live: f.stats.data.live, dataEndsOn: f.stats.data.dataEndsOn } : { error: f.stats.error },
    ypp: f.ypp.ok
      ? { subscribers: f.ypp.data.subscribers, watchHours: f.ypp.data.watchHours, shortsViews: f.ypp.data.shortsViews }
      : { error: f.ypp.error },
  };
}

function reportPrompt(facts: object): string {
  return [
    "You write the morning briefing for the person who runs a small YouTube channel (MCSR Replayoffs).",
    "FACTS below is a JSON object computed by code. Every number in your answer must be copied from FACTS, never invented, estimated, or rounded differently.",
    "Write a headline (at most 2 lines) and an ordered to-do list (at most 8 items, most important first, each one concrete and actionable) for today.",
    "This goes only to the operator, never published: do not include any viewer comment text or names, and use only what is in FACTS.",
    'Reply with exactly one JSON object: { "headline": string, "todo": string[], "notes"?: string[] } and nothing else.',
    "",
    `FACTS = ${JSON.stringify(facts)}`,
  ].join("\n");
}

async function todayAgy(facts: ReportFacts): Promise<AgyResult> {
  const alertCount = facts.alerts.ok ? facts.alerts.data.length : 0;
  const unansweredCount = facts.comments.ok ? facts.comments.data.unanswered.length : 0;
  const fallback = () => fallbackToday(facts.todo.ok ? facts.todo.data : null, alertCount, unansweredCount);
  return askAgyForReport(reportPrompt(factsForAgy(facts)), fallback);
}

export interface BuiltReport {
  text: string;
  facts: ReportFacts;
  agy: AgyResult;
}

/** The full morning report's text, fresh — used by both the scheduled send and `/report`. */
export async function buildMorningReport(nowMs = Date.now()): Promise<BuiltReport> {
  const state = readTelegramState();
  const sinceMs = state.lastReportAt ? Date.parse(state.lastReportAt) : nowMs - 24 * 60 * 60 * 1000;
  const facts = await gatherFacts(nowMs, sinceMs);
  const agy = await todayAgy(facts);
  const text = renderMorningReport(facts, agy, state.prevSnapshot, config.youtubeChannelId);
  return { text, facts, agy };
}

/** Sends the morning report and records that it went out — the dedupe write. */
export async function sendMorningReport(nowMs = Date.now()): Promise<void> {
  const { text, facts } = await buildMorningReport(nowMs);
  await bot.sendMessage(text, { html: true });
  updateTelegramState((s) => {
    s.lastReportWarsawDate = warsawDateStr(nowMs);
    s.lastReportAt = new Date(nowMs).toISOString();
    if (facts.stats.ok) s.prevSnapshot = facts.stats.data.live;
  });
}

export interface CommandReply {
  text: string;
  html: boolean;
}

/** One command's fresh answer — every command re-gathers its own facts, as the spec asks. */
export async function dispatchCommand({ command, args }: ParsedCommand): Promise<CommandReply> {
  switch (command) {
    case "help":
      return { text: HELP_TEXT, html: false };
    case "report": {
      const { text } = await buildMorningReport();
      return { text, html: true };
    }
    case "todo": {
      const facts = await gatherFacts();
      const agy = await todayAgy(facts);
      return { text: renderToday(facts.todo, agy, facts.dashboardBaseUrl), html: true };
    }
    case "alerts": {
      const facts = await gatherFacts();
      return { text: renderAlerts(facts.alerts), html: true };
    }
    case "health": {
      const facts = await gatherFacts();
      return { text: renderHealth(facts.health), html: true };
    }
    case "overnight":
    case "uploads": {
      const facts = await gatherFacts();
      const upcoming = await gatherUpcoming(Date.now(), 7);
      return { text: `${renderOvernight(facts.overnight)}\n\n${renderUpcoming(upcoming, 7)}`, html: true };
    }
    case "stats": {
      const facts = await gatherFacts();
      const state = readTelegramState();
      return { text: renderStats(facts.stats, state.prevSnapshot, parseStatsWindows(args)), html: true };
    }
    case "comments": {
      const facts = await gatherFacts();
      return { text: renderComments(facts.comments).replace(CHANNEL_ID_PLACEHOLDER, config.youtubeChannelId), html: true };
    }
    case "ypp": {
      const facts = await gatherFacts();
      return { text: renderYpp(facts.ypp), html: true };
    }
    case "waiting": {
      const facts = await gatherFacts();
      return { text: renderWaiting(facts.todo, facts.dashboardBaseUrl), html: true };
    }
    case "nightly": {
      const n = await gatherNightlyInfo();
      return { text: renderNightly(n), html: true };
    }
    case "ask": {
      if (!args.trim()) return { text: "usage: /ask <question>", html: false };
      const facts = await gatherFacts();
      const prompt = [
        "You answer one question from the operator of a small YouTube channel (MCSR Replayoffs), using only FACTS below.",
        "Every number in your answer must come from FACTS, never invented. This goes only to the operator: never include any viewer comment text or names.",
        `QUESTION: ${args.trim()}`,
        "",
        `FACTS = ${JSON.stringify(factsForAgy(facts))}`,
        "",
        'Reply with exactly one JSON object: { "answer": string } and nothing else.',
      ].join("\n");
      const reply = await askAgyFreeform(prompt);
      return reply.ok ? { text: reply.text, html: false } : { text: `agy unavailable: ${reply.reason}`, html: false };
    }
    default:
      return { text: `Unknown command /${command}. /help lists what this bot answers.`, html: false };
  }
}

/* --- The live poller and the 07:00 schedule ----------------------------------------------------- */

let pollerRunning = false;
let stopped = false;
let reportTimer: ReturnType<typeof setTimeout> | null = null;

async function handleUpdate(update: bot.TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;
  const from = String(msg.chat.id);
  const chat = bot.chatId();
  if (!chat) {
    // Pairing step: only /start gets an answer, and only with the chat id — nothing else runs.
    const parsed = parseCommand(msg.text);
    if (parsed?.command === "start") {
      await bot
        .sendMessageTo(from, `your chat id is ${from} — add TELEGRAM_CHAT_ID=${from} to /app/.env and restart the dashboard`)
        .catch((err: unknown) => console.error(`telegram: reply to /start failed — ${describeError(err)}`));
    }
    return;
  }
  if (from !== chat) return; // any other chat is ignored silently, as the spec asks
  const parsed = parseCommand(msg.text);
  if (!parsed) return;
  try {
    const { text, html } = await dispatchCommand(parsed);
    await bot.sendMessage(text, { html });
  } catch (err) {
    await bot
      .sendMessage(`/${parsed.command} failed: ${describeError(err)}`)
      .catch((e: unknown) => console.error(`telegram: could not report a command failure — ${describeError(e)}`));
  }
}

async function pollLoop(): Promise<void> {
  let offset: number | undefined = readTelegramState().updateOffset ?? undefined;
  let backoffMs = 5_000;
  while (!stopped) {
    let updates: bot.TgUpdate[];
    try {
      updates = await bot.getUpdates(offset, 50);
      backoffMs = 5_000;
    } catch (err) {
      // A 409 means another process is polling the same bot (a test server, most likely) —
      // CLAUDE.md's "a test server arms its own nightly" pitfall, for this poller. Back off
      // rather than fight it; the other process's poll wins until it stops.
      const conflict = err instanceof bot.TelegramApiError && err.status === 409;
      console.error(`telegram: getUpdates failed${conflict ? " (409 — another poller is running)" : ""} — ${describeError(err)}`);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 5 * 60_000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      await handleUpdate(u).catch((err: unknown) => console.error(`telegram: update ${u.update_id} — ${describeError(err)}`));
    }
    if (updates.length) updateTelegramState((s) => (s.updateOffset = offset!));
  }
}

function scheduleReport(): void {
  if (reportTimer) clearTimeout(reportTimer);
  reportTimer = null;
  const hour = config.telegramReportHourWarsaw;
  if (hour === null || !bot.hasChat()) return;
  const delay = msUntilNextWarsawRun(Date.now(), hour);
  reportTimer = setTimeout(() => {
    sendMorningReport().catch((err: unknown) => console.error(`telegram: morning report failed — ${describeError(err)}`));
    scheduleReport();
  }, delay);
}

/**
 * Starts the bot: `setMyCommands`, the long-poll loop and the 07:00 Warsaw schedule. A test
 * server (`PORT` other than 8080 — CLAUDE.md) must not start any of this, or two processes would
 * both poll and both send the morning report.
 */
export async function startTelegramBot(): Promise<void> {
  if (!bot.isConfigured()) {
    console.error("telegram: TELEGRAM_BOT_TOKEN is not set — the bot does nothing");
    return;
  }
  if (!bot.hasChat()) {
    console.error("telegram: TELEGRAM_CHAT_ID is not set — waiting for /start to pair a chat");
  }
  await bot.setMyCommands(BOT_COMMANDS).catch((err: unknown) => console.error(`telegram: setMyCommands — ${describeError(err)}`));
  if (!pollerRunning) {
    pollerRunning = true;
    void pollLoop();
  }
  const state = readTelegramState();
  if (bot.hasChat() && shouldCatchUp(Date.now(), state.lastReportWarsawDate)) {
    console.error("telegram: sending the morning report now — a restart missed 07:00 and it is still before 10:00 Warsaw");
    sendMorningReport().catch((err: unknown) => console.error(`telegram: catch-up report failed — ${describeError(err)}`));
  }
  scheduleReport();
}

/** Test/shutdown seam: stops the poll loop after its current request settles. */
export function stopTelegramBot(): void {
  stopped = true;
  if (reportTimer) clearTimeout(reportTimer);
}
