// Self-check for facts.ts's deadline on the worth-rendering section: a gather that never settles
// (a slow MCSR API, a hung yt-dlp) must cost the report one failure line, not the report.
// Run: npx tsx src/telegram/facts.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { armRestart, disarmRestart } from "../dashboard/restartWhenIdle.js";
import {
  gatherFacts,
  gatherWorthSection,
  restartIdleHealth,
  WORTH_DEADLINE_MS,
  withDeadline,
} from "./facts.js";
import type { WorthFacts } from "./worth.js";

// A gather reads the state file and the scans' cache from the media directory: keep it a scratch one.
const media = mkdtempSync(path.join(tmpdir(), "mcsr-facts-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;

const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
const baseline = timers();
let unhandled = 0;
process.on("unhandledRejection", () => unhandled++);

try {
  assert.equal(WORTH_DEADLINE_MS, 120_000);

  // A gather that never settles degrades to the section's one failure line once the deadline passes.
  const started = Date.now();
  const hung = await gatherWorthSection(0, false, 40, () => new Promise<WorthFacts>(() => {}));
  assert.deepEqual(hung, { ok: false, error: "worth rendering timed out" });
  assert.ok(Date.now() - started >= 35, "it waited for the deadline, not less");
  assert.equal(timers(), baseline);

  // A gather inside the deadline passes through with its arguments, and leaves no timer behind: the
  // real deadline is two minutes, and a CLI run must not wait them out after it has printed.
  const facts: WorthFacts = { matches: [], notes: ["a note"] };
  const seen: unknown[] = [];
  const ok = await gatherWorthSection(7, true, undefined, async (now, opts) => (seen.push(now, opts), facts));
  assert.deepEqual(ok, { ok: true, data: facts });
  assert.deepEqual(seen, [7, { fresh: true }]);
  assert.equal(timers(), baseline);

  // A gather that fails says why, not "timed out".
  const failed = await gatherWorthSection(0, false, undefined, async () => {
    throw new Error("boom");
  });
  assert.deepEqual(failed, { ok: false, error: "boom" });
  assert.equal(timers(), baseline);

  // One that overruns and then fails is the race's to handle: an unhandled rejection would take the
  // dashboard process down with it.
  const late = await withDeadline(
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), 60)),
    10,
    "overran",
  ).catch((err: Error) => err.message);
  assert.equal(late, "overran");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(unhandled, 0);

  // And through gatherFacts itself, the way the morning report and /worth reach it: the MCSR API
  // never answers, the report still comes back, with that one section failed.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
  try {
    const gathered = await gatherFacts(Date.parse("2026-09-30T20:00:00Z"), undefined, ["worthRendering"], {
      freshWorth: true,
      worthDeadlineMs: 40,
    });
    assert.deepEqual(gathered.worthRendering, { ok: false, error: "worth rendering timed out" });
    assert.deepEqual(gathered.todo, { ok: false, error: "not requested" }); // nothing else was gathered
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(timers(), baseline);

  // A failed restart-when-idle boot check (src/dashboard/restartWhenIdle.ts) is this process'
  // own state, not a ping — it must surface in `gatherHealth`'s list the same way a down API
  // does, since that is the only way it ever reaches the Telegram report (review fix, 8 Oct 2026).
  assert.equal(restartIdleHealth(), null, "nothing armed — no health line");
  armRestart({
    idleDeps: () => ({
      jobRunning: () => false,
      exportRunning: () => false,
      shortRunning: () => false,
      pickRunning: () => false,
      chainRunning: () => false,
      uploadRunning: () => false,
      uploadSessionFile: () => false,
      archiveRunning: () => false,
      nightlyChainRunning: () => false,
      nightlyHourUtc: null,
    }),
    bootCheck: async () => "src/foo.ts(1,1): error TS1: bogus\nmore detail",
    checkIntervalMs: 10,
    expireMs: 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const restartHealth = restartIdleHealth();
  assert.deepEqual(restartHealth, {
    name: "restart-when-idle",
    ok: false,
    detail: "src/foo.ts(1,1): error TS1: bogus",
  });
  disarmRestart();
  assert.equal(restartIdleHealth(), null, "disarming clears the health line too");

  console.log("facts: all checks passed");
} finally {
  rmSync(media, { recursive: true, force: true });
}
