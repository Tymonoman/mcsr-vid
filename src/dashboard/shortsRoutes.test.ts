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
import { handleShortsRoute, type ShortOverride, type ShortRunner } from "./shortsRoutes.js";

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
} finally {
  await rm(media, { recursive: true, force: true });
}

console.log("shortsRoutes: all checks passed");
