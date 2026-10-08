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
import { listAutoHooks } from "../dashboard/shortFlow.js";
import * as bot from "./bot.js";
import { describeFailure, runClaude } from "./claude.js";
import { knowledgeFor } from "./knowledge.js";
import { BOT_COMMANDS, HELP_TEXT, parseCommand, parseStatsWindows, type ParsedCommand } from "./commands.js";
import {
  dashboardMatchUrl,
  gatherFacts,
  gatherNightlyInfo,
  gatherUpcoming,
  MORNING_SECTIONS,
  type ReportFacts,
} from "./facts.js";
import {
  fallbackToday,
  renderAlerts,
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
  renderWorth,
  renderYpp,
  type TodayAnswer,
  type TodayResult,
} from "./report.js";
import { msUntilNextWarsawRun, shouldCatchUp, warsawDateStr } from "./schedule.js";
import { readTelegramState, updateTelegramState } from "./state.js";
import { whenWarsaw } from "./report.js";

/** Only counts, ids and titles ever reach Claude — never a comment's own text or author. */
function factsForPrompt(f: ReportFacts): object {
  return {
    // Times as the operator's clock reads them, so Claude never has to convert (or print) an ISO
    // instant; the nightly's optional queue left out — it read to Claude as a chore.
    todo: f.todo.ok
      ? {
          waitingForHook: f.todo.data.waitingForHook,
          scheduledToday: f.todo.data.scheduledToday.map((r) => ({
            players: r.players,
            kind: r.kind,
            at: whenWarsaw(r.at),
          })),
          scheduledTomorrowCount: f.todo.data.scheduledTomorrowCount,
          scheduledDayAfterCount: f.todo.data.scheduledDayAfterCount,
          diskMatchesLeft: f.todo.data.diskMatchesLeft,
          diskLow: f.todo.data.diskLow,
          playoffsSoon: f.todo.data.playoffsSoon && {
            ...f.todo.data.playoffsSoon,
            startTime:
              f.todo.data.playoffsSoon.startTime &&
              whenWarsaw(new Date(f.todo.data.playoffsSoon.startTime * 1000).toISOString()),
          },
        }
      : { error: f.todo.error },
    // Already safe for a prompt: `NeedsYouItem.text` never carries a comment's own text or name
    // (gatherNeedsYou names the video a blocked runner commented on, nothing they wrote).
    needsYou: f.needsYou.ok
      ? f.needsYou.data.items.map((i) => ({ matchId: i.matchId, text: i.text }))
      : { error: f.needsYou.error },
    alerts: f.alerts.ok ? f.alerts.data : { error: f.alerts.error },
    servicesDown: f.health.filter((h) => !h.ok).map((h) => ({ name: h.name, detail: h.detail })),
    overnight: f.overnight.ok
      ? {
          uploadedCount: f.overnight.data.uploaded.length,
          nowPublicCount: f.overnight.data.nowPublic.length,
          nightlyRendered: f.overnight.data.nightlyRendered,
        }
      : { error: f.overnight.error },
    unansweredCommentsCount: f.comments.ok ? f.comments.data.unanswered.length : null,
    stats: f.stats.ok
      ? { live: f.stats.data.live, dataEndsOn: f.stats.data.dataEndsOn }
      : { error: f.stats.error },
    ypp: f.ypp.ok
      ? {
          subscribers: f.ypp.data.subscribers,
          watchHours: f.ypp.data.watchHours,
          shortsViews: f.ypp.data.shortsViews,
        }
      : { error: f.ypp.error },
  };
}

/** What the operator's day is, so Claude's to-do list is his, not a reading of the JSON. */
const CHANNEL_CONTEXT = [
  "You write for the person who runs MCSR Replayoffs, a small YouTube channel of Minecraft speedrun (MCSR Ranked) match replays; he lives in Poland.",
  "The pipeline renders one match every night by itself and uploads on its own once he saves that match's hooks (the long-form title hook and the Short's hook) on the dashboard: nothing uploads until he does.",
  "His jobs: save hooks for matches waiting for them; fix anything that failed; keep a video scheduled for every day (a day with nothing scheduled is what to avoid — the channel stops growing when it goes quiet); reply to viewers' comments; decisions only he can make.",
  "Videos already scheduled publish by themselves: never list them as tasks. Services that are up need nothing.",
].join(" ");

/** The TODAY session's whole instructions — no tools, no project context, nothing beyond this. */
const TODAY_SYSTEM_PROMPT =
  "You write a short status update for the person who runs a small YouTube channel. Plain text " +
  "only: no tools, no markdown, no JSON, no code fences. Every number you write must be copied " +
  "exactly from the FACTS you are given, never invented, estimated, or rounded differently. This " +
  "is for the operator's own eyes, never published.";

/** `/ask`'s whole instructions — same plain-text, no-invented-numbers contract as TODAY's. */
const ASK_SYSTEM_PROMPT =
  "You answer one question from the person who runs a small YouTube channel, using only the " +
  "FACTS and KNOWLEDGE he gives you. Plain text only: no tools, no markdown, no JSON. Never " +
  "invent a number. A few sentences at most. This is for the operator's own eyes, never published.";

function reportPrompt(facts: object): string {
  return [
    CHANNEL_CONTEXT,
    "FACTS below is a JSON object computed by code. Every number in your answer must be copied from FACTS, never invented, estimated, or rounded differently.",
    "Reply in plain text, in exactly this shape: line 1 is a short headline on how things stand (what is covered, what is at risk), which must not repeat a to-do item; then an ordered to-do list, one item per line, each starting with its number and a period, like '1. Save hooks for #12345'.",
    "The to-do list has at most 6 items, most important first, each starting with a verb and one line long; leave out anything that needs no action from him; if nothing does, say so in its one item.",
    "FACTS.needsYou is the deterministic list of exactly what still needs him (a printed, separate section he reads below your list): your to-do list must agree with it rather than inventing its own reasons, though you may put it in your own words and order it by what matters most.",
    "The same message lists needsYou, the problems, overnight uploads, stats and comments in detail below your list, so each item names the action, not the details.",
    "Write for a phone: plain words, no JSON field names, no ISO timestamps (times in FACTS are already his local time), '#<id>' only when he needs it to find a match.",
    "This goes only to the operator, never published: do not include any viewer comment text or names, and use only what is in FACTS.",
    "",
    `FACTS = ${JSON.stringify(facts)}`,
  ].join("\n");
}

const MAX_TODO = 8;
const MAX_LINE_CHARS = 300;

/** Strips control characters (not `\n`, there are none left by here) and bounds a line's length. */
function cleanLine(s: string): string | null {
  // eslint-disable-next-line no-control-regex -- deliberately stripping control bytes
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return t && t.length <= MAX_LINE_CHARS ? t : null;
}

/** Haiku's plain-text TODAY answer: line 1 the headline, then "1. …" items. Null for anything
 *  else — the caller's cue to fall back, same as a JSON answer that didn't validate used to be. */
export function parseTodayPlainText(raw: string): TodayAnswer | null {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const headline = lines.length ? cleanLine(lines[0]!) : null;
  if (!headline) return null;
  const todo = lines
    .slice(1)
    .map((l) => cleanLine(l.replace(/^\d+[.)]\s*/, "")))
    .filter((x): x is string => x !== null)
    .slice(0, MAX_TODO);
  return todo.length ? { headline, todo } : null;
}

async function todayClaude(facts: ReportFacts): Promise<TodayResult> {
  const alertCount = facts.alerts.ok ? facts.alerts.data.length : 0;
  const unansweredCount = facts.comments.ok ? facts.comments.data.unanswered.length : 0;
  const fallback = () => fallbackToday(facts.todo.ok ? facts.todo.data : null, alertCount, unansweredCount);
  const reply = await runClaude(reportPrompt(factsForPrompt(facts)), { systemPrompt: TODAY_SYSTEM_PROMPT });
  // ponytail: no retry-on-empty (one is allowed by spec); Haiku with no tools rarely answers
  // blank — add a single retry here if a real run proves that wrong.
  if (!reply.ok) return { source: "fallback", answer: fallback(), note: describeFailure(reply) };
  const answer = parseTodayPlainText(reply.text);
  return answer
    ? { source: "claude", answer }
    : { source: "fallback", answer: fallback(), note: "answered, but not a usable to-do list" };
}

export interface BuiltReport {
  messages: string[];
  facts: ReportFacts;
  claude: TodayResult;
}

/** Over this long: the "Auto-saved hooks" block's own window (not Needs you's — those items stand
 *  until the operator settles them, same as every other section here). */
const AUTO_HOOKS_REPORT_WINDOW_MS = 36 * 60 * 60 * 1000;

/** The full morning report's text, fresh — used by both the scheduled send and `/report`. */
export async function buildMorningReport(nowMs = Date.now()): Promise<BuiltReport> {
  const state = readTelegramState();
  const sinceMs = state.lastReportAt ? Date.parse(state.lastReportAt) : nowMs - 24 * 60 * 60 * 1000;
  const [facts, autoHooks] = await Promise.all([
    gatherFacts(nowMs, sinceMs, MORNING_SECTIONS),
    listAutoHooks(nowMs - AUTO_HOOKS_REPORT_WINDOW_MS, nowMs),
  ]);
  const claude = await todayClaude(facts);
  const messages = renderMorningReport(
    facts,
    claude,
    state.prevSnapshot,
    config.youtubeChannelId,
    nowMs,
    autoHooks,
  );
  return { messages, facts, claude };
}

/** Sends the morning report and records that it went out — the dedupe write. */
export async function sendMorningReport(nowMs = Date.now()): Promise<void> {
  const { messages, facts } = await buildMorningReport(nowMs);
  for (const m of messages) await bot.sendMessage(m, { html: true });
  updateTelegramState((s) => {
    s.lastReportWarsawDate = warsawDateStr(nowMs);
    s.lastReportAt = new Date(nowMs).toISOString();
    if (facts.stats.ok) s.prevSnapshot = facts.stats.data.live;
  });
}

export interface CommandReply {
  /** One Telegram message each; `/report` is three. */
  messages: string[];
  html: boolean;
}

/** One command's fresh answer — every command re-gathers its own facts, as the spec asks. */
export async function dispatchCommand({ command, args }: ParsedCommand): Promise<CommandReply> {
  switch (command) {
    case "help":
      return { messages: [HELP_TEXT], html: false };
    case "report": {
      return { messages: (await buildMorningReport()).messages, html: true };
    }
    case "todo": {
      const facts = await gatherFacts();
      const claude = await todayClaude(facts);
      return { messages: [renderToday(facts.todo, claude, facts.dashboardBaseUrl)], html: true };
    }
    case "alerts": {
      const facts = await gatherFacts(Date.now(), undefined, ["alerts"]);
      return { messages: [renderAlerts(facts.alerts)], html: true };
    }
    case "health": {
      const facts = await gatherFacts(Date.now(), undefined, ["health"]);
      return { messages: [renderHealth(facts.health)], html: true };
    }
    case "overnight":
    case "uploads": {
      const facts = await gatherFacts(Date.now(), undefined, ["overnight"]);
      const upcoming = await gatherUpcoming(Date.now(), 7);
      return {
        messages: [
          `${renderOvernight(facts.overnight, facts.dashboardBaseUrl)}\n\n${renderUpcoming(upcoming, 7, facts.dashboardBaseUrl)}`,
        ],
        html: true,
      };
    }
    case "stats": {
      const facts = await gatherFacts(Date.now(), undefined, ["stats"]);
      const state = readTelegramState();
      return {
        messages: [renderStats(facts.stats, state.prevSnapshot, parseStatsWindows(args))],
        html: true,
      };
    }
    case "comments": {
      const facts = await gatherFacts(Date.now(), undefined, ["comments"]);
      return { messages: [renderComments(facts.comments, config.youtubeChannelId)], html: true };
    }
    case "ypp": {
      const facts = await gatherFacts(Date.now(), undefined, ["ypp"]);
      return { messages: [renderYpp(facts.ypp)], html: true };
    }
    case "waiting": {
      const facts = await gatherFacts(Date.now(), undefined, ["todo"]);
      return { messages: [renderWaiting(facts.todo, facts.dashboardBaseUrl)], html: true };
    }
    case "needs": {
      const facts = await gatherFacts(Date.now(), undefined, ["needsYou"]);
      return { messages: [renderNeedsYou(facts.needsYou, facts.dashboardBaseUrl)], html: true };
    }
    case "worth": {
      // Fresh, not the six-hour copy the morning report reads: the operator asked now.
      const facts = await gatherFacts(Date.now(), undefined, ["worthRendering"], { freshWorth: true });
      return {
        messages: [renderWorth(facts.worthRendering, facts.dashboardBaseUrl, Infinity)],
        html: true,
      };
    }
    case "nightly": {
      const n = await gatherNightlyInfo();
      return { messages: [renderNightly(n, dashboardMatchUrl())], html: true };
    }
    case "ask": {
      if (!args.trim()) return { messages: ["usage: /ask <question>"], html: false };
      const facts = await gatherFacts();
      const prompt = [
        CHANNEL_CONTEXT,
        "Answer his one question below briefly, in plain words for a phone, as plain text (no markdown, no JSON). FACTS is today's live channel data; KNOWLEDGE is the channel's own reports (competitors, audience, YPP, edcr, what was decided in chat) with the date each figure was read.",
        "Every number in your answer must come from FACTS or KNOWLEDGE, never invented; say how old a figure is when it matters. This goes only to the operator: never include any viewer comment text or names.",
        "If neither has the answer, say what is missing and where it could be found (which report, which YouTube Studio page) instead of only saying you do not know.",
        `QUESTION: ${args.trim()}`,
        "",
        `FACTS = ${JSON.stringify(factsForPrompt(facts))}`,
        "",
        `KNOWLEDGE (markdown):\n${knowledgeFor(args)}`,
      ].join("\n");
      const reply = await runClaude(prompt, { systemPrompt: ASK_SYSTEM_PROMPT });
      // On a limit this is exactly "usage limit reached — try again later" and nothing else;
      // any other failure is the same one-line reason the TODAY note gives.
      return reply.ok
        ? { messages: [reply.text], html: false }
        : { messages: [describeFailure(reply)], html: false };
    }
    default:
      return { messages: [`Unknown command /${command}. /help lists what this bot answers.`], html: false };
  }
}

/* --- The live poller and the 07:00 schedule ----------------------------------------------------- */

let pollerRunning = false;
let stopped = false;
let reportTimer: ReturnType<typeof setTimeout> | null = null;

const CLAUDE_COMMANDS = new Set(["report", "todo", "ask"]);

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
        .sendMessageTo(
          from,
          `your chat id is ${from} — add TELEGRAM_CHAT_ID=${from} to /app/.env and restart the dashboard`,
        )
        .catch((err: unknown) => console.error(`telegram: reply to /start failed — ${describeError(err)}`));
    }
    return;
  }
  if (from !== chat) return; // any other chat is ignored silently, as the spec asks
  const parsed = parseCommand(msg.text);
  if (!parsed) return;
  try {
    // The adapter's own timeout is two minutes; Haiku on a plain-text ask usually answers in
    // seconds, but say so rather than go quiet on a slow one.
    if (CLAUDE_COMMANDS.has(parsed.command))
      await bot.sendMessage("asking Claude (haiku) — this can take up to two minutes").catch(() => undefined);
    else if (parsed.command === "worth")
      await bot
        .sendMessage("checking the last three days' matches — this can take up to a minute")
        .catch(() => undefined);
    const { messages, html } = await dispatchCommand(parsed);
    for (const m of messages) await bot.sendMessage(m, { html });
  } catch (err) {
    await bot
      .sendMessage(`/${parsed.command} failed: ${describeError(err)}`)
      .catch((e: unknown) =>
        console.error(`telegram: could not report a command failure — ${describeError(e)}`),
      );
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
      console.error(
        `telegram: getUpdates failed${conflict ? " (409 — another poller is running)" : ""} — ${describeError(err)}`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 5 * 60_000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      await handleUpdate(u).catch((err: unknown) =>
        console.error(`telegram: update ${u.update_id} — ${describeError(err)}`),
      );
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
    sendMorningReport().catch((err: unknown) =>
      console.error(`telegram: morning report failed — ${describeError(err)}`),
    );
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
  await bot
    .setMyCommands(BOT_COMMANDS)
    .catch((err: unknown) => console.error(`telegram: setMyCommands — ${describeError(err)}`));
  if (!pollerRunning) {
    pollerRunning = true;
    void pollLoop();
  }
  const state = readTelegramState();
  if (bot.hasChat() && shouldCatchUp(Date.now(), state.lastReportWarsawDate)) {
    console.error(
      "telegram: sending the morning report now — a restart missed 07:00 and it is still before 10:00 Warsaw",
    );
    sendMorningReport().catch((err: unknown) =>
      console.error(`telegram: catch-up report failed — ${describeError(err)}`),
    );
  }
  scheduleReport();
}

/** Test/shutdown seam: stops the poll loop after its current request settles. */
export function stopTelegramBot(): void {
  stopped = true;
  if (reportTimer) clearTimeout(reportTimer);
}
