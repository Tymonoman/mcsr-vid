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
import { buildHookSuggestions, suggestHooksExternally } from "./hooks.js";
import { computeMetrics } from "./matchScore.js";
import { listMatchStatuses, matchStatusFor } from "./matchStatus.js";
import { getMatch, getUser, parseMatchId } from "./mcsrApi.js";
import { abortJob, getJob, startJob, streamProgress } from "./jobs.js";
import { STAGE_LABELS, STAGE_ORDER } from "./pipeline.js";
import { dismiss, snapshot, startScan } from "./suggestScan.js";
import { chooseVariant, readManifest } from "./thumbnailVariants.js";
import { buildTitle, type BuiltTitle } from "./title.js";
import { handleYoutubeRoute } from "./youtubeRoutes.js";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Same match page the generated description links to (src/description.ts). */
const MCSR_MATCH_URL = "https://mcsrranked.com/matches/";

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
  const budget = buildTitle({
    leftNickname: entry.leftNickname,
    rightNickname: entry.rightNickname,
  });
  const hookSuggestions = await readHookSuggestions(matchId, budget);

  return {
    matchId,
    leftNickname: entry?.leftNickname ?? null,
    rightNickname: entry?.rightNickname ?? null,
    title: (await readIfPresent(title.edited)) ?? (await readIfPresent(title.generated)),
    titleEdited: existsSync(title.edited),
    description: (await readIfPresent(description.edited)) ?? (await readIfPresent(description.generated)),
    descriptionEdited: existsSync(description.edited),
    chapters: await readIfPresent(chaptersPath),
    hook: {
      generated: budget.generated,
      placeholder: budget.title,
      min: budget.hookMin,
      max: budget.hookMax,
      /** Ranked openers built from the match's own numbers; empty when the match is unreadable. */
      suggestions: hookSuggestions,
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

/**
 * Hook candidates for the title editor. Costs one more MCSR request than the metadata read
 * alone, because the openers are built from splits and deaths that only the full match carries;
 * a failure degrades to no suggestions rather than failing the whole metadata response, since
 * the title and description are still perfectly editable without them.
 */
async function readHookSuggestions(matchId: number, budget: BuiltTitle): Promise<string[]> {
  try {
    const match = await getMatch(matchId);
    const [left, right] = match.players;
    if (!left || !right) return [];
    const [userLeft, userRight] = await Promise.all([getUser(left.uuid), getUser(right.uuid)]);
    const input = {
      metrics: computeMetrics(match),
      match,
      userLeft,
      userRight,
      maxChars: budget.hookMax,
      minChars: budget.hookMin,
    };
    return (await suggestHooksExternally(input)) ?? buildHookSuggestions(input);
  } catch (err) {
    console.error(`hook suggestions unavailable for ${matchId}: ${describeError(err)}`);
    return [];
  }
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

    // Delegated rather than inlined: server.ts was already at the 500-line cap, and the YouTube
    // group is the largest single addition. It returns false for anything it does not own.
    if (await handleYoutubeRoute(req, res, segments, { json, readBody, matchDir, parseId })) return;

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
        json(res, 400, { error: 'expected { input: "<match id or mcsrranked URL>" }' });
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
      // `?v=<key>` serves one variant. The key indexes the manifest rather than being joined
      // into a path, so it cannot walk out of the match directory.
      const key = url.searchParams.get("v");
      if (key === null) {
        sendFile(res, path.join(matchDir(matchId), "thumbnail.png"), "image/png");
        return;
      }
      const manifest = await readManifest(matchDir(matchId));
      const variant = manifest?.variants.find((v) => v.key === key);
      if (!variant) {
        json(res, 404, { error: `no thumbnail variant "${key}" for match ${matchId}` });
        return;
      }
      sendFile(res, path.join(matchDir(matchId), variant.file), "image/png");
      return;
    }

    if (resource === "thumbnails" && req.method === "GET") {
      json(res, 200, (await readManifest(matchDir(matchId))) ?? { chosen: null, variants: [] });
      return;
    }

    // Promote a variant to thumbnail.png, which is the file that actually gets uploaded.
    if (resource === "thumbnails" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req)) as { chosen?: unknown };
      if (typeof body.chosen !== "string") {
        json(res, 400, { error: 'expected { chosen: "<variant key>" }' });
        return;
      }
      try {
        json(res, 200, await chooseVariant(matchDir(matchId), body.chosen));
      } catch (err) {
        json(res, 400, { error: describeError(err) });
      }
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
      abortJob(matchId);
      json(res, 200, { matchId, aborted: true });
      return;
    }

    if (resource === "progress" && req.method === "GET") {
      const job = getJob(matchId);
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
