// Contract test for state.ts (the dedupe file and the inbox), written from the docs (CLAUDE.md
// "Telegram bot", handbook claude-md-reference.md "Telegram bot"), not from the code. index.test.ts
// pins the inbox append path and the offset write's failure handling; this file pins the files'
// own guarantees: defaults on a missing/corrupt/old file, atomic writes that leave nothing behind,
// a read-modify-write that never drops the dedupe date, and an inbox that survives odd replies.
//
// Promises (numbering shared with index.contract.test.ts):
//  P7.  Dedupe is `<mediaDir>/.telegram.json`, written atomically (write-then-rename): the Warsaw date
//       the report last went out on, its instant, the previous channel snapshot, Telegram's cursor.
//  P19. A plain message appends ONE line `{at, text, messageId}` to `<mediaDir>/.telegram-inbox.jsonl`;
//       the CLI reads them oldest first; `--clear` moves the file aside before reading, so a reply
//       arriving mid-read starts a fresh file instead of being lost.
// Run: npx tsx src/telegram/state.contract.test.ts
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import {
  appendInbox,
  readInbox,
  readTelegramState,
  setStateDryRun,
  updateTelegramState,
  writeTelegramState,
  type TelegramState,
} from "./state.js";

/** A doc clause the code does not keep: printed, not thrown, so the suite stays green until triage. */
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const media = mkdtempSync(path.join(tmpdir(), "tg-state-contract-"));
config.mediaDir = media;
const stateFile = path.join(media, ".telegram.json");
const inboxFile = path.join(media, ".telegram-inbox.jsonl");
const EMPTY: TelegramState = {
  lastReportWarsawDate: null,
  lastReportAt: null,
  prevSnapshot: null,
  updateOffset: null,
  worth: null,
  titleOffers: {},
  fastTrackAsks: {},
};

try {
  /* --- P7: missing, corrupt and old-shaped files all read as "no report ever sent" ---------------- */
  assert.deepEqual(readTelegramState(), EMPTY, "missing file: nothing sent yet");
  writeFileSync(stateFile, '{"lastReportWarsawDate": "2026-10-1'); // a write cut mid-way
  assert.deepEqual(readTelegramState(), EMPTY, "corrupt file: the recoverable answer, not a throw");
  // A file from before `worth` existed still reads, every missing field defaulted.
  writeFileSync(stateFile, JSON.stringify({ lastReportWarsawDate: "2026-10-13", updateOffset: 7 }));
  assert.deepEqual(readTelegramState(), { ...EMPTY, lastReportWarsawDate: "2026-10-13", updateOffset: 7 });
  console.log("OK: missing, corrupt and old-shaped state files read as defaults");

  /* --- P7: atomic write — round-trips, and leaves no temp file in the media dir ------------------- */
  const full: TelegramState = {
    lastReportWarsawDate: "2026-10-14",
    lastReportAt: "2026-10-14T05:00:00.000Z",
    prevSnapshot: { subscribers: 120, views: 5000, videos: 30 },
    updateOffset: 991,
    worth: null,
    titleOffers: {
      "13560037": { messageId: 42, options: ["A"], source: ["chip"], at: "2026-10-14T05:00:00.000Z" },
    },
    fastTrackAsks: {},
  };
  writeTelegramState(full);
  assert.deepEqual(readTelegramState(), full);
  assert.deepEqual(
    readdirSync(media).filter((f) => f.startsWith(".telegram.json")),
    [".telegram.json"],
    "no .part file left beside it",
  );
  // The poller's cursor save is a read-modify-write: it must never drop the dedupe date or the
  // snapshot (losing the date would re-send the morning report on the next restart before 10:00).
  updateTelegramState((s) => (s.updateOffset = 992));
  assert.deepEqual(readTelegramState(), { ...full, updateOffset: 992 });
  console.log("OK: the state file round-trips atomically and a cursor save keeps the dedupe date");

  // The file IS the dedupe record: once it is gone (deleted by hand to re-send, or never written),
  // nothing is recorded. The first save on a fresh media dir must not leave its values behind in
  // the process as the "missing file" answer. Last in this section: a failure here leaks into reads.
  rmSync(stateFile);
  updateTelegramState((s) => {
    s.lastReportWarsawDate = "2026-10-14";
    s.updateOffset = 5;
  });
  rmSync(stateFile);
  deviation("Dedupe is <mediaDir>/.telegram.json (a missing file reads as no report sent)", () => {
    assert.deepEqual(readTelegramState(), EMPTY, "the file is gone, yet a report date is still read back");
  });

  /* --- P19: the inbox ---------------------------------------------------------------------------- */
  // A reply with a newline, quotes, HTML and emoji is still exactly one JSONL line, read back intact.
  const odd = 'yes — render it\nbut "not" <b>tonight</b> & 🎬';
  appendInbox({ at: "2026-10-14T06:00:00.000Z", text: "first", messageId: 1 });
  appendInbox({ at: "2026-10-14T06:01:00.000Z", text: odd, messageId: 2 });
  assert.equal(readFileSync(inboxFile, "utf8").split("\n").filter(Boolean).length, 2, "one line per reply");
  // A line that does not parse (a torn append) is skipped, not fatal, and the order is kept.
  appendFileSync(inboxFile, '{"at":"2026-10-14T06:02:00.000Z","te\n');
  appendInbox({ at: "2026-10-14T06:03:00.000Z", text: "third", messageId: 4 });
  assert.deepEqual(
    readInbox().map((e) => [e.messageId, e.text]),
    [
      [1, "first"],
      [2, odd],
      [4, "third"],
    ],
    "oldest first, the torn line skipped",
  );
  // --clear: everything once, then nothing — and no ".taken" file is left behind.
  assert.equal(readInbox(true).length, 3);
  assert.deepEqual(readInbox(), []);
  assert.ok(!readdirSync(media).some((f) => f.includes("inbox")), JSON.stringify(readdirSync(media)));
  // A reply after the clear starts a fresh file.
  appendInbox({ at: "2026-10-14T07:00:00.000Z", text: "after", messageId: 5 });
  assert.deepEqual(
    readInbox().map((e) => e.text),
    ["after"],
  );
  // --clear on an empty inbox is an empty answer, not an error.
  readInbox(true);
  assert.deepEqual(readInbox(true), []);
  console.log("OK: the inbox keeps odd replies on one line each, skips a torn line, clears cleanly");

  /* --- `npm run tg -- … --dry-run` leaves the media directory as it found it ----------------------- */
  writeTelegramState(full);
  const before = readFileSync(stateFile, "utf8");
  setStateDryRun(true);
  try {
    writeTelegramState({ ...full, lastReportWarsawDate: "2099-01-01" });
    updateTelegramState((s) => (s.updateOffset = 1));
    appendInbox({ at: "x", text: "dry", messageId: 9 });
    assert.equal(readFileSync(stateFile, "utf8"), before, "no dedupe record from a dry run");
    assert.deepEqual(readInbox(), [], "no inbox line from a dry run");
  } finally {
    setStateDryRun(false);
  }
  console.log("OK: a dry run writes neither the state file nor the inbox");

  console.log("state.contract: all checks passed");
} finally {
  rmSync(media, { recursive: true, force: true });
}
