// Contract test for restart-when-idle, written from the docs (CLAUDE.md "Restart only when idle",
// "Re-render a match's thumbnails beside the live set"; handbook/claude-md-reference.md "The
// dashboard can restart itself once it is idle" and its 8 Oct review fixes) before the source was
// read. Where restartWhenIdle.test.ts fakes every signal, this one drives the REAL signals — the
// live `idle()` the server's timer calls — with real work in flight in a scratch mediaDir:
//
//   R1  Nothing running is idle.
//   R2  A pipeline render (any match) is not idle, until it settles.
//   R3  A `.upload-session-*.json` left beside an export (where the uploader writes it) is not idle.
//   R4  A thumbnail re-render is not idle; R5 nor is a pending Put/Finish on YouTube.
//   R6  A nightly chain between renders (the suggestion scan, before any job exists) is not idle.
//   R7  The 20 minutes before `nightlyRenderHourUtc` is not idle — read live, so a Settings-tab
//       change applies without a restart, across midnight; `null` never blocks.
//   R8  Idle: the boot check (`npx tsc --noEmit`) runs first, then `process.exit(0)`.
//   R9  A failed boot check exits nothing, retries nothing, and keeps its error on the state until
//       a fresh POST (which clears it and checks again) or a DELETE — and that error is what the
//       Telegram morning report's health line reads.
//
// The NAS copy, the Short render, the pick queue, the publish chain and a live upload are signals
// with no hermetic way to start them from outside (rsync, Remotion, agy, the YouTube API); their
// wiring is pinned with fakes in restartWhenIdle.test.ts.
// Run: npx tsx src/dashboard/restartWhenIdle.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { startJob } from "./jobs.js";
import { runNightlyOnce } from "./nightly.js";
import { armRestart, disarmRestart, idle, restartState } from "./restartWhenIdle.js";
import { restartIdleHealth } from "../telegram/facts.js";
import { startRerender } from "../thumbnails/rerender.js";
import { sessionPath } from "../youtube/youtube.js";
import { onVideo } from "../youtube/youtubeStore.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const at = (iso: string): number => Date.parse(iso);
const NOON = at("2026-10-14T12:00:00Z");
/** The live signals, at a fixed instant — exactly what the 30 s check reads. */
const liveIdle = (nowMs = NOON): boolean => idle(undefined, nowMs);

const media = mkdtempSync(path.join(tmpdir(), "mcsr-restart-contract-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
const saved = { ...config };
config.mediaDir = media;
config.nightlyRenderHourUtc = null; // R7 sets it on purpose; elsewhere the clock must not matter

const realFetch = globalThis.fetch;
let releaseMatch!: () => void;
globalThis.fetch = ((input: string | URL | Request) => {
  if (!String(input instanceof Request ? input.url : input).includes("api.mcsrranked.com")) {
    return Promise.reject(new Error("no network in the test"));
  }
  // The render's first request hangs until the test lets it fail: a render "in flight".
  return new Promise<Response>(
    (_, reject) => (releaseMatch = () => reject(new Error("offline in the test"))),
  );
}) as typeof fetch;

const quiet = console.error;
try {
  /* --- R1 ------------------------------------------------------------------------------------- */
  assert.equal(liveIdle(), true, "an empty box with nothing running is idle");

  /* --- R2: a real pipeline job -------------------------------------------------------------------- */
  {
    const job = startJob(880001);
    assert.equal(liveIdle(), false, "a render in flight blocks the restart");
    console.error = () => {};
    releaseMatch();
    for (let i = 0; i < 100 && !job.done; i++) await sleep(5);
    console.error = quiet;
    assert.equal(job.done, true);
    assert.equal(liveIdle(), true, "a settled render no longer blocks it");
    console.log("OK: R1/R2 a real pipeline render blocks the restart until it settles");
  }

  /* --- R3: the upload session file, where the uploader puts it ------------------------------------ */
  {
    mkdirSync(matchDir(880002));
    const session = sessionPath(path.join(matchDir(880002), "final-880002.mp4"));
    writeFileSync(session, "{}");
    assert.equal(liveIdle(), false, "a cut-short upload's session on disk blocks the restart");
    rmSync(session);
    assert.equal(liveIdle(), true);
    // The Short's session too: it sits in the same directory under its own file name.
    writeFileSync(sessionPath(path.join(matchDir(880002), "short-880002.mp4")), "{}");
    assert.equal(liveIdle(), false, "a Short's upload session counts the same");
    rmSync(sessionPath(path.join(matchDir(880002), "short-880002.mp4")));
    console.log("OK: R3 an upload session file beside the export blocks the restart");
  }

  /* --- R4/R5: a thumbnail re-render; a pending Put on YouTube ------------------------------------- */
  {
    mkdirSync(matchDir(880003));
    let finishRerender!: () => void;
    startRerender(880003, () => new Promise((r) => (finishRerender = () => r({} as never))));
    assert.equal(liveIdle(), false, "a thumbnail re-render blocks the restart");
    finishRerender();
    await sleep(20);
    assert.equal(liveIdle(), true);

    let finishPut!: () => void;
    const put = onVideo(880003, () => new Promise<void>((r) => (finishPut = r)));
    assert.equal(liveIdle(), false, "a Put on YouTube waiting on the API blocks the restart");
    await sleep(5); // onVideo starts the write on a later tick
    finishPut();
    await put;
    assert.equal(liveIdle(), true);
    console.log("OK: R4/R5 a thumbnail re-render and a pending Put both block the restart");
  }

  /* --- R6: the nightly between renders --------------------------------------------------------------- */
  {
    let duringScan: boolean | null = null;
    await runNightlyOnce("", {
      renderInFlight: () => false,
      ranked: async () => {
        duringScan = liveIdle();
        return [];
      },
      now: () => NOON,
    });
    assert.equal(duringScan, false, "no job exists yet, but the nightly is choosing one: not idle");
    assert.equal(liveIdle(), true, "the night ended on a skip: idle again");
    console.log("OK: R6 a nightly scanning for its next render blocks the restart");
  }

  /* --- R7: the window before the nightly, read live ---------------------------------------------- */
  {
    config.nightlyRenderHourUtc = 3;
    assert.equal(liveIdle(at("2026-10-14T02:39:00Z")), true, "21 minutes before: clear");
    assert.equal(liveIdle(at("2026-10-14T02:41:00Z")), false, "19 minutes before: blocked");
    config.nightlyRenderHourUtc = 5; // moved in the Settings tab, no restart
    assert.equal(liveIdle(at("2026-10-14T02:41:00Z")), true, "the old hour no longer blocks");
    assert.equal(liveIdle(at("2026-10-14T04:45:00Z")), false, "the new one does");
    config.nightlyRenderHourUtc = 0;
    assert.equal(liveIdle(at("2026-10-13T23:45:00Z")), false, "a midnight nightly blocks 23:40-24:00");
    config.nightlyRenderHourUtc = null;
    assert.equal(liveIdle(at("2026-10-14T02:59:00Z")), true, "a disabled nightly never blocks");
    console.log("OK: R7 the 20 minutes before the nightly block, read live from the Settings value");
  }

  /* --- R8: idle -> boot check -> exit(0), in that order, against the live signals ----------------- */
  {
    const steps: string[] = [];
    armRestart({
      checkIntervalMs: 10,
      expireMs: 5_000,
      bootCheck: async () => (steps.push("tsc --noEmit"), null),
      exit: (code) => steps.push(`exit(${code})`),
    });
    for (let i = 0; i < 100 && steps.length < 2; i++) await sleep(5);
    assert.deepEqual(steps, ["tsc --noEmit", "exit(0)"], "the boot check first, then a clean exit for tini");
    disarmRestart();
    console.log("OK: R8 idle runs the boot check, then exits 0");
  }

  /* --- R9: a failed boot check — kept until a fresh POST or a DELETE, and reported ---------------- */
  {
    let checks = 0;
    let exits = 0;
    const failing = {
      checkIntervalMs: 10,
      bootCheck: async () => (checks++, "src/x.ts(1,1): error TS2304: Cannot find name 'y'."),
      exit: () => exits++,
    };
    armRestart({ ...failing, expireMs: 5_000 });
    await sleep(80);
    assert.equal(checks, 1, "no automatic retry");
    assert.equal(exits, 0, "code that does not type-check never takes the channel down");
    assert.match(restartState()?.error ?? "", /TS2304/, "the error stays on the state");
    assert.match(restartIdleHealth()?.detail ?? "", /TS2304/, "and reaches the morning report's health line");

    // A fresh POST: the error is cleared and the check runs again.
    const rearmed = armRestart({ ...failing, expireMs: 5_000 });
    assert.equal(rearmed.error, undefined, "a fresh POST starts clean");
    await sleep(80);
    assert.equal(checks, 2, "and checks again");
    // A DELETE clears it outright.
    assert.equal(disarmRestart(), true);
    assert.equal(restartState(), null);
    assert.equal(restartIdleHealth(), null);

    // Neither a POST nor a DELETE: the error is the morning report's only way to learn a
    // self-deploy never landed, and an evening arm is over six hours old by 07:00 Warsaw.
    // (expireMs scales the documented 6 h down.)
    armRestart({ ...failing, expireMs: 150 });
    await sleep(60);
    assert.match(restartState()?.error ?? "", /TS2304/);
    await sleep(200);
    const state = restartState();
    const health = restartIdleHealth();
    assert.match(
      state?.error ?? "",
      /TS2304/,
      `the arm's expiry cleared it with no POST or DELETE (restartState() = ${JSON.stringify(state)})`,
    );
    assert.match(health?.detail ?? "", /TS2304/, "the morning report still has the line after the expiry");
    assert.equal(checks, 3, "and the expiry did not start checking again");
    assert.equal(disarmRestart(), true, "a DELETE still clears it");
    assert.equal(restartIdleHealth(), null);
    console.log("OK: R9 a failed boot check never exits, never retries, and reports its error");
  }

  console.log("restartWhenIdle.contract: all checks passed");
} finally {
  console.error = quiet;
  disarmRestart();
  globalThis.fetch = realFetch;
  Object.assign(config, saved);
  rmSync(media, { recursive: true, force: true });
}
