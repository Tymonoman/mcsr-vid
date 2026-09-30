// Self-check for commands.ts's slash-command parsing.
// Run: npx tsx src/telegram/commands.test.ts
import assert from "node:assert/strict";
import { BOT_COMMANDS, HELP_TEXT, parseCommand, parseStatsWindows } from "./commands.js";

// Not a command at all.
assert.equal(parseCommand("hello there"), null);
assert.equal(parseCommand(""), null);
assert.equal(parseCommand("   "), null);

// A bare command.
assert.deepEqual(parseCommand("/report"), { command: "report", args: "" });
assert.deepEqual(parseCommand("  /report  "), { command: "report", args: "" });

// With an argument.
assert.deepEqual(parseCommand("/stats 7d"), { command: "stats", args: "7d" });
assert.deepEqual(parseCommand("/stats   7d  "), { command: "stats", args: "7d" });

// Multi-word argument (/ask), kept whole and case-preserved.
assert.deepEqual(parseCommand("/ask How many uploads this week?"), {
  command: "ask",
  args: "How many uploads this week?",
});

// A group chat's "@botname" suffix on the command itself is stripped; case-folded.
assert.deepEqual(parseCommand("/Report@MyChannelBot"), { command: "report", args: "" });
assert.deepEqual(parseCommand("/STATS@MyBot 1d"), { command: "stats", args: "1d" });

// /stats window parsing: known args map to one window; no argument or an unknown one is all four.
assert.deepEqual(parseStatsWindows(""), [1, 3, 7, 30]);
assert.deepEqual(parseStatsWindows("  "), [1, 3, 7, 30]);
assert.deepEqual(parseStatsWindows("1d"), [1]);
assert.deepEqual(parseStatsWindows("3D"), [3]);
assert.deepEqual(parseStatsWindows("7d"), [7]);
assert.deepEqual(parseStatsWindows("30d"), [30]);
assert.deepEqual(parseStatsWindows("nonsense"), [1, 3, 7, 30]);

// /worth is in Telegram's menu and /help lists it (HELP_TEXT is built from the menu).
assert.deepEqual(parseCommand("/worth"), { command: "worth", args: "" });
assert.ok(BOT_COMMANDS.some((c) => c.command === "worth"));
assert.ok(HELP_TEXT.includes("/worth — Matches worth rendering"), HELP_TEXT);

// Every command in the menu is unique and lowercase — Telegram rejects a duplicate or mixed-case one.
{
  const names = BOT_COMMANDS.map((c) => c.command);
  assert.deepEqual(names, [...new Set(names)]);
  for (const n of names) assert.equal(n, n.toLowerCase());
}

console.log("commands: all checks passed");
