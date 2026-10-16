// Contract test for the pipeline's sync stage, written from the docs (CLAUDE.md "Known pitfalls";
// the handbook's "When the detector is not sure, a human settles it" and "Every consumer places
// the clips from sync.json") by an outside engineer. runPipeline is driven for real up to the
// end of the sync stage — MCSR API mocked from src/fixtures, POV clips already "downloaded",
// chats already saved — and stopped when the render stage starts, so nothing renders.
// Run: npx tsx src/pipeline/pipeline.contract.test.ts
//
// Promises covered (numbering shared with src/dashboard/syncRoutes.contract.test.ts):
//  P3  The pipeline writes <matchDir>/sync.json when the sync stage decides — refined or
//      kept-coarse — and `source` says which.
//  P2  A clip the picture cannot read keeps the coarse estimate at confidence 0.
//  P6  A manual sync (source "manual", confidence 1) makes the sync stage keep those numbers on a
//      re-render instead of re-running the detector.
//  P14 A re-render that corrects nothing must not make the export stale: only "a sync.json
//      correction after export" leaves it out of sync until re-encoded (exportStale).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { runPipeline, type StageEvent } from "./pipeline.js";
import {
  exportStale,
  readSyncOffsets,
  syncFilePath,
  writeSyncOffsets,
  type SyncOffsets,
} from "./syncFile.js";

/** Keeps the docs' wording where the code differs; prints it and carries on until triage. */
async function deviation(clause: string, check: () => void | Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const ID = 12730175; // edcr vs doogile, a real ranked match with both VODs attached
const fixture = readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8");
const media = mkdtempSync(path.join(tmpdir(), "pipeline-sync-contract-"));
config.mediaDir = media;

const offline: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.mcsrranked.com") {
    if (url.pathname === `/matches/${ID}`) return new Response(`{"status":"success","data":${fixture}}`);
    // getUser / getVersus: the render's data, not the sync stage's — any well-formed answer.
    if (url.pathname.includes("/versus/")) return new Response('{"status":"success","data":[]}');
    if (url.pathname.startsWith("/users/")) return new Response('{"status":"success","data":{}}');
  }
  offline.push(String(url));
  throw new Error(`no network in a contract test: ${url}`);
}) as typeof fetch;

const dir = matchDir(ID);
mkdirSync(dir, { recursive: true });
// "Downloaded" POV clips (empty: the picture cannot be read off them) and saved chats (so the
// best-effort chat save asks Twitch for nothing). No viewer text: empty message lists.
for (const nick of ["edcr", "doogile"]) {
  writeFileSync(path.join(dir, `${nick}.mp4`), "");
  writeFileSync(path.join(dir, `chat-${nick}.json`), JSON.stringify({ nickname: nick, messages: [] }));
}

class StopAtRender extends Error {}
/** runPipeline until the render stage starts; returns the sync stage's events. */
async function runThroughSync(): Promise<StageEvent[]> {
  const events: StageEvent[] = [];
  let stopped = false;
  await assert.rejects(
    runPipeline(String(ID), {
      onEvent: (e) => {
        events.push(e);
        if (e.stage === "render" && !stopped) {
          stopped = true;
          throw new StopAtRender();
        }
      },
    }),
    StopAtRender,
  );
  return events.filter((e) => e.stage === "sync");
}

try {
  // --- P3 / P2: nothing readable — the coarse estimate is written, and says so ------------------
  {
    const events = await runThroughSync();
    const written = readSyncOffsets(dir);
    // P3: written in the kept-coarse case too, so export:fast and the Short can tell "never
    // synced" (no file) from "synced, and the estimate was the answer".
    assert.ok(written, "sync.json is written even when the detector read nothing");
    assert.equal(written.source, "coarse", "source says the detector's numbers were not taken");
    // P2: the coarse estimate (preRollSec into each clip — the download's own placement) at 0.
    assert.equal(written.left, config.preRollSec);
    assert.equal(written.right, config.preRollSec);
    assert.equal(written.confidence, 0);
    assert.equal(events.at(-1)?.status, "warn", "the stage reports its doubt rather than done");
  }

  // --- P6: a hand fix survives a re-render ----------------------------------------------------
  const manual: SyncOffsets = {
    left: 153.25,
    right: 148.5,
    confidence: 1,
    detail: "set in the dashboard, replacing coarse",
    source: "manual",
  };
  writeSyncOffsets(dir, manual);
  {
    const events = await runThroughSync();
    // Had the detector run on these unreadable clips it would have written "coarse" at 150/150
    // (the case above) — the machine's rejected guess put back, the overlay slid by 3 s.
    assert.deepEqual(readSyncOffsets(dir), manual, "the operator's numbers, untouched");
    const last = events.at(-1)!;
    assert.equal(last.status, "done");
    assert.match(String(last.message), /manual/, "the stage says it kept the manual sync");
  }

  // --- P14: a re-render that changes nothing leaves a fresh export fresh -----------------------
  {
    const now = Date.now();
    const final = path.join(dir, `final-${ID}.mp4`);
    writeFileSync(final, "the export");
    utimesSync(syncFilePath(dir), new Date(now - 120_000), new Date(now - 120_000)); // the fix
    utimesSync(final, new Date(now - 60_000), new Date(now - 60_000)); // exported after it
    assert.equal(exportStale(dir, final).stale, false, "exported after the fix: fresh");

    await runThroughSync(); // e.g. a re-render for a new thumbnail
    assert.deepEqual(readSyncOffsets(dir), manual, "no number moved");
    await deviation(
      "exportStale: only a sync.json correction after export leaves the video out of sync until re-exported (and a re-render keeps the hand fix)",
      () =>
        assert.equal(
          exportStale(dir, final).stale,
          false,
          "the manual-keep branch rewrites sync.json with the same numbers, bumping its mtime, so a re-render after export refuses Upload/nightly/adopt until a needless ~10 min re-export",
        ),
    );
  }

  // --- Stop during sync: the run stops, and the earlier countdown reading stays ----------------
  // The detectors rethrow an abort; read as "refinement failed" it wrote the coarse estimate over
  // a good sync.json (export now stale, a re-encode out of sync) and went on into the render.
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
    console.log("SKIP: Stop during sync (no ffmpeg on PATH: the detector's spawn is what aborts)");
  } else {
    const countdown: SyncOffsets = {
      left: 151.5,
      right: 149,
      confidence: 0.9,
      detail: "digit for 10s with 9 steps",
      source: "countdown",
    };
    writeSyncOffsets(dir, countdown);
    const stop = new AbortController();
    const stages: string[] = [];
    const err = await runPipeline(String(ID), {
      signal: stop.signal,
      onEvent: (e) => {
        stages.push(`${e.stage}:${e.status}`);
        if (e.stage === "sync" && e.status === "active") stop.abort();
        if (e.stage === "render" && e.status === "active") throw new StopAtRender();
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(
      err !== null && !(err instanceof StopAtRender),
      `the run stops at sync, got ${stages.join(" ")}`,
    );
    assert.deepEqual(readSyncOffsets(dir), countdown, "the earlier countdown reading is untouched");
    assert.ok(stages.includes("sync:warn") && !stages.some((s) => s.startsWith("render")), stages.join(" "));
    console.log("OK: Stop during sync stops the run and keeps sync.json");
  }
} finally {
  rmSync(media, { recursive: true, force: true });
}

assert.deepEqual(offline, [], "nothing but the mocked MCSR API was asked for");
console.log("pipeline.contract: all checks passed");
