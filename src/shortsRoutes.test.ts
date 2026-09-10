import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleShortsRoute, lastShortPick, shortHookStale, type ShortRunner } from "./shortsRoutes.js";

/** Stands in for the render process. Without this the tests below start real renders. */
const spawned: Array<{ matchId: number; pick: number }> = [];
function makeRunner(finishImmediately: boolean): ShortRunner {
  return (matchId, pick) => {
    spawned.push({ matchId, pick });
    const proc = new EventEmitter() as ChildProcess;
    (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (proc as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    // The handler attaches its listeners after the runner returns, so close cannot be emitted
    // synchronously or it is missed.
    if (finishImmediately) setImmediate(() => proc.emit("close", 0));
    return proc;
  };
}
const fakeRunner = makeRunner(true);

/** Minimal stand-ins: these routes are tested for dispatch and input handling, not for HTTP. */
function context(body = "") {
  const calls: Array<{ status: number; payload: unknown }> = [];
  return {
    calls,
    ctx: {
      json: (_res: ServerResponse, status: number, payload: unknown) => calls.push({ status, payload }),
      readBody: async () => body,
      matchDir: (id: number) => `/media/${id}`,
      parseId: (raw: string | undefined) => (raw && /^\d+$/.test(raw) ? Number(raw) : null),
    },
  };
}
const req = (method: string) => ({ method }) as IncomingMessage;
const res = {} as ServerResponse;

// Anything that is not /api/shorts/... must fall through untouched, or this group would swallow
// the export and youtube routes registered around it.
{
  const { ctx, calls } = context();
  assert.equal(await handleShortsRoute(req("GET"), res, ["", "export", "project", "1"], ctx), false);
  assert.equal(await handleShortsRoute(req("GET"), res, ["", "youtube", "status", "1"], ctx), false);
  assert.equal(calls.length, 0, "a route that is not ours must not answer");
}

// An unknown action under /api/shorts falls through to server.ts's 404 rather than 500ing.
{
  const { ctx } = context();
  assert.equal(await handleShortsRoute(req("GET"), res, ["", "shorts", "nonsense", "1"], ctx), false);
}

// The match id gates a path.join, so a non-numeric one is rejected before any filesystem work.
{
  const { ctx, calls } = context();
  assert.equal(await handleShortsRoute(req("GET"), res, ["", "shorts", "moments", "../etc"], ctx), true);
  assert.equal(calls[0]!.status, 400);
}

// `pick` reaches a spawned process, so it is a trust boundary: clamped to a small integer, and
// a garbage body means "render the best moment" rather than an error.
{
  for (const [body, expected] of [
    ['{"pick": 3}', 3],
    ['{"pick": 99}', 4],
    ['{"pick": -5}', 0],
    ['{"pick": "2; rm -rf /"}', 0],
    ['{"pick": 1.5}', 0],
    ["not json at all", 0],
    ["", 0],
  ] as const) {
    const { ctx, calls } = context(body);
    assert.equal(
      await handleShortsRoute(req("POST"), res, ["", "shorts", "render", "12296170"], ctx, fakeRunner),
      true,
    );
    assert.equal(calls[0]!.status, 202);
    assert.equal(
      (calls[0]!.payload as { pick: number }).pick,
      expected,
      `pick from body ${JSON.stringify(body)}`,
    );
    // Let the stub's close fire. readBody resolves in a microtask, so without yielding to the
    // macrotask queue the whole loop runs in one turn and every request after the first joins
    // the still-"running" job instead of spawning.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Progress for a match nothing has rendered is a 404, not a hanging SSE stream.
{
  const { ctx, calls } = context();
  assert.equal(await handleShortsRoute(req("GET"), res, ["", "shorts", "progress", "999"], ctx), true);
  assert.equal(calls[0]!.status, 404);
}

// The clamped value is what actually reaches the process, not just what the response echoes.
assert.deepEqual(
  spawned.map((s) => s.pick),
  [3, 4, 0, 0, 0, 0, 0],
  "every render must be spawned with its clamped pick",
);
assert.ok(spawned.every((s) => s.matchId === 12296170));

// Concurrency 1 per match: a second request while one is in flight joins the running render
// rather than starting a competing ffmpeg on a four-core box.
{
  const busy = makeRunner(false);
  const before = spawned.length;
  const { ctx } = context("{}");
  await handleShortsRoute(req("POST"), res, ["", "shorts", "render", "555"], ctx, busy);
  await handleShortsRoute(req("POST"), res, ["", "shorts", "render", "555"], ctx, busy);
  assert.equal(spawned.length - before, 1, "a second request must join the render already running");
}

// Which moment the last cut used, for the one re-cut nobody clicks (the thumbnail re-render's).
// Moment 0 is a real answer, so a match this process never cut has to be null rather than 0 —
// otherwise the fallback is indistinguishable from a deliberate pick.
{
  const { ctx } = context('{"pick": 2}');
  await handleShortsRoute(req("POST"), res, ["", "shorts", "render", "424242"], ctx, fakeRunner);
  assert.equal(lastShortPick(424242), 2, "a re-cut repeats the moment the operator chose");
  assert.equal(lastShortPick(999), null, "nothing cut here yet");
}

// --- Whether a re-rendered thumbnail leaves the Short selling the old line --------------------
// This is what decides whether `POST /api/thumbnails/:id/rerender` cuts a second Short by itself,
// so a false positive burns a render and a false negative leaves the two halves disagreeing.
{
  const dir = await mkdtemp(path.join(tmpdir(), "mcsr-shorts-"));
  const hook = "Down to the last heart";
  await writeFile(path.join(dir, "short-777.mp4"), "");
  // What `buildShortTitle` writes: the hook, then the two tags every Short carries.
  await writeFile(path.join(dir, "short-777.title.txt"), `${hook} #minecraft #mcsr\n`);

  assert.equal(await shortHookStale(dir, 777, hook), false, "the burned-in line is already the new one");
  assert.equal(await shortHookStale(dir, 777, "Two blinds, one second apart"), true, "a new headline");
  assert.equal(await shortHookStale(dir, 777, "   "), false, "no headline is not a disagreement");
  assert.equal(await shortHookStale(dir, 778, hook), false, "nothing cut yet is nothing to re-cut");

  // The operator's edited title outranks the typed headline in the render itself, so a
  // thumbnail re-rendered with a different line would cut the *same* Short again: two minutes
  // of ffmpeg for an identical file, under a banner still saying the two disagree.
  await writeFile(path.join(dir, "match-777.title.edited.txt"), `${hook} | a vs b | Ranked\n`);
  assert.equal(
    await shortHookStale(dir, 777, "Two blinds, one second apart"),
    false,
    "the edited title still says what is burned in",
  );
  await writeFile(path.join(dir, "match-777.title.edited.txt"), "A new line entirely | a vs b\n");
  assert.equal(
    await shortHookStale(dir, 777, ""),
    true,
    "an edited title that moved on is a real disagreement, headline or not",
  );

  // 555 still has a render in flight from the case above; a second one would be a competing
  // ffmpeg cutting from the manifest that was just written anyway.
  await writeFile(path.join(dir, "short-555.mp4"), "");
  await writeFile(path.join(dir, "short-555.title.txt"), "an older line #minecraft #mcsr\n");
  assert.equal(await shortHookStale(dir, 555, hook), false, "a render in flight is already re-cutting");

  await rm(dir, { recursive: true, force: true });
}

console.log("shortsRoutes: all checks passed");
