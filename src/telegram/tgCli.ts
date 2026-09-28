/**
 * npm run tg -- <report|cmd "<text>"|send <text>|send --file <path>|whoami> [--dry-run]
 *
 * `report`/`cmd --dry-run` print the exact message text to stdout and send nothing — no
 * `TELEGRAM_BOT_TOKEN` needed, since they never call the Bot API. `whoami` is the pairing step:
 * it prints the chat ids that recently messaged the bot (from `getUpdates`), for the operator to
 * put in `TELEGRAM_CHAT_ID`.
 */
import { describeError } from "../errorText.js";
import * as bot from "./bot.js";
import { parseCommand } from "./commands.js";
import { buildMorningReport, dispatchCommand } from "./index.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rest = args.filter((a) => a !== "--dry-run");
const [sub, ...subArgs] = rest;

const usage = 'usage: npm run tg -- <report|cmd "<text>"|send <text>|send --file <path>|whoami> [--dry-run]';

async function main(): Promise<void> {
  switch (sub) {
    case "report": {
      const { text } = await buildMorningReport();
      if (dryRun) {
        console.log(text);
        return;
      }
      await bot.sendMessage(text, { html: true });
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
        console.log(reply.text);
        return;
      }
      await bot.sendMessage(reply.text, { html: reply.html });
      console.error("sent");
      return;
    }
    case "send": {
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
