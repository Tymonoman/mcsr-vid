/**
 * The dashboard's export endpoints: the desktop round-trip.
 *
 * The lab renders the assets, you cut in Kdenlive on the desktop, and the lab encodes the
 * finished MP4 — so the project file has to travel both ways. Split from server.ts for the same
 * reason as youtubeRoutes.ts: that file is at the 500-line cap. Transport only; the encode
 * itself lives in scripts/export.sh.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describeError } from "./errorText.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

export interface ExportRouteContext {
  json: Json;
  readBody: (req: IncomingMessage) => Promise<string>;
  matchDir: (matchId: number) => string;
  parseId: (raw: string | undefined) => number | null;
}

/**
 * Kdenlive saved the project on the desktop, so `root` points at a path that does not exist on
 * the lab. Rewriting that one attribute relocates the whole timeline — which is the entire
 * reason kdenliveProject.ts emits `root` with relative resources.
 */
export function relocateRoot(xml: string, dir: string): string {
  return xml.replace(/(<mlt\b[^>]*?\broot=")[^"]*(")/, `$1${dir}$2`);
}

/** One encode in flight. Lines are retained so a browser joining late replays the whole run. */
interface ExportJob {
  matchId: number;
  lines: string[];
  percent: number;
  done: boolean;
  error: string | null;
  subscribers: Set<ServerResponse>;
  proc: ChildProcess;
}

const jobs = new Map<number, ExportJob>();

const projectPath = (dir: string, matchId: number) => path.join(dir, `match-${matchId}.kdenlive`);
const finalPath = (dir: string) => path.join(dir, "final.mp4");

function broadcast(job: ExportJob, payload: unknown): void {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of job.subscribers) res.write(frame);
}

function startExport(matchId: number, dir: string): ExportJob {
  const existing = jobs.get(matchId);
  // Concurrency 1 per match falls out of this. Two *different* matches encoding at once would
  // contend for the lab's two cores; if that ever actually happens, flock in export.sh is the
  // fix rather than a scheduler here.
  if (existing && !existing.done) return existing;

  const proc = spawn("bash", ["scripts/export.sh", projectPath(dir, matchId), finalPath(dir)], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const job: ExportJob = {
    matchId,
    lines: [],
    percent: 0,
    done: false,
    error: null,
    subscribers: new Set(),
    proc,
  };
  jobs.set(matchId, job);

  const consume = (chunk: Buffer) => {
    for (const raw of chunk.toString("utf8").split(/\r?\n|\r/)) {
      const line = raw.trim();
      if (line === "") continue;
      // melt reports every single frame; an hour-long encode is tens of thousands of those.
      // Keep the percentage, drop the noise.
      const progress = /percentage:\s*(\d+)/.exec(line);
      if (progress) {
        const pct = Number(progress[1]);
        if (pct !== job.percent) {
          job.percent = pct;
          broadcast(job, { percent: pct });
        }
        continue;
      }
      job.lines.push(line);
      if (job.lines.length > 200) job.lines.shift();
      broadcast(job, { line });
    }
  };

  proc.stdout?.on("data", consume);
  proc.stderr?.on("data", consume);

  proc.on("close", (code) => {
    job.done = true;
    // 137 is the OOM killer. export.sh already says so on stderr, but the browser shows status
    // rather than the log tail, so the distinction has to survive up to here too.
    if (code !== 0) {
      job.error = code === 137 ? "killed by the OOM killer" : `export failed (exit ${code})`;
    }
    broadcast(job, { done: true, error: job.error, percent: job.error ? job.percent : 100 });
    for (const res of job.subscribers) res.end();
    job.subscribers.clear();
  });

  proc.on("error", (err) => {
    job.done = true;
    job.error = describeError(err);
    broadcast(job, { done: true, error: job.error });
    for (const res of job.subscribers) res.end();
    job.subscribers.clear();
  });

  return job;
}

export async function handleExportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  ctx: ExportRouteContext,
): Promise<boolean> {
  const [, resource, action, idRaw] = segments;
  if (resource !== "export") return false;

  const matchId = ctx.parseId(idRaw);
  if (matchId === null) {
    ctx.json(res, 400, { error: "bad match id" });
    return true;
  }
  const dir = ctx.matchDir(matchId);

  // Pull the generated project down to cut it.
  if (action === "project" && req.method === "GET") {
    const file = projectPath(dir, matchId);
    if (!existsSync(file)) {
      ctx.json(res, 404, { error: "no project for that match" });
      return true;
    }
    res.writeHead(200, {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="match-${matchId}.kdenlive"`,
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
    return true;
  }

  // Send the cut project back.
  if (action === "project" && req.method === "POST") {
    const body = await ctx.readBody(req);
    // Untrusted input: this is written to disk and then handed to melt. Refusing anything that
    // is not an MLT document costs nothing compared with discovering it 50 minutes into an
    // encode.
    if (!/^\s*<\?xml/.test(body) || !body.includes("<mlt")) {
      ctx.json(res, 400, { error: "not an MLT/Kdenlive project" });
      return true;
    }
    const relocated = relocateRoot(body, dir);
    await writeFile(projectPath(dir, matchId), relocated, "utf8");
    ctx.json(res, 200, { matchId, root: dir, rewritten: relocated !== body });
    return true;
  }

  if (action === "run" && req.method === "POST") {
    if (!existsSync(projectPath(dir, matchId))) {
      ctx.json(res, 404, { error: "no project for that match — upload the cut one first" });
      return true;
    }
    const job = startExport(matchId, dir);
    ctx.json(res, 202, { matchId, running: !job.done });
    return true;
  }

  if (action === "run" && req.method === "DELETE") {
    jobs.get(matchId)?.proc.kill("SIGTERM");
    ctx.json(res, 200, { matchId, aborted: true });
    return true;
  }

  if (action === "progress" && req.method === "GET") {
    const job = jobs.get(matchId);
    if (!job) {
      ctx.json(res, 404, { error: "no export for that match" });
      return true;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    // Replay first: an encode runs for the best part of an hour, so a phone whose screen locked
    // must not rejoin blind partway through.
    for (const line of job.lines) res.write(`data: ${JSON.stringify({ line })}\n\n`);
    res.write(`data: ${JSON.stringify({ percent: job.percent })}\n\n`);
    if (job.done) {
      res.write(`data: ${JSON.stringify({ done: true, error: job.error })}\n\n`);
      res.end();
      return true;
    }
    job.subscribers.add(res);
    req.on("close", () => job.subscribers.delete(res));
    return true;
  }

  if (action === "final" && req.method === "GET") {
    const file = finalPath(dir);
    if (!existsSync(file)) {
      ctx.json(res, 404, { error: "not exported yet" });
      return true;
    }
    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-disposition": `attachment; filename="match-${matchId}.mp4"`,
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
    return true;
  }

  return false;
}
