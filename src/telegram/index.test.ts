// Self-check for handleUpdate's inbox: the operator's plain replies are saved, nothing else is;
// and the poller's offset write can fail without taking the dashboard down.
// Run: npx tsx src/telegram/index.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Set before bot.ts loads: an empty token blocks `.env`'s real one (loadEnvFile never overwrites),
// so the "/help" below fails to send instead of reaching the operator's phone.
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_CHAT_ID = "42";
const { config } = await import("../config.js");
const { handleUpdate, saveUpdateOffset } = await import("./index.js");
const { readInbox, readTelegramState, writeTelegramState } = await import("./state.js");

config.mediaDir = mkdtempSync(path.join(os.tmpdir(), "tg-inbox-"));
const inboxFile = path.join(config.mediaDir, ".telegram-inbox.jsonl");
const update = (chat: number, text: string, id: number) => ({
  update_id: id,
  message: { message_id: id, chat: { id: chat }, text, date: 1_760_000_000 },
});

await handleUpdate(update(42, "yes, render it tonight", 1));
await handleUpdate(update(42, "/help", 2));
await handleUpdate(update(7, "not the operator", 3));

assert.deepEqual(readInbox(), [
  { at: new Date(1_760_000_000_000).toISOString(), text: "yes, render it tonight", messageId: 1 },
]);
assert.equal(readFileSync(inboxFile, "utf8").split("\n").filter(Boolean).length, 1);

// --clear: everything comes back once, then the inbox is empty.
assert.equal(readInbox(true).length, 1);
assert.deepEqual(readInbox(), []);

// The temp file is per process: a stale shared `.part` (here a directory, so writing to it would
// throw) is not in the way.
mkdirSync(path.join(config.mediaDir, ".telegram.json.part"));
saveUpdateOffset(5);
assert.equal(readTelegramState().updateOffset, 5);

// A state write that throws (the pid's own `.part` blocked) is logged, never thrown — pollLoop
// runs unawaited, so a throw would be an unhandled rejection that ends the dashboard.
let unhandled = 0;
process.on("unhandledRejection", () => unhandled++);
mkdirSync(path.join(config.mediaDir, `.telegram.json.${process.pid}.part`));
assert.throws(() => writeTelegramState(readTelegramState()));
const logged: string[] = [];
const realError = console.error;
console.error = (m: string) => void logged.push(m);
try {
  assert.doesNotThrow(() => saveUpdateOffset(9));
} finally {
  console.error = realError;
}
assert.match(logged.join("\n"), /could not save the update offset/);
assert.equal(readTelegramState().updateOffset, 5, "the failed write left the last good file alone");
await new Promise((r) => setImmediate(r));
assert.equal(unhandled, 0);

console.log("index: all checks passed");
