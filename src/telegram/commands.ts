/**
 * Parsing the bot's slash commands — pure, so it can be pinned without a running poller.
 * index.ts owns what each command actually does; this only says which one was typed and with
 * what argument.
 */
import type { WindowDays } from "./windowStats.js";

export interface ParsedCommand {
  /** Lowercase, without the leading `/` or a `@botname` suffix (Telegram sends that in groups). */
  command: string;
  /** Everything after the command, trimmed; "" when there was none. */
  args: string;
}

/** null for anything that is not a slash command at all (an update this bot ignores). */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  const command = head!.slice(1).split("@")[0]!.toLowerCase();
  if (!command) return null;
  return { command, args: rest.join(" ") };
}

const WINDOW_ARGS: Record<string, WindowDays> = { "1d": 1, "3d": 3, "7d": 7, "30d": 30 };

/** `/stats` with no argument, or one not recognised, means all four windows. */
export function parseStatsWindows(args: string): WindowDays[] {
  const key = args.trim().toLowerCase();
  if (!key) return [1, 3, 7, 30];
  const w = WINDOW_ARGS[key];
  return w ? [w] : [1, 3, 7, 30];
}

/** The command menu Telegram shows, set once at boot (`setMyCommands`). Read-only — see `/help`. */
export const BOT_COMMANDS: readonly { command: string; description: string }[] = [
  { command: "report", description: "The full morning report, right now" },
  { command: "todo", description: "Today's to-do list" },
  { command: "alerts", description: "What failed in the last 24 h" },
  { command: "health", description: "Ping the APIs" },
  { command: "overnight", description: "Overnight uploads + the next 7 days' schedule" },
  { command: "stats", description: "Channel stats: /stats [1d|3d|7d|30d]" },
  { command: "comments", description: "Unanswered comments" },
  { command: "ypp", description: "Days to the next YPP tier" },
  { command: "waiting", description: "Matches waiting for a hook" },
  { command: "worth", description: "Matches worth rendering: known players, both VODs, last 3 days" },
  { command: "nightly", description: "Last nightly run + tonight's pick" },
  { command: "ask", description: "Ask Claude a question: /ask <question>" },
  { command: "help", description: "What this bot does" },
];

export const HELP_TEXT =
  "This bot only reads the channel and the dashboard — no command here uploads, renders, or " +
  "changes the queue. One morning report at 7 a.m. Warsaw time, and these on demand:\n\n" +
  BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`).join("\n");
