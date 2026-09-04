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
import { describeError } from "./errorText.js";
import { listMatchStatuses, matchStatusFor } from "./matchStatus.js";
import { parseMatchId } from "./mcsrApi.js";
import { runPipeline, STAGE_LABELS, STAGE_ORDER, type StageEvent, type StageId } from "./pipeline.js";
import { dismiss, snapshot, startScan } from "./suggestScan.js";
import { buildTitle } from "./title.js";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Same match page the generated description links to (src/description.ts). */
const MCSR_MATCH_URL = "https://mcsrranked.com/matches/";

/**
 * A render in flight. Events are retained so a browser that connects late — or
 * reconnects from a phone — replays the whole run rather than joining blind.
 */
interface Job {
  matchId: number;
  events: StageEvent[];
  done: boolean;
  /** Failure text, or null when the run succeeded *or* was deliberately aborted. */
  error: string | null;
  /** Which stage the failure belongs to, so the browser can mark that row rather than guess. */
  errorStage: StageId | null;
  /** A deliberate stop via DELETE /api/render/:id, which is not a failure. */
  aborted: boolean;
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
  // One API request, not one per existing match directory: this used to go through
  // listMatchStatuses purely to read two nicknames for the hook budget.
  const entry = await matchStatusFor(matchId);

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
    description: (await readIfPresent(description.edited)) ?? (await readIfPresent(description.generated)),
    descriptionEdited: existsSync(description.edited),
    chapters: await readIfPresent(chaptersPath),
    hook: budget && {
      generated: budget.generated,
      placeholder: budget.title,
      min: budget.hookMin,
      max: budget.hookMax,
    },
    matchUrl: `${MCSR_MATCH_URL}${matchId}`,
    /** Why the entry is degraded (API unreachable), or null. Surfaced so "?" is never a lie. */
    error: entry.error,
    /**
     * Where the run actually put things. The TUI's success summary lists all of these and the
     * dashboard showed none, so the one artifact you open by hand — the Kdenlive project — was
     * the one thing it could not tell you the path of.
     */
    outputs: outputPaths(matchId, entry.projectPath),
  };
}

/** Absolute paths of the run's artifacts, each null until the stage that writes it has run. */
function outputPaths(matchId: number, projectPath: string | null) {
  const dir = matchDir(matchId);
  const ifPresent = (p: string) => (existsSync(p) ? path.resolve(p) : null);
  return {
    project: projectPath,
    title: ifPresent(metaPaths(matchId, "title").generated),
    description: ifPresent(metaPaths(matchId, "description").generated),
    chapters: ifPresent(path.join(dir, `match-${matchId}.chapters.txt`)),
    overlay: ifPresent(path.join(dir, "overlay.mov")),
    thumbnail: ifPresent(path.join(dir, "thumbnail.png")),
    // Written by `npm run validate-sync`, never by the pipeline — worth surfacing because it is
    // the only artifact that lets you eyeball whether the audio sync actually landed.
    syncPreview: ifPresent(path.join(dir, "sync-preview.mp4")),
  };
}

/**
 * A suggestion as the browser needs it: the numbers the TUI's row shows, plus the links it only
 * ever printed as plain text. The mcsrranked URL is built here rather than in the page so the
 * one already in every generated description (src/description.ts) stays the single definition.
 */
function suggestionsPayload() {
  const state = snapshot();
  const suggestions = (state.result?.suggestions ?? []).map((s) => ({
    matchId: s.metrics.matchId,
    players: s.metrics.players,
    winner: s.metrics.winner,
    bucket: s.bucket,
    score: s.score,
    popularity: s.popularity,
    resultMs: s.metrics.resultMs,
    finishMarginMs: s.metrics.finishMarginMs,
    finishEstimated: s.metrics.finishEstimated,
    leadChanges: s.metrics.leadChanges,
    deaths: s.metrics.deaths,
    dateSec: s.dateSec,
    matchUrl: `${MCSR_MATCH_URL}${s.metrics.matchId}`,
    vodUrls: s.vodUrls,
  }));

  return {
    suggestions,
    scanning: state.scanning,
    error: state.error,
    scanned: state.scanned,
    candidates: state.candidates,
    scannedAtMs: state.scannedAtMs,
    note: state.result?.note ?? null,
    usedTwitchFollowers: state.result?.usedTwitchFollowers ?? false,
    stats: state.result?.stats ?? null,
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
    errorStage: null,
    aborted: false,
    subscribers: new Set(),
    controller,
  };
  jobs.set(matchId, job);

  const push = (event: StageEvent) => {
    job.events.push(event);
    // The pipeline now names the stage that died, so the browser can colour that row instead of
    // dumping a multi-KB stderr tail into a one-line status field.
    if (event.status === "error") job.errorStage = event.stage;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of job.subscribers) res.write(frame);
  };

  runPipeline(String(matchId), { onEvent: push, signal: controller.signal })
    .then(() => {
      job.done = true;
    })
    .catch((err: unknown) => {
      job.done = true;
      // Aborting rejects the same promise a real failure does, so without this check pressing
      // Stop reported "failed: The operation was aborted" and read as a crash.
      job.aborted = controller.signal.aborted;
      job.error = job.aborted ? null : describeError(err);
    })
    .finally(() => {
      for (const res of job.subscribers) {
        res.write(endFrame(job));
        res.end();
      }
      job.subscribers.clear();
    });

  return job;
}

function endFrame(job: Job): string {
  const payload = { error: job.error, stage: job.errorStage, aborted: job.aborted };
  return `event: end\ndata: ${JSON.stringify(payload)}\n\n`;
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
    res.write(endFrame(job));
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
      // The dashboard's CSS and JS are siblings of index.html rather than inlined, because that
      // file gains a section per feature and CLAUDE.md caps a file at 500 lines. Named
      // explicitly rather than serving public/ as a directory: an allowlist cannot be walked.
      if (url.pathname === "/app.css") {
        sendFile(res, path.join(ROOT, "public", "app.css"), "text/css; charset=utf-8");
        return;
      }
      if (url.pathname === "/app.js") {
        sendFile(res, path.join(ROOT, "public", "app.js"), "text/javascript; charset=utf-8");
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

    // Render a match that has no working directory yet. Without this the dashboard could only
    // re-run matches already on disk, so starting a new one meant being at the homelab with the
    // TUI open — the single biggest gap against the TUI it is meant to replace.
    if (resource === "render" && idRaw === undefined && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as { input?: unknown };
      if (typeof body.input !== "string" || body.input.trim() === "") {
        json(res, 400, { error: "expected { input: \"<match id or mcsrranked URL>\" }" });
        return;
      }
      // parseMatchId accepts a bare id or any URL ending in one, and throws with the offending
      // text; startJob's own id is re-derived from it so the digits-only path guard still holds.
      let parsed: number;
      try {
        parsed = parseMatchId(body.input.trim());
      } catch (err) {
        json(res, 400, { error: describeError(err) });
        return;
      }
      const job = startJob(parsed);
      json(res, 202, { matchId: parsed, running: !job.done });
      return;
    }

    if (resource === "suggestions" && idRaw === undefined && req.method === "GET") {
      json(res, 200, suggestionsPayload());
      return;
    }

    if (resource === "suggestions" && idRaw === "rescan" && req.method === "POST") {
      // Past the cache TTL the scan is the expensive part (dozens of feed pages against a
      // 500-per-10-minute budget), so this is deliberately manual, as `r` is in the TUI.
      void startScan(true);
      json(res, 202, suggestionsPayload());
      return;
    }

    if (resource === "suggestions" && req.method === "DELETE") {
      const dismissId = parseId(idRaw);
      if (dismissId === null) {
        json(res, 400, { error: "match id must be digits" });
        return;
      }
      dismiss(dismissId);
      json(res, 200, suggestionsPayload());
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
    json(res, 500, { error: describeError(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`mcsr-vid dashboard on http://0.0.0.0:${PORT}  (mediaDir: ${config.mediaDir})`);
  // Warm the suggestions in the background, as the TUI does on mount. A cold scan pages the
  // MCSR feed dozens of times, so waiting until someone asks means waiting a minute for an
  // answer; a fresh cache returns immediately and this costs nothing.
  void startScan();
});
