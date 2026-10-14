/**
 * npm run tg -- <report|cmd "<text>"|send <text>|send --file <path>|inbox [--since <ISO>] [--clear]|whoami> [--dry-run]
 *
 * `report`/`cmd --dry-run` print the exact message text to stdout and send nothing — no
 * `TELEGRAM_BOT_TOKEN` needed, since they never call the Bot API. `whoami` is the pairing step:
 * it prints the chat ids that recently messaged the bot (from `getUpdates`), for the operator to
 * put in `TELEGRAM_CHAT_ID`. `inbox` prints the operator's plain replies the poller saved
 * (`.telegram-inbox.jsonl`), oldest first; `--clear` empties it after.
 */
import { describeError } from "../errorText.js";
import * as bot from "./bot.js";
import { parseCommand } from "./commands.js";
import { readFileSync } from "node:fs";
import { buildMorningReport, dispatchCommand } from "./index.js";
import { chunkMarkdown, mdToTelegramHtml } from "./markdown.js";
import { readInbox, setStateDryRun } from "./state.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rest = args.filter((a) => a !== "--dry-run");
const [sub, ...subArgs] = rest;
if (dryRun) setStateDryRun(); // a dry run leaves /media as it found it: no cache, no dedupe record

const usage =
  'usage: npm run tg -- <report|cmd "<text>"|send <text>|send --md <report.md>|send --file <path>|inbox [--since <ISO>] [--clear]|whoami> [--dry-run]';

/** Where one Telegram message ends and the next begins, in a dry run. */
const DRY_RUN_BREAK = "\n\n──────── next message ────────\n\n";

async function main(): Promise<void> {
  switch (sub) {
    case "report": {
      const { messages } = await buildMorningReport();
      if (dryRun) {
        console.log(messages.join(DRY_RUN_BREAK));
        return;
      }
      for (const m of messages) await bot.sendMessage(m, { html: true });
      console.error("sent");
      return;
    }
    case "cmd": {
      const text = subArgs.join(" ");
      const parsed = parseCommand(text);
      if (!parsed) {
        console.error(`not a command (needs a leading "/"): ${text}`);
        process.exit(2);
      }
      const reply = await dispatchCommand(parsed);
      if (dryRun) {
        console.log(reply.messages.join(DRY_RUN_BREAK));
        return;
      }
      for (const m of reply.messages) await bot.sendMessage(m, { html: reply.html });
      console.error("sent");
      return;
    }
    case "send": {
      // A report: the Markdown converted to Telegram's formatting, in pieces cut between
      // paragraphs; a piece Telegram will not parse goes again as plain text.
      const mdFlag = subArgs.indexOf("--md");
      if (mdFlag >= 0) {
        const mdPath = subArgs[mdFlag + 1];
        if (!mdPath) {
          console.error(usage);
          process.exit(2);
        }
        const chunks = chunkMarkdown(readFileSync(mdPath, "utf8").trim());
        for (const [i, chunk] of chunks.entries()) {
          const html = mdToTelegramHtml(chunk);
          if (dryRun) console.log(i ? `${DRY_RUN_BREAK}${html}` : html);
          else await bot.sendMessage(html, { html: true }).catch(() => bot.sendMessage(chunk));
        }
        if (!dryRun) console.error(`sent (${chunks.length} message${chunks.length === 1 ? "" : "s"})`);
        return;
      }
      const fileFlag = subArgs.indexOf("--file");
      if (fileFlag >= 0) {
        const filePath = subArgs[fileFlag + 1];
        const caption = [...subArgs.slice(0, fileFlag), ...subArgs.slice(fileFlag + 2)].join(" ");
        if (!filePath) {
          console.error(usage);
          process.exit(2);
        }
        await bot.sendDocument(filePath, caption || undefined);
        console.error("sent");
        return;
      }
      const text = subArgs.join(" ");
      if (!text) {
        console.error(usage);
        process.exit(2);
      }
      if (dryRun) {
        console.log(text);
        return;
      }
      await bot.sendMessage(text);
      console.error("sent");
      return;
    }
    case "inbox": {
      const sinceFlag = subArgs.indexOf("--since");
      const sinceMs = sinceFlag >= 0 ? Date.parse(subArgs[sinceFlag + 1] ?? "") : -Infinity;
      if (Number.isNaN(sinceMs)) {
        console.error(usage);
        process.exit(2);
      }
      for (const e of readInbox(subArgs.includes("--clear")))
        if (Date.parse(e.at) >= sinceMs) console.log(`${e.at}  ${e.text}`);
      return;
    }
    case "whoami": {
      const updates = await bot.getUpdates(undefined, 1);
      const ids = [
        ...new Set(updates.map((u) => u.message?.chat.id).filter((id): id is number => id !== undefined)),
      ];
      console.log(
        ids.length ? ids.join("\n") : "no recent messages — send /start to the bot first, then try again",
      );
      return;
    }
    default:
      console.error(usage);
      process.exit(2);
  }
}

main().catch((err: unknown) => {
  console.error(describeError(err));
  process.exit(1);
});
