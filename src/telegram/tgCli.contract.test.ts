// Contract test for `npm run tg -- inbox` (tgCli.ts), written from the docs (handbook
// claude-md-reference.md "Plain replies land in an inbox"), not from the code: the CLI is run as the
// operator's session runs it, in a child process, against a temp media dir named by a temp config
// file. Only the `inbox` subcommand — it never calls the Bot API, so no token is given at all.
//
// Promise (numbering shared with index.contract.test.ts):
//  P19. `npm run tg -- inbox [--since <ISO>] [--clear]` prints the saved replies oldest first as
//       `<at>  <text>`; `--clear` moves the file aside before reading, so the inbox is empty after
//       (with `--since`, of what it printed).
// Run: npx tsx src/telegram/tgCli.contract.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const tsx = path.join(repo, "node_modules", ".bin", "tsx");
const root = mkdtempSync(path.join(tmpdir(), "tg-cli-contract-"));
const media = path.join(root, "media");
mkdirSync(media);
const configFile = path.join(root, "mcsr-vid.config.json");
writeFileSync(configFile, JSON.stringify({ mediaDir: media }));
const inbox = path.join(media, ".telegram-inbox.jsonl");

/** One run of the CLI. cwd is the temp root, so no `.env` is read; no Telegram secret is passed. */
const tg = (...args: string[]): string =>
  execFileSync(tsx, [path.join(here, "tgCli.ts"), ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MCSR_CONFIG: configFile,
      MCSR_ARCHIVE_DIR: path.join(root, "archive"),
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
    },
    encoding: "utf8",
    timeout: 15_000,
  });

try {
  // Three replies, appended in the order they arrived (as the poller appends them).
  const entries = [
    { at: "2026-10-14T06:00:00.000Z", text: "yes, render it tonight", messageId: 11 },
    { at: "2026-10-14T07:30:00.000Z", text: "skip the Short for this one", messageId: 12 },
    { at: "2026-10-14T09:15:00.000Z", text: "ok", messageId: 13 },
  ];
  writeFileSync(inbox, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

  // Oldest first, `<at>  <text>` — two spaces, the documented shape.
  assert.equal(tg("inbox"), entries.map((e) => `${e.at}  ${e.text}`).join("\n") + "\n");
  assert.ok(existsSync(inbox), "a plain read leaves the inbox as it was");

  // --since: from that instant on (inclusive), still oldest first.
  assert.equal(
    tg("inbox", "--since", entries[1]!.at),
    `${entries[1]!.at}  ${entries[1]!.text}\n${entries[2]!.at}  ${entries[2]!.text}\n`,
  );

  // --clear: everything once, then the inbox is gone — no file, no leftover ".taken".
  assert.equal(tg("inbox", "--clear").trim().split("\n").length, 3);
  assert.deepEqual(
    readdirSync(media).filter((f) => f.includes("inbox")),
    [],
    "cleared: nothing left to read twice",
  );
  console.log(
    "OK: `tg inbox` prints oldest first as '<at>  <text>', honours --since, and --clear empties it",
  );

  // --since with --clear takes only what it printed: an older reply may be another session's answer
  // (sessions run concurrently), and it stays for a later read (review, 15 Oct 2026).
  writeFileSync(inbox, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  assert.equal(tg("inbox", "--since", entries[2]!.at, "--clear"), `${entries[2]!.at}  ${entries[2]!.text}\n`);
  assert.equal(
    tg("inbox"),
    `${entries[0]!.at}  ${entries[0]!.text}\n${entries[1]!.at}  ${entries[1]!.text}\n`,
    "the two older replies were never printed, so they are still there",
  );
  console.log("OK: `tg inbox --since X --clear` clears only what it printed");

  console.log("tgCli.contract: all checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
