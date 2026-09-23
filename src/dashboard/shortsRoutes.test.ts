// Self-check for shortsRoutes.ts: dispatch, input handling at the trust boundary, and the gate —
// the render route refuses without the saved hook before anything is spawned. The flow behind
// plan / hooks / pick is shortFlow.test.ts.
// Run: npx tsx src/dashboard/shortsRoutes.test.ts
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { readShortLog, stepActivity } from "../shorts/shortLog.js";
import { handleShortsRoute, renderFailure, type ShortOverride, type ShortRunner } from "./shortsRoutes.js";

/** Stands in for the render process. Without this the tests below start real renders. */
const spawned: Array<{ matchId: number } & ShortOverride> = [];
function makeRunner(finishImmediately: boolean): ShortRunner {
  return (matchId, override = {}) => {
    spawned.push({ matchId, ...override });
    const proc = new EventEmitter() as ChildProcess;
    (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (proc as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    // The handler attaches its listeners after the runner returns, so close cannot be emitted
    // synchronously or it is missed.
    if (finishImmediately) setImmediate(() => proc.emit("close", 0));
    return proc;
  };
}
const run = makeRunner(true);

const media = await mkdtemp(path.join(tmpdir(), "mcsr-shorts-routes-"));
// The Short log is written under config's media dir: never the real one from a test.
config.mediaDir = media;

/** Minimal stand-ins: these routes are tested for dispatch and input handling, not for HTTP. */
function context(body = "") {
  const calls: Array<{ status: number; payload: unknown }> = [];
  return {
    calls,
    ctx: {
      json: (_res: ServerResponse, status: number, payload: unknown) => calls.push({ status, payload }),
      readBody: async () => body,
      matchDir: (id: number) => path.join(media, String(id)),
      parseId: (raw: string | undefined) => (raw && /^\d+$/.test(raw) ? Number(raw) : null),
    },
  };
}
const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;
const settle = () => new Promise((resolve) => setImmediate(resolve));

try {
  // Anything that is not /api/shorts/... must fall through untouched, or this group would swallow
  // the export and youtube routes registered around it.
  {
    const { ctx, calls } = context();
    assert.equal(await handleShortsRoute(req("GET"), res, ["", "export", "project", "1"], ctx), false);
    assert.equal(await handleShortsRoute(req("GET"), res, ["", "youtube", "status", "1"], ctx), false);
    assert.equal(calls.length, 0, "a route that is not ours must not answer");
  }

  // An unknown action under /api/shorts falls through to server.ts's 404 rather than 500ing — the
  // old `moments` list included: the model's pick is the cut, there are no cards to choose among.
  {
    const { ctx } = context();
    assert.equal(await handleShortsRoute(req("GET"), res, ["", "shorts", "nonsense", "1"], ctx), false);
    assert.equal(await handleShortsRoute(req("GET"), res, ["", "shorts", "moments", "1"], ctx), false);
  }

  // The match id gates a path.join, so a non-numeric one is rejected before any filesystem work.
  {
    const { ctx, calls } = context();
    assert.equal(await handleShortsRoute(req("GET"), res, ["", "shorts", "plan", "../etc"], ctx), true);
    assert.equal(calls[0]!.status, 400);
  }

  // The gate: no saved hook, no render — refused before anything is spawned.
  {
    const { ctx, calls } = context('{"at": 300000}');
    await handleShortsRoute(req("POST"), res, ["", "shorts", "render", "424242"], ctx, { run });
    assert.equal(calls[0]!.status, 409);
    assert.match((calls[0]!.payload as { error: string }).error, /waiting for the Short's hook/);
    assert.equal(spawned.length, 0, "nothing spawned without the hook");
  }

  // With the hook saved: `at` and `seconds` reach the argv as plain numbers, or not at all.
  for (const id of [515151, 515152, 515153]) {
    await mkdir(path.join(media, String(id)), { recursive: true });
    await writeFile(path.join(media, String(id), `short-${id}.hook.txt`), "Down to the last heart\n");
  }
  for (const [id, body, expected] of [
    [515151, '{"at": 300000, "seconds": 41.4}', { atMs: 300000, seconds: 41 }],
    [515152, '{"at": -5, "seconds": "40; rm -rf /"}', {}],
    [515153, "not json at all", {}],
  ] as const) {
    const { ctx, calls } = context(body);
    await handleShortsRoute(req("POST"), res, ["", "shorts", "render", String(id)], ctx, { run });
    assert.equal(calls[0]!.status, 202, body);
    assert.deepEqual(spawned.at(-1), { matchId: id, ...expected }, body);
    await settle();
  }

  // A Short already on the channel is not re-cut: the change would need a re-upload.
  {
    await writeFile(path.join(media, "515151", "youtube-short.json"), "{}");
    const { ctx, calls } = context("{}");
    const before = spawned.length;
    await handleShortsRoute(req("POST"), res, ["", "shorts", "render", "515151"], ctx, { run });
    assert.equal(calls[0]!.status, 409);
    assert.equal(spawned.length, before);
  }

  // Concurrency 1 per match: a second request while one is in flight joins the running render
  // rather than starting a competing ffmpeg on a four-core box.
  {
    const busy = makeRunner(false);
    const before = spawned.length;
    const { ctx } = context("{}");
    await handleShortsRoute(req("POST"), res, ["", "shorts", "render", "515152"], ctx, { run: busy });
    await handleShortsRoute(req("POST"), res, ["", "shorts", "render", "515152"], ctx, { run: busy });
    assert.equal(spawned.length - before, 1, "a second request must join the render already running");
  }

  // Progress for a match nothing has rendered is a 404, not a hanging SSE stream.
  {
    const { ctx, calls } = context();
    assert.equal(await handleShortsRoute(req("GET"), res, ["", "shorts", "progress", "999"], ctx), true);
    assert.equal(calls[0]!.status, 404);
  }

  // "Pick again" on a match with no finished video has nothing for the model to watch.
  {
    const { ctx, calls } = context();
    await handleShortsRoute(req("POST"), res, ["", "shorts", "pick", "515153"], ctx);
    assert.equal(calls[0]!.status, 409);
  }

  // The render's story in the Short log and its live line: what generateShort prints becomes the
  // activity's line and percent; the end is a line, a failure its words with the output as detail.
  {
    const id = 515154;
    await mkdir(path.join(media, String(id)), { recursive: true });
    await writeFile(path.join(media, String(id), `short-${id}.hook.txt`), "Down to the last heart\n");
    let proc: ChildProcess | null = null;
    const scripted: ShortRunner = (matchId, override = {}) => {
      spawned.push({ matchId, ...override });
      proc = makeRunner(false)(matchId, override);
      return proc;
    };
    const say = (line: string) =>
      (proc as unknown as { stderr: EventEmitter }).stderr.emit("data", Buffer.from(`${line}\n`));
    const { ctx } = context("{}");
    await handleShortsRoute(req("POST"), res, ["", "shorts", "render", String(id)], ctx, { run: scripted });
    assert.equal(stepActivity(id, "render")?.line, "cutting the Short");
    say(`Short of ${id}: 5:00–5:30, both\nHook: Down to the last heart`);
    say("  board: 100%");
    say("  compositing: 30%");
    assert.deepEqual(
      { ...stepActivity(id, "render"), since: "" },
      { step: "render", line: "encoding the Short", percent: 30, since: "" },
    );
    say(
      "the window 5:00–5:30 runs past the end of edcr's clip (it ends at 5:10 on the match clock) — Pick again, or cut it by hand earlier",
    );
    proc!.emit("close", 1, null);
    await settle();
    assert.equal(stepActivity(id, "render"), undefined, "no live line once it ends");
    const log = readShortLog(id);
    assert.deepEqual(
      log.map((l) => [l.level, l.text]),
      [
        ["info", "cutting the Short"],
        ["info", `cutting the Short of ${id}: 5:00–5:30, both`],
        ["info", "encoding the Short · 30%"],
        [
          "error",
          "the Short could not be cut: the window 5:00–5:30 runs past the end of edcr's clip (it ends at 5:10 on the match clock) — Pick again, or cut it by hand earlier",
        ],
      ],
    );
    assert.match(log.at(-1)!.detail!, /board: 100%[\s\S]*runs past the end/, "the output is the detail");

    await handleShortsRoute(req("POST"), res, ["", "shorts", "render", String(id)], ctx, { run: scripted });
    proc!.emit("close", 0, null);
    await settle();
    assert.match(readShortLog(id).at(-1)!.text, /^the Short is cut \(\d+ s\)$/);
    console.log("OK: a render's lines are its live line and percent, and its end or its failure a log line");
  }

  // A failed render in words: the box's own failures, the MCSR API, else the CLI's last say.
  {
    assert.match(
      renderFailure(137, null, ["  compositing: 40%"]),
      /^the Short's render was killed — out of memory/,
    );
    assert.match(renderFailure(null, "SIGKILL", []), /out of memory/);
    assert.match(
      renderFailure(1, null, [
        "Error: ffmpeg exited with 1: [out#0] Error writing trailer: No space left on device",
      ]),
      /^the Short's render failed: the disk is full/,
    );
    assert.match(renderFailure(1, null, ["Error: spawn ffmpeg ENOENT"]), /ffmpeg is not installed/);
    assert.match(
      renderFailure(1, null, ["McsrApiError: MCSR Ranked API /matches/1 -> 503 Service Unavailable"]),
      /^the MCSR API could not be reached — the Short was not cut; save the hooks again/,
    );
    assert.equal(
      renderFailure(1, null, [
        "file:///app/src/shorts/generateShort.ts:120",
        "  throw new Error(`Match 1 does not have two players.`);",
        "        ^",
        "Error: Match 1 does not have two players.",
        "    at file:///app/src/shorts/generateShort.ts:120:9",
        "Node.js v24.20.0",
      ]),
      "the Short could not be cut: Match 1 does not have two players.",
      "a crash: its Error line, not the stack",
    );
    assert.equal(renderFailure(2, null, []), "the Short could not be cut: exit code 2");
    console.log("OK: a failed render is named — memory, disk, a missing tool, the API, a refusal, a crash");
  }
} finally {
  await rm(media, { recursive: true, force: true });
}

console.log("shortsRoutes: all checks passed");
