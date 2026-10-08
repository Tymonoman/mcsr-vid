// Self-check for the pure half of auto-hooks (shortFlow.ts, "Auto-hooks"): the pick's age, the
// house-case rule, and the request `autoSaveHooks` builds from a choice — none of it needs the
// network or a match fixture, unlike `autoHooksTick`/`chooseAutoHooks` which do (covered end to
// end in shortFlow.test.ts instead).
// Run: npx tsx src/dashboard/autoHooks.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { autoHooksBody, pastHooksAreUpperCase, pickAgeMs } from "./shortFlow.js";
import type { ShortPick } from "../shorts/shortPlan.js";

const dir = mkdtempSync(path.join(tmpdir(), "mcsr-autohooks-"));
const matchId = 1;
const file = path.join(dir, `short-${matchId}.pick.json`);

try {
  const pick = (createdAt: string): ShortPick => ({
    gameMatchId: matchId,
    startMs: 0,
    endMs: 20_000,
    pov: "both",
    hookSuggestion: "x",
    why: "x",
    kind: "play",
    source: "agy",
    createdAt,
  });

  // No file at all: not readable, not due, ever.
  assert.equal(pickAgeMs(dir, matchId, Date.now(), null), null);

  // The pick's own `createdAt`, not the file's mtime, when it has one.
  const now = Date.parse("2026-10-08T12:00:00Z");
  writeFileSync(file, "{}"); // the file's mtime is "now" when it's written
  assert.equal(pickAgeMs(dir, matchId, now, pick("2026-10-08T06:00:00Z")), 6 * 3600_000);

  // A pick with no readable `createdAt` (truncated, or the caller never parsed one): the file's
  // own mtime stands in, so a very old file still reads as old rather than ageless.
  const old = new Date(now - 10 * 3600_000);
  writeFileSync(file, "not json");
  utimesSync(file, old, old);
  const age = pickAgeMs(dir, matchId, now, null);
  assert.ok(age !== null && age >= 10 * 3600_000 - 1000, `${age}`);
  console.log("OK: pickAgeMs reads the pick's own time, else the file's mtime");

  // The house-case rule: majority of the operator's own saved hooks that have a letter at all.
  assert.equal(pastHooksAreUpperCase([]), false, "nothing saved yet: leave the case alone");
  assert.equal(pastHooksAreUpperCase([{ hook: "58 MILLISECONDS" }, { hook: "WHO BLINKS FIRST?" }]), true);
  assert.equal(pastHooksAreUpperCase([{ hook: "A quiet finish" }, { hook: "Not a single death" }]), false);
  // A number-only "hook" has no letters and settles nothing on its own.
  assert.equal(pastHooksAreUpperCase([{ hook: "12345" }]), false);
  assert.equal(
    pastHooksAreUpperCase([{ hook: "12345" }, { hook: "A CLOSE ONE" }]),
    true,
    "the one lettered example decides",
  );
  // A tie reads as upper case too (>= 0.5): matching the house style is the safer default once
  // half the examples are shouting.
  assert.equal(pastHooksAreUpperCase([{ hook: "UPPER ONE" }, { hook: "lower one" }]), true);
  console.log("OK: pastHooksAreUpperCase is a plain majority of the lettered examples");

  // The request `autoSaveHooks` sends: upper-cased to the house style, "no Short" when nothing
  // survived for it, and the model/chip sources passed straight through for the record.
  const choice = {
    titleHook: "A sub-8 to win it",
    titleSource: "model" as const,
    shortHook: "Down to one heart",
    shortSource: "chip" as const,
  };
  assert.deepEqual(autoHooksBody(choice, false), {
    titleHook: "A sub-8 to win it",
    shortHook: "Down to one heart",
    noShort: false,
  });
  assert.deepEqual(autoHooksBody(choice, true), {
    titleHook: "A SUB-8 TO WIN IT",
    shortHook: "DOWN TO ONE HEART",
    noShort: false,
  });
  // No Short survived: "no Short" rather than null slipping through as a hook.
  const noShortChoice = { ...choice, shortHook: null, shortSource: null };
  assert.deepEqual(autoHooksBody(noShortChoice, false), {
    titleHook: "A sub-8 to win it",
    shortHook: null,
    noShort: true,
  });
  assert.deepEqual(autoHooksBody(noShortChoice, true), {
    titleHook: "A SUB-8 TO WIN IT",
    shortHook: null,
    noShort: true,
  });
  console.log("OK: autoHooksBody upper-cases both hooks together and derives noShort from the Short alone");

  console.log("autoHooks: all checks passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
