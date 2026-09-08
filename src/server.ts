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
import { getMatch, getUser, getVersus, parseMatchId } from "./mcsrApi.js";
import {
  afterSettled,
  msUntilNextRun,
  nightlyCandidate,
  readNightlyState,
  requestExport,
  requestShort,
  runNightlyOnce,
  scheduleNightly,
} from "./nightly.js";
import { abortJob, getJob, startJob, streamProgress, type Job } from "./jobs.js";
import { STAGE_LABELS, STAGE_ORDER, STAGE_SHORT_LABELS } from "./pipeline.js";
import { presentSuggestions } from "./suggestPresent.js";
import { dismiss, restore, snapshot, startScan } from "./suggestScan.js";
import { nextPublishSlot } from "./publishSlot.js";
import { chooseVariant, readManifest, rerenderThumbnailVariants } from "./thumbnailVariants.js";
import { buildTitle, type BuiltTitle } from "./title.js";
import { allArchiveStates, capacity } from "./archive.js";
import { exportRunning, handleExportRoute } from "./exportRoutes.js";
import {
  MANUAL_PUBLISH_KEYS,
  deleteMatch,
  hiddenMatchIds,
  isArchived,
  isExported,
  isManualPublishKey,
  isUploaded,
  publishChecklist,
  setHidden,
  setPublishFlag,
} from "./matchShelf.js";
import { handleShortsRoute, shortRunning } from "./shortsRoutes.js";
import { handleYoutubeRoute, uploadRunning } from "./youtubeRoutes.js";
import { readUpload } from "./youtubeStore.js";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Same match page the generated description links to (src/description.ts). */
const MCSR_MATCH_URL = "https://mcsrranked.com/matches/";

/**
 * The page's own assets. An explicit allowlist rather than serving public/ as a directory,
 * because a listing can be walked and this cannot. There are several because both the
 * stylesheet and the script outgrew CLAUDE.md's 500-line cap.
 */
const STATIC_ASSETS: Record<string, { file: string; type: string }> = {
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/panels.css": { file: "panels.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/youtube.js": { file: "youtube.js", type: "text/javascript; charset=utf-8" },
  "/splits.js": { file: "splits.js", type: "text/javascript; charset=utf-8" },
  // The channel badge, downscaled to 64px so each cell of the 64-wide pixel grid in
  // `remotion/pixelBadge.ts` lands on exactly one pixel. Regenerate with:
  //   ffmpeg -i branding/logo.png -vf scale=64:64:flags=neighbor public/favicon.png
  "/favicon.png": { file: "favicon.png", type: "image/png" },
};

/** Thumbnail re-renders in flight, so a second POST cannot delete the files the first is writing. */
const thumbnailRerenders = new Set<number>();

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
  const tagsPath = path.join(matchDir(matchId), `match-${matchId}.tags.txt`);

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
    // The upload sends these verbatim; empty means the pipeline predates the file, and YouTube
    // then falls back to the Studio defaults that made all seven live videos share one tag set.
    tags: ((await readIfPresent(tagsPath)) ?? "")
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean),
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
 * Hook candidates for the title editor. Uncached, and four requests per metadata read: the match
 * (splits and deaths, which only the full record carries), both users (rank), and the versus
 * record (the rematch line). That is one operator opening one match, against a 500-per-10-minute
 * budget, so it is affordable; it would not be if this ran per row of the suggestions list.
 * A failure degrades to no suggestions rather than failing the whole metadata response, since
 * the title and description are still perfectly editable without them.
 */
async function readHookSuggestions(matchId: number, budget: BuiltTitle): Promise<string[]> {
  try {
    const match = await getMatch(matchId);
    const [left, right] = match.players;
    if (!left || !right) return [];
    const [userLeft, userRight, versus] = await Promise.all([
      getUser(left.uuid),
      getUser(right.uuid),
      // The head-to-head record, for the rematch opener. Its own catch: it is the one fact here
      // that only feeds a single chip, so losing it must not cost the other suggestions.
      getVersus(left.uuid, right.uuid).catch(() => undefined),
    ]);
    const input = {
      metrics: computeMetrics(match),
      match,
      userLeft,
      userRight,
      maxChars: budget.hookMax,
      minChars: budget.hookMin,
      versus,
    };
    const hooks = (await suggestHooksExternally(input)) ?? buildHookSuggestions(input);
    // The thumbnail already says something — lead with that. Rank chips read the live ladder,
    // which moved from "#9 vs #3" to "#9 vs #2" within hours of a render, and a title that
    // disagrees with its own thumbnail is the kind of thing viewers notice and cannot name.
    // "Re-render with hook" rewrites the manifest, so choosing differently is still one click.
    const committed = (await readManifest(matchDir(matchId)))?.hookText;
    return committed ? [committed, ...hooks.filter((h) => h !== committed)] : hooks;
  } catch (err) {
    console.error(`hook suggestions unavailable for ${matchId}: ${describeError(err)}`);
    return [];
  }
}

/**
 * `?short=1` / `?export=1` on either render route — the entry box's and the card's "Render +
 * Short + MP4": the same render, plus a note that nightly.ts's completion poll — the only
 * poller, and the nightly's own — should cut the Short and encode the MP4 when it settles.
 * Nothing about the render itself changes, and one poll serves both flags.
 */
function armFollowUps(job: Job, url: URL): void {
  const wantShort = url.searchParams.get("short") === "1";
  const wantExport = url.searchParams.get("export") === "1";
  if (wantShort) requestShort(job.matchId);
  if (wantExport) requestExport(job.matchId);
  if (wantShort || wantExport) afterSettled(job);
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
    // The single overlay.mov is gone (see CLAUDE.md, "What the render actually produces"); the
    // per-frame artifact is now the timer strip, and the split stills sit beside it.
    overlay: ifPresent(path.join(dir, "overlay-timer.mp4")) ?? ifPresent(path.join(dir, "overlay.mov")),
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
  // Ordering and wording are `presentSuggestions`; this only adds the link the page can't build.
  const suggestions = presentSuggestions(state.result?.suggestions ?? []).map((card) => ({
    ...card,
    matchUrl: `${MCSR_MATCH_URL}${card.matchId}`,
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
      const asset = STATIC_ASSETS[url.pathname];
      if (asset) {
        sendFile(res, path.join(ROOT, "public", asset.file), asset.type);
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

    // Same reason, same shape: the export round-trip (project down, cut project back, encode,
    // finished MP4 down) is its own group and this file is at the cap.
    if (await handleExportRoute(req, res, segments, { json, readBody, matchDir, parseId })) return;

    if (await handleShortsRoute(req, res, segments, { json, readBody, matchDir, parseId })) return;

    const [, resource, idRaw] = segments;

    if (resource === "stages" && req.method === "GET") {
      json(res, 200, { order: STAGE_ORDER, labels: STAGE_LABELS, short: STAGE_SHORT_LABELS });
      return;
    }

    // Both tiers, because archiving copies and never deletes: the NAS fills and the SSD does
    // not drain. Seeing only one of them is how you hit the ceiling by surprise.
    if (resource === "capacity" && req.method === "GET") {
      json(res, 200, { ...(await capacity()), archives: allArchiveStates() });
      return;
    }

    if (resource === "matches" && req.method === "GET") {
      const statuses = await listMatchStatuses();
      const hidden = hiddenMatchIds();
      // Newest first: match ids ascend with time, and the newest is what you just rendered.
      // `exported` and `uploaded` are what "ready to publish" means on the list: the morning
      // question is how many of these are waiting on a Studio session, not how many rendered.
      const rows = await Promise.all(
        statuses.map(async (m) => ({
          ...m,
          hidden: hidden.has(m.matchId),
          archived: isArchived(m.matchId),
          exported: isExported(m.matchId),
          uploaded: await isUploaded(m.matchId),
        })),
      );
      json(res, 200, { matches: rows.sort((a, b) => b.matchId - a.matchId) });
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
      armFollowUps(job, url);
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

    // The undo for the DELETE below. Answers with the list, like the dismiss it reverses, plus
    // whether the card is back now or only after the next scan (this process never saw it).
    if (resource === "suggestions" && segments[3] === "restore" && req.method === "POST") {
      const restoreId = parseId(idRaw);
      if (restoreId === null) {
        json(res, 400, { error: "match id must be digits" });
        return;
      }
      const now = restore(restoreId);
      json(res, 200, { ...suggestionsPayload(), restored: restoreId, now });
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

    // The scheduler's only window. It was a timer and a log line, both gone by morning, so the
    // operator could not see what it would pick or what it did. `candidate` runs the very same
    // `pickNightlyCandidate` the run does — a second implementation here would eventually
    // promise one match and render another — and deliberately never forces a scan.
    if (resource === "nightly" && idRaw === undefined && req.method === "GET") {
      const hourUtc = config.nightlyRenderHourUtc;
      const pick = await nightlyCandidate();
      json(res, 200, {
        enabled: hourUtc !== null,
        hourUtc,
        nextRunAt:
          hourUtc === null ? null : new Date(Date.now() + msUntilNextRun(Date.now(), hourUtc)).toISOString(),
        candidate: pick && {
          matchId: pick.metrics.matchId,
          players: pick.metrics.players,
          bucket: pick.bucket,
        },
        lastRun: readNightlyState(),
      });
      return;
    }

    // The nightly body on demand, guards and all: the chain has unit tests and a boot log line
    // but had never run end to end, and "wait until 03:00 UTC" is not a way to find out. The
    // schedule is untouched — this starts a render, not a timer.
    if (resource === "nightly" && idRaw === "run" && req.method === "POST") {
      const result = await runNightlyOnce(config.nightlyNotifyUrl);
      // A render already in flight is the one refusal that is a conflict rather than an answer,
      // and it is the same guard DELETE /api/match reports as 409.
      if (result.busy) json(res, 409, { error: result.skipped });
      else if (result.skipped) json(res, 200, { skipped: result.skipped });
      else json(res, 202, result);
      return;
    }

    const matchId = parseId(idRaw);
    if (matchId === null) {
      json(res, 400, { error: "match id must be digits" });
      return;
    }

    // Its own endpoint rather than part of /api/meta: this needs the *full* match (timelines),
    // which is a second API request, and the metadata editor must neither wait on it nor break
    // when the MCSR API is down.
    if (resource === "splits" && req.method === "GET") {
      try {
        const metrics = computeMetrics(await getMatch(matchId));
        json(res, 200, {
          matchId,
          players: metrics.players,
          splits: metrics.splits,
          leadChanges: metrics.leadChanges,
          resultMs: metrics.resultMs,
        });
      } catch (err) {
        json(res, 502, { error: describeError(err) });
      }
      return;
    }

    if (resource === "hidden" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req)) as { hidden?: unknown };
      if (typeof body.hidden !== "boolean") {
        json(res, 400, { error: "expected { hidden: true|false }" });
        return;
      }
      setHidden(matchId, body.hidden);
      json(res, 200, { matchId, hidden: body.hidden });
      return;
    }

    // Where a match has got to on the way out the door. Five of the eight answers are read off
    // disk on every request rather than recorded, so they cannot go stale; only the three that
    // happen elsewhere — in Studio, or in a DM to a player — are stored. See src/matchShelf.ts.
    if (resource === "publish" && req.method === "GET") {
      json(res, 200, await publishChecklist(matchId, (await matchStatusFor(matchId)).projectPath));
      return;
    }

    if (resource === "publish" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req)) as { key?: unknown; value?: unknown };
      if (!isManualPublishKey(body.key) || typeof body.value !== "boolean") {
        json(res, 400, {
          error: `expected { key: ${MANUAL_PUBLISH_KEYS.join("|")}, value: true|false }`,
        });
        return;
      }
      setPublishFlag(matchId, body.key, body.value);
      // Returns the merged object, not just the key it changed: the row repaints from one
      // answer, so a derived pill that flipped meanwhile lands in the same response.
      json(res, 200, await publishChecklist(matchId, (await matchStatusFor(matchId)).projectPath));
      return;
    }

    // The four facts the publish-kit panel needs that /api/meta has no reason to know: the
    // Short's own metadata, the video's public URL, and who to send the two DMs to. Uploading
    // stays manual while the API audit is pending, and the Related Video link and the player
    // DMs have no API at all, so what the operator actually needs is every paste in one place.
    // Its own route rather than more fields on readMeta: this reads two files and the upload
    // record that a title editor never looks at.
    if (resource === "publishkit" && req.method === "GET") {
      const entry = await matchStatusFor(matchId);
      const upload = await readUpload(matchId);
      const short = async (kind: string) =>
        ((await readIfPresent(path.join(matchDir(matchId), `short-${matchId}.${kind}.txt`))) ?? "").trim() ||
        null;
      json(res, 200, {
        shortTitle: await short("title"),
        shortDescription: await short("description"),
        videoUrl: upload ? `https://youtu.be/${upload.videoId}` : null,
        players: [entry.leftNickname ?? null, entry.rightNickname ?? null],
        // The slot to schedule for, so the morning's paste into Studio carries a time too.
        publishAt: nextPublishSlot(Date.now(), config.publishHourUtc).toISOString(),
        publishHourUtc: config.publishHourUtc,
      });
      return;
    }

    // Deleting a match's working directory is the one irreversible thing the dashboard can do,
    // so it refuses while anything is still writing into that directory, and reports whether an
    // archived copy survived it. See src/matchShelf.ts for why this exists at all.
    if (resource === "match" && req.method === "DELETE") {
      const busy =
        getJob(matchId)?.done === false
          ? "a pipeline run"
          : exportRunning(matchId)
            ? "an export"
            : shortRunning(matchId)
              ? "a Short render"
              : uploadRunning(matchId)
                ? "an upload"
                : null;
      if (busy) {
        json(res, 409, { error: `Match ${matchId} has ${busy} in flight — stop it first` });
        return;
      }
      try {
        json(res, 200, await deleteMatch(matchId));
      } catch (err) {
        json(res, 404, { error: describeError(err) });
      }
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

    // Re-render every variant behind a headline the operator has actually chosen. The pipeline
    // renders thumbnails long before anyone has watched the match, so the hook it used is only
    // ever its first suggestion, and this is how it gets replaced. 202 plus the existing GET is
    // the whole protocol: a re-render is a handful of stills, and the manifest's hookText is the
    // answer the poll is waiting for.
    if (resource === "thumbnails" && segments[3] === "rerender" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as { hookText?: unknown };
      const hookText = body.hookText;
      if (typeof hookText !== "string") {
        json(res, 400, { error: 'expected { hookText: "<headline>" }, empty string for none' });
        return;
      }
      if (thumbnailRerenders.has(matchId) || getJob(matchId)?.done === false) {
        json(res, 409, { error: `Match ${matchId} is already rendering thumbnails` });
        return;
      }
      thumbnailRerenders.add(matchId);
      // Not awaited: the render outlives the request, which is what the 202 is saying.
      void (async () => {
        try {
          const match = await getMatch(matchId);
          const [left, right] = match.players;
          if (!left || !right) throw new Error(`match ${matchId} does not have two players`);
          const [userLeft, userRight] = await Promise.all([getUser(left.uuid), getUser(right.uuid)]);
          await rerenderThumbnailVariants({
            match,
            userLeft,
            userRight,
            outDir: matchDir(matchId),
            poses: config.thumbnailVariants,
            hookText,
          });
        } catch (err) {
          console.error(`thumbnail re-render failed for ${matchId}: ${describeError(err)}`);
        } finally {
          thumbnailRerenders.delete(matchId);
        }
      })();
      json(res, 202, { matchId, hookText });
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
      armFollowUps(job, url);
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
        // The browser opens this stream for every match it shows, running or not. A 404 here
        // is correct but lands in the console as an error on every page load; 204 says the
        // same thing — nothing to stream — without the noise. EventSource treats any non-200
        // as "closed", which is exactly what the client handles.
        res.writeHead(204).end();
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
  // And then render one of them overnight, unattended. Waiting for a click is what caps output
  // at 7.24 videos a month: the render is cheap, the operator's attention is not.
  if (config.nightlyRenderHourUtc !== null) {
    scheduleNightly({
      hourUtc: config.nightlyRenderHourUtc,
      notifyUrl: config.nightlyNotifyUrl,
    });
  }
});
