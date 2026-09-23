/**
 * The dashboard's Shorts endpoints: the plan, the hooks, the pick, and the Short render's own job
 * table. The decisions live in shortFlow.ts; this is transport.
 *
 * Its own job map rather than jobs.ts, following exportRoutes.ts, audit.ts and youtubeRoutes.ts:
 * jobs.ts is keyed by matchId alone, so a Short and a pipeline run on the same match would
 * collide — `startJob` would hand back the render job, and "stop" would abort the wrong one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describeError } from "../errorText.js";
import type { ExportRouteContext } from "./exportRoutes.js";
import { readShortHook, WAITING_FOR_HOOK } from "../shorts/shortHook.js";
import { sendVideo } from "./rangeStream.js";
import { isExported } from "./matchShelf.js";
import { queuePick, readStatus, saveHooks, shortPlan, startChain, type ChainDeps } from "./shortFlow.js";

/** One Short render in flight. Lines are retained so a browser joining late replays the run. */
interface ShortJob {
  matchId: number;
  lines: string[];
  done: boolean;
  error: string | null;
  subscribers: Set<ServerResponse>;
  proc: ChildProcess;
}

const jobs = new Map<number, ShortJob>();

/** A Short render writing into this match's directory right now. */
export const shortRunning = (matchId: number): boolean => jobs.get(matchId)?.done === false;

const shortPath = (dir: string, matchId: number) => path.join(dir, `short-${matchId}.mp4`);

function broadcast(job: ShortJob, payload: unknown): void {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of job.subscribers) res.write(frame);
}

/** The operator's override of the pick's window: `--at` (ms of the game's match clock) and `--seconds`. */
export interface ShortOverride {
  atMs?: number;
  seconds?: number;
}

/**
 * Spawns the render. Injectable so the route tests can exercise dispatch and input handling
 * without starting real renders.
 */
export type ShortRunner = (matchId: number, override?: ShortOverride) => ChildProcess;

/**
 * The one way a Short is rendered: `npm run short`, which refuses without the saved hook — the
 * same gate whichever button, chain or tick asked.
 */
const spawnShortCli: ShortRunner = (matchId, override = {}) =>
  spawn(
    "npm",
    [
      "run",
      "--silent",
      "short",
      "--",
      String(matchId),
      ...(override.atMs === undefined ? [] : [`--at=${Math.round(override.atMs)}`]),
      ...(override.seconds === undefined ? [] : [`--seconds=${override.seconds}`]),
    ],
    { stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd() },
  );

/**
 * The runner the chain uses: the same spawn, registered in this file's job table, so the delete
 * guard refuses and the progress stream answers while the chained Short is writing.
 */
export const spawnShortJob = (matchId: number, override?: ShortOverride): ChildProcess =>
  startShort(matchId, spawnShortCli, override).proc;

function startShort(matchId: number, run: ShortRunner, override?: ShortOverride): ShortJob {
  const existing = jobs.get(matchId);
  if (existing && !existing.done) return existing;

  const proc = run(matchId, override);
  const job: ShortJob = { matchId, lines: [], done: false, error: null, subscribers: new Set(), proc };
  jobs.set(matchId, job);

  const push = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const text = line.trim();
      if (text === "") continue;
      job.lines.push(text);
      broadcast(job, { line: text });
    }
  };
  proc.stdout?.on("data", push);
  proc.stderr?.on("data", push);

  proc.on("error", (err) => {
    job.error = describeError(err);
  });
  proc.on("close", (code) => {
    job.done = true;
    if (code !== 0 && job.error === null) job.error = `short render exited with code ${code}`;
    broadcast(job, { done: true, error: job.error });
    for (const res of job.subscribers) res.end();
    job.subscribers.clear();
  });

  return job;
}

export interface ShortsRouteOptions {
  run?: ShortRunner;
  /** The chain's seams, for the tests: a fake render and a fake uploader. */
  chain?: Partial<ChainDeps>;
}

export async function handleShortsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  ctx: ExportRouteContext,
  opts: ShortsRouteOptions = {},
): Promise<boolean> {
  const [, resource, action, idRaw] = segments;
  if (resource !== "shorts") return false;
  const run = opts.run ?? spawnShortCli;

  const matchId = ctx.parseId(idRaw);
  if (matchId === null) {
    ctx.json(res, 400, { error: "bad match id" });
    return true;
  }
  const dir = ctx.matchDir(matchId);

  // Where the match stands on its way to the channel. Opening an exported match with no pick
  // queues one, so the backlog fills in as it is looked at.
  if (action === "plan" && req.method === "GET") {
    ctx.json(res, 200, await shortPlan(matchId, { queue: true }));
    return true;
  }

  // The operator's one press: both hooks (or no Short), then everything runs by itself.
  if (action === "hooks" && req.method === "PUT") {
    let body: unknown;
    try {
      body = JSON.parse((await ctx.readBody(req)) || "{}");
    } catch {
      ctx.json(res, 400, { error: "expected a JSON body { titleHook, shortHook, noShort? }" });
      return true;
    }
    const refused = await saveHooks(matchId, body, opts.chain);
    if (refused) ctx.json(res, refused.status, { error: refused.error });
    else ctx.json(res, 202, await shortPlan(matchId));
    return true;
  }

  // "Pick again": the model watches the match afresh. Its pick is the cut; with the hooks saved,
  // the chain re-cuts behind the same hook once it lands.
  if (action === "pick" && req.method === "POST") {
    if (!isExported(matchId)) {
      ctx.json(res, 409, { error: "not exported yet — the model watches the finished video" });
      return true;
    }
    if (existsSync(path.join(dir, "youtube-short.json"))) {
      ctx.json(res, 409, {
        error: "the Short is already on the channel — a new pick would need a re-upload",
      });
      return true;
    }
    void queuePick(matchId, true).then(() => {
      if (readStatus(matchId).hooksSavedAt) void startChain(matchId, opts.chain);
    });
    ctx.json(res, 202, await shortPlan(matchId));
    return true;
  }

  // Playback, byte-ranged like the export preview: without ranges a <video> cannot seek.
  if (action === "preview" && (req.method === "GET" || req.method === "HEAD")) {
    const file = shortPath(dir, matchId);
    if (!existsSync(file)) {
      ctx.json(res, 404, { error: "no Short rendered yet" });
      return true;
    }
    await sendVideo(req, res, file, path.basename(file));
    return true;
  }

  // A render by hand: the pick's window, or the operator's (`at` ms of the game's match clock,
  // `seconds`). Refused here without the saved hook, as the CLI itself refuses — and, with the
  // hooks saved, the chain carries on to the uploads once it lands.
  if (action === "render" && req.method === "POST") {
    if ((await readShortHook(dir, matchId)) === null) {
      ctx.json(res, 409, { error: `${WAITING_FOR_HOOK} — save the hooks first` });
      return true;
    }
    if (existsSync(path.join(dir, "youtube-short.json"))) {
      ctx.json(res, 409, { error: "the Short is already on the channel — a new cut would need a re-upload" });
      return true;
    }
    const override: ShortOverride = {};
    try {
      const parsed = JSON.parse((await ctx.readBody(req)) || "{}") as { at?: unknown; seconds?: unknown };
      // These reach a spawned process's argv: plain finite numbers or nothing.
      if (typeof parsed.at === "number" && Number.isFinite(parsed.at) && parsed.at >= 0)
        override.atMs = Math.round(parsed.at);
      if (typeof parsed.seconds === "number" && Number.isFinite(parsed.seconds) && parsed.seconds > 0)
        override.seconds = Math.round(parsed.seconds);
    } catch {
      // An unparseable body is "the pick's window".
    }
    const job = startShort(matchId, run, override);
    job.proc.on("close", () => {
      if (readStatus(matchId).hooksSavedAt) void startChain(matchId, opts.chain);
    });
    ctx.json(res, 202, { started: true, ...override });
    return true;
  }

  if (action === "progress" && req.method === "GET") {
    const job = jobs.get(matchId);
    if (!job) {
      ctx.json(res, 404, { error: "no short render for that match" });
      return true;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    for (const line of job.lines) res.write(`data: ${JSON.stringify({ line })}\n\n`);
    if (job.done) {
      res.write(`data: ${JSON.stringify({ done: true, error: job.error })}\n\n`);
      res.end();
      return true;
    }
    job.subscribers.add(res);
    res.on("close", () => job.subscribers.delete(res));
    return true;
  }

  return false;
}
