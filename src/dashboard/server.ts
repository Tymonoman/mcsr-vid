/**
 * Dashboard for driving the pipeline from a browser instead of the TUI.
 *
 * Deliberately plain `node:http` with no framework and no new dependencies: every
 * useful operation already exists as an exported function, so this file is transport
 * and nothing else. Anything that looks like business logic here is a bug.
 *
 * Serves on 0.0.0.0 so the homelab's Tailscale interface publishes it too.
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  channelUploadsSnapshot,
  channelVideoFor,
  refreshChannelUploadsIfStale,
} from "../youtube/channelUploads.js";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { codeVersions } from "./repoHead.js";
import { computeMetrics } from "../pipeline/matchScore.js";
import { listMatchStatuses, matchStatusFor } from "./matchStatus.js";
import { getMatch, getUser, matchPageUrl, parseMatchId } from "../api/mcsrApi.js";
import {
  afterSettled,
  msUntilNextRun,
  nightlyCandidate,
  readNightlyState,
  requestExport,
  requestShort,
  runNightlyOnce,
  nightlyArmedAtMs,
  scheduleNightly,
} from "./nightly.js";
import { abortJob, getJob, startJob, streamProgress, type Job } from "./jobs.js";
import { STAGE_LABELS, STAGE_ORDER, STAGE_SHORT_LABELS } from "../pipeline/pipeline.js";
import { presentSuggestions } from "./suggestPresent.js";
import { dismiss, restore, snapshot, startScan } from "./suggestScan.js";
import { cronLine, rsyncPullAllCommand, rsyncPullCommand } from "./publishSet.js";
import { claimedPublishTimes, nextPublishSlot, publishHourFor } from "../youtube/publishSlot.js";
import { playoffBoard } from "../playoffs/playoffs.js";
import { renderSeries, seriesState, type SeriesRunners } from "../playoffs/series.js";
import { refreshRivalPostsIfStale, rivalPostsSnapshot, rivalRecentPostFor } from "./rivalPosts.js";
import { chooseVariant, readManifest, rerenderThumbnailVariants } from "../thumbnails/thumbnailVariants.js";
import { readSyncOffsets } from "../pipeline/syncFile.js";
import { metaPaths } from "../pipeline/title.js";
import { allArchiveStates, capacity, isArchived } from "./archive.js";
import { exportRunning, handleExportRoute, startFastExport } from "./exportRoutes.js";
import {
  MANUAL_PUBLISH_KEYS,
  deleteMatch,
  hiddenMatchIds,
  isExported,
  nightlyQueue,
  setNightlyQueue,
  isManualPublishKey,
  isUploaded,
  publishChecklist,
  setHidden,
  setPublishFlag,
} from "./matchShelf.js";
import {
  handleShortsRoute,
  lastShortPick,
  shortHookStale,
  shortRunning,
  spawnShortJob,
} from "./shortsRoutes.js";
import { saveSettings, settingsPayload } from "./settings.js";
import { handleYoutubeRoute, uploadRunning } from "./youtubeRoutes.js";
import { handleSyncRoute, syncPayload } from "./syncRoutes.js";
import { readIfPresent, readMeta } from "./matchMeta.js";
import { PINNED_COMMENT, readUpload } from "../youtube/youtubeStore.js";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * The page's own assets. An explicit allowlist rather than serving public/ as a directory,
 * because a listing can be walked and this cannot. There are several because the stylesheet
 * and the script are split by feature.
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
/** The last re-render failure per match, for the panel: a background render that dies would
    otherwise be a console line nobody sees and a button that quietly comes back. */
const thumbnailRerenderErrors = new Map<number, string>();

/** Match ids come from the URL, so they gate a path join and must be digits only. */
function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
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

/** How a series run drives the three steps inside the server (src/playoffs/series.ts `renderSeries`). */
const serverSeriesRunners: SeriesRunners = {
  renderGame: (matchId) =>
    new Promise((resolve) => {
      const job = startJob(matchId);
      const poll = () => (job.done ? resolve(job.aborted ? "stopped" : job.error) : setTimeout(poll, 5000));
      poll();
    }),
  exportGame: (matchId) => startFastExport(matchId).finished,
  cutShort: (matchId) =>
    new Promise((resolve) => {
      const proc = spawnShortJob(matchId, 0);
      proc.on("error", (err) => resolve(describeError(err)));
      proc.on("close", (code) => resolve(code === 0 ? null : `exit code ${code}`));
    }),
  log: (line) => console.error(line),
};

/**
 * `?short=1` / `?export=1` on either render route — the entry box's and the card's "Render +
 * Short + MP4": the same render, plus a note for `afterSettled` (nightly.ts) to chain the Short
 * and the MP4. Nothing about the render itself changes.
 */
function armFollowUps(job: Job, url: URL): void {
  const wantShort = url.searchParams.get("short") === "1";
  const wantExport = url.searchParams.get("export") === "1";
  if (wantShort) requestShort(job.matchId);
  if (wantExport) requestExport(job.matchId);
  if (wantShort || wantExport) afterSettled(job);
}

/**
 * A suggestion as the browser needs it: the numbers the TUI's row shows, plus the links it only
 * ever printed as plain text. The mcsrranked URL is built here rather than in the page so the
 * one already in every generated description (src/pipeline/description.ts) stays the single definition.
 */
function suggestionsPayload() {
  const state = snapshot();
  // Ordering and wording are `presentSuggestions`; this only adds the link the page can't build.
  const suggestions = presentSuggestions(
    state.result?.suggestions ?? [],
    Date.now(),
    rivalPostsSnapshot(),
  ).map((card) => ({
    ...card,
    matchUrl: matchPageUrl(card.matchId, card.players[0]),
  }));

  return {
    suggestions,
    rivalHandle: config.rivalChannelHandle || null,
    // For the rescan link's tooltip: how often new matches arrive on their own.
    ttlMin: config.suggestCacheTtlMin,
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

    // Delegated rather than inlined: the YouTube group is its own route file. It returns false
    // for anything it does not own.
    if (await handleYoutubeRoute(req, res, segments, { json, readBody, matchDir, parseId })) return;

    // Same shape: the export round-trip (project down, cut project back, encode, finished MP4
    // down) is its own group.
    if (await handleExportRoute(req, res, segments, { json, readBody, matchDir, parseId })) return;

    if (await handleShortsRoute(req, res, segments, { json, readBody, matchDir, parseId })) return;

    const [, resource, idRaw] = segments;

    // The sync editor — the frames, the offsets, the save — is its own group (syncRoutes.ts).
    if (await handleSyncRoute(req, res, segments, { json, readBody, matchDir, parseId })) return;

    if (resource === "settings" && req.method === "GET") {
      json(res, 200, { ...settingsPayload(), nightlyArmedAt: nightlyArmedAtMs() });
      return;
    }

    // The one route that writes mcsr-vid.config.json. `saveSettings` allowlists the keys and
    // validates the merged file with the loader's own rules, so this stays transport.
    if (resource === "settings" && req.method === "PUT") {
      let patch: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(await readBody(req));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("expected a JSON object of settings");
        }
        patch = parsed as Record<string, unknown>;
      } catch (err) {
        json(res, 400, { error: describeError(err) });
        return;
      }
      try {
        const saved = saveSettings(patch);
        // The nightly captured nothing, but its pending timer was armed for the old hour.
        if (saved.rearmNightly) scheduleNightly({ notifyUrl: config.nightlyNotifyUrl });
        if (saved.changed.length) console.error(`settings: changed ${saved.changed.join(", ")}`);
        json(res, 200, { ...saved, ...settingsPayload(), nightlyArmedAt: nightlyArmedAtMs() });
      } catch (err) {
        json(res, 400, { error: describeError(err) });
      }
      return;
    }

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
      // `uploaded` below reads the channel snapshot; this keeps it from going six hours stale
      // on a dashboard nobody opened the YouTube panel on.
      refreshChannelUploadsIfStale();
      const statuses = await listMatchStatuses();
      const hidden = hiddenMatchIds();
      // Newest first: match ids ascend with time, and the newest is what you just rendered.
      // `exported` and `uploaded` are what "ready to publish" means on the list: the morning
      // question is how many of these are waiting on a Studio session, not how many rendered.
      const rival = rivalPostsSnapshot();
      const now = Date.now();
      const rows = await Promise.all(
        statuses.map(async (m) => {
          // Same badge as the suggestion cards: of four finished videos, the ones the rival has
          // not covered go out first.
          const posted = rivalRecentPostFor(rival, [m.leftNickname, m.rightNickname], now);
          return {
            ...m,
            hidden: hidden.has(m.matchId),
            archived: isArchived(m.matchId),
            exported: isExported(m.matchId),
            uploaded: await isUploaded(m.matchId),
            rivalPosted: posted
              ? {
                  daysAgo: Math.max(0, Math.floor((now - posted.publishedAtMs) / 86_400_000)),
                  title: posted.title,
                }
              : null,
          };
        }),
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

    // The current bracket with its detected games, for the section above the suggestions. Cached
    // for suggestCacheTtlMin in src/playoffs/playoffs.ts; outside a tournament it is one cached read.
    // Each slot carries its series' state (src/playoffs/series.ts): which games are exported, whether the
    // joined video exists, the run in flight.
    if (resource === "playoffs" && idRaw === undefined && req.method === "GET") {
      const board = await playoffBoard();
      const slots = await Promise.all(
        board.slots.map(async (slot) => ({ ...slot, series: await seriesState(slot) })),
      );
      json(res, 200, { ...board, slots });
      return;
    }

    // Render a whole playoff series — every game not yet exported, one after another, then the
    // join and the Short — from any of its games' ids. The same three runners the dashboard's
    // own buttons use: the pipeline job (progress on the list as usual), export:fast, the Short.
    if (resource === "series" && idRaw !== undefined && segments[3] === "render" && req.method === "POST") {
      const matchId = Number(idRaw);
      if (!Number.isInteger(matchId)) {
        json(res, 400, { error: "expected a match id" });
        return;
      }
      void renderSeries(matchId, serverSeriesRunners).catch((err: unknown) =>
        console.error(`series ${matchId}: ${describeError(err)}`),
      );
      json(res, 202, { matchId });
      return;
    }

    if (resource === "suggestions" && idRaw === undefined && req.method === "GET") {
      // Fire-and-forget: the first request after boot answers without the rival badges and the
      // next has them; a failure is a log line, never a 500 on the suggestions page.
      refreshRivalPostsIfStale();
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

    // The scheduler's only window: what it will pick tonight and what the last run did.
    // `candidate` runs the very same `pickNightlyCandidate` the run does — a second
    // implementation would eventually promise one match and render another — and never
    // forces a scan.
    if (resource === "nightly" && idRaw === undefined && req.method === "GET") {
      const hourUtc = config.nightlyRenderHourUtc;
      const pick = await nightlyCandidate();
      json(res, 200, {
        // Boot commit vs checked-out commit: the strip says "restart" when they differ.
        code: codeVersions(),
        enabled: hourUtc !== null,
        hourUtc,
        nextRunAt:
          hourUtc === null ? null : new Date(Date.now() + msUntilNextRun(Date.now(), hourUtc)).toISOString(),
        candidate: pick && {
          matchId: pick.metrics.matchId,
          players: pick.metrics.players,
          bucket: pick.bucket,
        },
        // In the operator's order; `players` is null for an entry no longer on the list.
        queue: nightlyQueue().map((matchId) => ({
          matchId,
          players: suggestionsPayload().suggestions.find((c) => c.matchId === matchId)?.players ?? null,
        })),
        lastRun: readNightlyState(),
      });
      return;
    }

    // The whole queue in one write: the panel sends the list it shows after every move.
    if (resource === "nightly" && idRaw === "queue" && req.method === "PUT") {
      let queue: unknown;
      try {
        queue = (JSON.parse(await readBody(req)) as { queue?: unknown }).queue;
      } catch (err) {
        json(res, 400, { error: describeError(err) });
        return;
      }
      if (!Array.isArray(queue) || !queue.every((n) => Number.isSafeInteger(n) && n > 0)) {
        json(res, 400, { error: "queue must be a list of match ids" });
        return;
      }
      setNightlyQueue(queue as number[]);
      json(res, 200, { queue: nightlyQueue() });
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
    // happen elsewhere — in Studio, or in a DM to a player — are stored. See src/dashboard/matchShelf.ts.
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
    // was manual while the API audit was pending, and the Related Video link and the player
    // DMs have no API at all, so what the operator actually needs is every paste in one place.
    // Its own route rather than more fields on readMeta: this reads two files and the upload
    // record that a title editor never looks at.
    if (resource === "publishkit" && req.method === "GET") {
      const entry = await matchStatusFor(matchId);
      // The dashboard's own record, else the video the channel says is this match — the DM is
      // useless without the link, and while uploads go through Studio the record never exists.
      const videoId =
        (await readUpload(matchId))?.videoId ??
        channelVideoFor(matchId, channelUploadsSnapshot())?.videoId ??
        null;
      const short = async (kind: string) =>
        ((await readIfPresent(path.join(matchDir(matchId), `short-${matchId}.${kind}.txt`))) ?? "").trim() ||
        null;
      json(res, 200, {
        shortTitle: await short("title"),
        shortDescription: await short("description"),
        videoUrl: videoId ? `https://youtu.be/${videoId}` : null,
        players: [entry.leftNickname ?? null, entry.rightNickname ?? null],
        // The same line "Finish on YouTube" posts (src/youtube/youtubeUpload.ts), so the paste and the
        // API call cannot say two different things.
        pinnedComment: PINNED_COMMENT,
        // The slot to schedule for, so the morning's paste into Studio carries a time too —
        // and the first free one, not the same time every match ready this morning would show.
        publishAt: nextPublishSlot(
          Date.now(),
          publishHourFor(matchDir(matchId)),
          await claimedPublishTimes(matchId),
        ).toISOString(),
        publishHourUtc: publishHourFor(matchDir(matchId)),
        // Commands for the operator's own shell, not this one: the publishing PC pulls.
        pull: config.pullSource
          ? {
              one: rsyncPullCommand(config.pullSource, config.pullDest, matchId),
              all: rsyncPullAllCommand(config.pullSource, config.pullDest),
              cron: cronLine(config.pullSource, config.pullDest),
            }
          : null,
      });
      return;
    }

    // Deleting a match's working directory is the one irreversible thing the dashboard can do,
    // so it refuses while anything is still writing into that directory, and reports whether an
    // archived copy survived it. See src/dashboard/matchShelf.ts for why this exists at all.
    if (resource === "match" && req.method === "DELETE") {
      const busy =
        getJob(matchId)?.done === false
          ? "a pipeline run"
          : exportRunning(matchId)
            ? "an export"
            : shortRunning(matchId)
              ? "a Short render"
              : thumbnailRerenders.has(matchId)
                ? "a thumbnail re-render"
                : uploadRunning(matchId)
                  ? "an upload"
                  : allArchiveStates().some((a) => a.matchId === matchId && a.running)
                    ? "an archive copy"
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
      json(res, 200, {
        ...((await readManifest(matchDir(matchId))) ?? { chosen: null, hookText: null, variants: [] }),
        rerender: {
          running: thumbnailRerenders.has(matchId),
          error: thumbnailRerenderErrors.get(matchId) ?? null,
        },
      });
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
      thumbnailRerenderErrors.delete(matchId);
      // A Short already cut with the old headline is the other half of this decision, and the
      // operator had to notice the panel's warning and click "re-cut it" by hand. Decided before
      // the render because it is a fact about what is on disk now, and reported in the 202 so the
      // answer to "what did this start?" is one response.
      const recutShort = await shortHookStale(matchDir(matchId), matchId, hookText);
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
          // Only after the manifest is written: the Short resolves its hook from it, so cutting
          // any earlier would burn in the headline this render just replaced.
          // The moment the last cut used, not the top-ranked one: a re-cut exists to change the
          // headline, and resetting the window would throw away a row the operator chose. This
          // process's own job map first, then the sidecar `generateShort` leaves on disk — which
          // is what answers after a restart, when the map is empty but the Short is not.
          // Repeat the window, not the row: the ranking is not stable across a scorer change or
          // a reasoner answer, so an index can silently mean a different 22 seconds tomorrow.
          // The sidecar records the window the last cut used; the in-process pick is the
          // fallback for a Short cut before the sidecar existed.
          if (recutShort) {
            const last = lastCutWindow(matchId);
            if (last !== null) spawnShortJob(matchId, 0, last);
            else spawnShortJob(matchId, lastShortPick(matchId) ?? 0);
          }
        } catch (err) {
          thumbnailRerenderErrors.set(matchId, describeError(err));
          console.error(`thumbnail re-render failed for ${matchId}: ${describeError(err)}`);
        } finally {
          thumbnailRerenders.delete(matchId);
        }
      })();
      json(res, 202, { matchId, hookText, shortRecut: recutShort });
      return;
    }

    if (resource === "meta" && req.method === "GET") {
      json(res, 200, await readMeta(matchId));
      return;
    }

    if (resource === "meta" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req)) as { title?: string; description?: string };
      // An empty box saved is "back to the generated text", not an empty title: the edit file
      // goes, rather than winning as nothing (two 0-byte edits from 19 Sept blanked a kit).
      const save = async (kind: "title" | "description", text: string) => {
        const file = metaPaths(matchId, kind).edited;
        if (text.trim() === "") await rm(file, { force: true });
        else await writeFile(file, text, "utf8");
      };
      if (typeof body.title === "string") await save("title", body.title);
      if (typeof body.description === "string") await save("description", body.description);
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
  // And keep it current: an unforced scan is the cache while fresh and only the new matches
  // once stale, so the evening list and the nightly's pick are never older than the TTL.
  setInterval(() => void startScan(false), config.suggestCacheTtlMin * 60_000).unref();
  refreshRivalPostsIfStale();
  refreshChannelUploadsIfStale();
  // And then render one of them overnight, unattended. Waiting for a click is what caps output
  // at 7.24 videos a month: the render is cheap, the operator's attention is not.
  // Unconditional: scheduleNightly reads the hour from config itself and arms nothing when it is
  // null, so the settings panel can switch the nightly on later without a restart.
  scheduleNightly({ notifyUrl: config.nightlyNotifyUrl });
});

/**
 * Where the Short's last render started, from the sidecar `generateShort` writes beside it.
 * Null when there is none — a Short cut before the sidecar existed, or none at all.
 */
function lastCutWindow(matchId: number): number | null {
  const file = path.join(matchDir(matchId), `short-${matchId}.cut.json`);
  if (!existsSync(file)) return null;
  try {
    const startMs = (JSON.parse(readFileSync(file, "utf8")) as { startMs?: unknown }).startMs;
    return typeof startMs === "number" && Number.isFinite(startMs) && startMs >= 0 ? startMs : null;
  } catch {
    // A torn sidecar means "cut the best one", which is what it did before this existed.
    return null;
  }
}
