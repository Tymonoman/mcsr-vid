/**
 * Dashboard for driving the pipeline from a browser instead of the TUI.
 *
 * Deliberately plain `node:http` with no framework and no new dependencies: every
 * useful operation already exists as an exported function, so this file is transport
 * and nothing else. Anything that looks like business logic here is a bug.
 *
 * Serves on 0.0.0.0 so the homelab's Tailscale interface publishes it too.
 */
import { createReadStream, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { listMatchStatuses } from "./matchStatus.js";
import { runPipeline, STAGE_LABELS, STAGE_ORDER, type StageEvent } from "./pipeline.js";
import { buildTitle } from "./title.js";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * A render in flight. Events are retained so a browser that connects late — or
 * reconnects from a phone — replays the whole run rather than joining blind.
 */
interface Job {
  matchId: number;
  events: StageEvent[];
  done: boolean;
  error: string | null;
  subscribers: Set<ServerResponse>;
  controller: AbortController;
}

const jobs = new Map<number, Job>();

/** Match ids come from the URL, so they gate a path join and must be digits only. */
function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function matchDir(matchId: number): string {
  return path.join(config.mediaDir, String(matchId));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readIfPresent(filePath: string): Promise<string | null> {
  return existsSync(filePath) ? readFile(filePath, "utf8") : null;
}

/**
 * Generated text is regenerable and the pipeline rewrites it on every run, so edits go
 * to a `.edited.txt` sibling rather than over the top. Reading prefers the edit.
 */
function metaPaths(matchId: number, kind: "title" | "description") {
  const base = path.join(matchDir(matchId), `match-${matchId}.${kind}`);
  return { generated: `${base}.txt`, edited: `${base}.edited.txt` };
}

async function readMeta(matchId: number) {
  const statuses = await listMatchStatuses();
  const entry = statuses.find((s) => s.matchId === matchId);

  const title = metaPaths(matchId, "title");
  const description = metaPaths(matchId, "description");
  const chaptersPath = path.join(matchDir(matchId), `match-${matchId}.chapters.txt`);

  // The hook is the one part a human writes (src/title.ts:5). buildTitle also returns the
  // character budget that keeps the title in the 70-100 band while leaving both nicknames
  // above YouTube's ~50-char mobile cutoff, which is what the editor counts against.
  const budget = entry
    ? buildTitle({ leftNickname: entry.leftNickname, rightNickname: entry.rightNickname })
    : null;

  return {
    matchId,
    leftNickname: entry?.leftNickname ?? null,
    rightNickname: entry?.rightNickname ?? null,
    title: (await readIfPresent(title.edited)) ?? (await readIfPresent(title.generated)),
    titleEdited: existsSync(title.edited),
    description:
      (await readIfPresent(description.edited)) ?? (await readIfPresent(description.generated)),
    descriptionEdited: existsSync(description.edited),
    chapters: await readIfPresent(chaptersPath),
    hook: budget && {
      generated: budget.generated,
      placeholder: budget.title,
      min: budget.hookMin,
      max: budget.hookMax,
    },
  };
}

function startJob(matchId: number): Job {
  const existing = jobs.get(matchId);
  if (existing && !existing.done) return existing;

  const controller = new AbortController();
  const job: Job = {
    matchId,
    events: [],
    done: false,
    error: null,
    subscribers: new Set(),
    controller,
  };
  jobs.set(matchId, job);

  const push = (event: StageEvent) => {
    job.events.push(event);
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of job.subscribers) res.write(frame);
  };

  runPipeline(String(matchId), { onEvent: push, signal: controller.signal })
    .then(() => {
      job.done = true;
    })
    .catch((err: unknown) => {
      job.done = true;
      job.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      const frame = `event: end\ndata: ${JSON.stringify({ error: job.error })}\n\n`;
      for (const res of job.subscribers) {
        res.write(frame);
        res.end();
      }
      job.subscribers.clear();
    });

  return job;
}

function streamProgress(res: ServerResponse, job: Job): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    // Proxies buffer SSE into uselessness; harmless when nothing proxies us.
    "x-accel-buffering": "no",
  });

  // Replay first, so a late or reconnecting client sees the whole run.
  for (const event of job.events) res.write(`data: ${JSON.stringify(event)}\n\n`);

  if (job.done) {
    res.write(`event: end\ndata: ${JSON.stringify({ error: job.error })}\n\n`);
    res.end();
    return;
  }

  job.subscribers.add(res);
  res.on("close", () => job.subscribers.delete(res));
}

function sendFile(res: ServerResponse, filePath: string, contentType: string): void {
  if (!existsSync(filePath)) {
    json(res, 404, { error: "not found" });
    return;
  }
  res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  createReadStream(filePath).pipe(res);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A description is a few KB; anything past this is not a description.
    if (size > 256 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments[0] !== "api") {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        sendFile(res, path.join(ROOT, "public", "index.html"), "text/html; charset=utf-8");
        return;
      }
      if (url.pathname === "/Monocraft.ttf") {
        sendFile(res, path.join(ROOT, "remotion", "assets", "fonts", "Monocraft.ttf"), "font/ttf");
        return;
      }
      json(res, 404, { error: "not found" });
      return;
    }

    const [, resource, idRaw] = segments;

    if (resource === "stages" && req.method === "GET") {
      json(res, 200, { order: STAGE_ORDER, labels: STAGE_LABELS });
      return;
    }

    if (resource === "matches" && req.method === "GET") {
      const statuses = await listMatchStatuses();
      // Newest first: match ids ascend with time, and the newest is what you just rendered.
      json(res, 200, { matches: statuses.sort((a, b) => b.matchId - a.matchId) });
      return;
    }

    const matchId = parseId(idRaw);
    if (matchId === null) {
      json(res, 400, { error: "match id must be digits" });
      return;
    }

    if (resource === "thumbnail" && req.method === "GET") {
      sendFile(res, path.join(matchDir(matchId), "thumbnail.png"), "image/png");
      return;
    }

    if (resource === "meta" && req.method === "GET") {
      json(res, 200, await readMeta(matchId));
      return;
    }

    if (resource === "meta" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req)) as { title?: string; description?: string };
      if (typeof body.title === "string") {
        await writeFile(metaPaths(matchId, "title").edited, body.title, "utf8");
      }
      if (typeof body.description === "string") {
        await writeFile(metaPaths(matchId, "description").edited, body.description, "utf8");
      }
      json(res, 200, await readMeta(matchId));
      return;
    }

    if (resource === "render" && req.method === "POST") {
      const job = startJob(matchId);
      json(res, 202, { matchId, running: !job.done });
      return;
    }

    if (resource === "render" && req.method === "DELETE") {
      jobs.get(matchId)?.controller.abort();
      json(res, 200, { matchId, aborted: true });
      return;
    }

    if (resource === "progress" && req.method === "GET") {
      const job = jobs.get(matchId);
      if (!job) {
        json(res, 404, { error: "no job for that match" });
        return;
      }
      streamProgress(res, job);
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`mcsr-vid dashboard on http://0.0.0.0:${PORT}  (mediaDir: ${config.mediaDir})`);
});
