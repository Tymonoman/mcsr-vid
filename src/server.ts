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
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { channelUploadsSnapshot, channelVideoFor, refreshChannelUploadsIfStale } from "./channelUploads.js";
import { config, matchDir } from "./config.js";
import { describeError } from "./errorText.js";
import { codeVersions } from "./repoHead.js";
import { hookSuggestions } from "./hooks.js";
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
  nightlyArmedAtMs,
  scheduleNightly,
} from "./nightly.js";
import { abortJob, getJob, startJob, streamProgress, type Job } from "./jobs.js";
import { STAGE_LABELS, STAGE_ORDER, STAGE_SHORT_LABELS } from "./pipeline.js";
import { presentSuggestions } from "./suggestPresent.js";
import { dismiss, restore, snapshot, startScan } from "./suggestScan.js";
import { cronLine, rsyncPullAllCommand, rsyncPullCommand } from "./publishSet.js";
import { claimedPublishTimes, nextPublishSlot } from "./publishSlot.js";
import { playoffBoard, playoffContextForId, playoffTitleTail } from "./playoffs.js";
import { refreshRivalPostsIfStale, rivalPostsSnapshot, rivalRecentPostFor } from "./rivalPosts.js";
import { chooseVariant, readManifest, rerenderThumbnailVariants } from "./thumbnailVariants.js";
import { ANCHOR_SEC } from "./kdenliveProject.js";
import { exportStale, readSyncOffsets, staleExportMessage, writeSyncOffsets } from "./syncFile.js";
import { clipTimeFor, povClipExists, povClipPath, povFrame, validOffset } from "./syncEdit.js";
import { buildTitle, metaPaths, type BuiltTitle } from "./title.js";
import { allArchiveStates, capacity, isArchived } from "./archive.js";
import { exportRunning, handleExportRoute } from "./exportRoutes.js";
import {
  MANUAL_PUBLISH_KEYS,
  deleteMatch,
  hiddenMatchIds,
  isExported,
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
import { findExportedVideo, pinnedCommentText, readUpload } from "./youtubeStore.js";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Same match page the generated description links to (src/description.ts). */
const MCSR_MATCH_URL = "https://mcsrranked.com/matches/";

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

async function readIfPresent(filePath: string): Promise<string | null> {
  return existsSync(filePath) ? readFile(filePath, "utf8") : null;
}

async function readMeta(matchId: number) {
  // One API request; the list variant costs one per match directory.
  const entry = await matchStatusFor(matchId);

  const title = metaPaths(matchId, "title");
  const description = metaPaths(matchId, "description");
  const chaptersPath = path.join(matchDir(matchId), `match-${matchId}.chapters.txt`);
  const tagsPath = path.join(matchDir(matchId), `match-${matchId}.tags.txt`);

  // The hook is the one part a human writes (src/title.ts:5). buildTitle also returns the
  // character budget that keeps the title in the 70-100 band while leaving both nicknames
  // above YouTube's ~50-char mobile cutoff, which is what the editor counts against. The same
  // tail the pipeline wrote, playoff or ranked: a playoff tail is a third longer, so building the
  // budget on "MCSR Ranked 1v1" would bless a hook ~18 characters too long and preview a title
  // that is not the one on disk.
  const playoff = await playoffContextForId(matchId);
  const budget = buildTitle({
    leftNickname: entry.leftNickname,
    rightNickname: entry.rightNickname,
    ...(playoff ? { suffix: playoffTitleTail(playoff) } : {}),
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
    // Where the two POVs actually got placed. Both exporters read this file, nothing showed it,
    // and a half-synced match looks exactly like a clean one on the page: when the countdown
    // detector finds one player's freeze and not the other's, the found side is corrected and
    // the other keeps the coarse estimate, so the two POVs can sit seconds apart in a video that
    // is otherwise ready to publish. Null for a match rendered before sync.json existed —
    // `npm run sync-status` derives one from the project.
    sync: readSyncOffsets(matchDir(matchId)),
    syncThreshold: config.syncConfidenceThreshold,
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
 * What the sync editor and the sync check read: the offsets, the clips, and whether the finished
 * export was made from them. `syncStale` is the mtime test `beginUpload` and the adopt route
 * refuse on (src/syncFile.ts), so the page can disable the Upload button for the same reason the
 * server would give; `exported` is what puts the sync check on the page at all. One shape for
 * the GET and the PUT — saving offsets is exactly what makes an export stale.
 */
async function syncPayload(matchId: number) {
  const status = await matchStatusFor(matchId);
  const dir = matchDir(matchId);
  const located = findExportedVideo(matchId, [status.leftNickname, status.rightNickname]);
  const staleness = "error" in located ? null : exportStale(dir, located.path);
  return {
    matchId,
    sync: readSyncOffsets(dir),
    /** Where the editor starts when nothing has synced this match yet. */
    fallback: config.preRollSec,
    anchorSec: ANCHOR_SEC,
    threshold: config.syncConfidenceThreshold,
    left: { nickname: status.leftNickname, clip: povClipExists(dir, status.leftNickname ?? "") },
    right: { nickname: status.rightNickname, clip: povClipExists(dir, status.rightNickname ?? "") },
    exported: staleness !== null,
    syncStale: staleness?.stale ?? false,
    staleMessage: staleness?.stale ? staleExportMessage(matchId) : null,
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
    const hooks = await hookSuggestions(input);
    // Rank chips read live rank and drift within hours; the thumbnail's committed line wins so
    // both halves of a match agree. "Re-render with hook" rewrites the manifest, so choosing
    // differently is still one click.
    const committed = (await readManifest(matchDir(matchId)))?.hookText;
    return committed ? [committed, ...hooks.filter((h) => h !== committed)] : hooks;
  } catch (err) {
    console.error(`hook suggestions unavailable for ${matchId}: ${describeError(err)}`);
    return [];
  }
}

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
  const suggestions = presentSuggestions(
    state.result?.suggestions ?? [],
    Date.now(),
    rivalPostsSnapshot(),
  ).map((card) => ({
    ...card,
    matchUrl: `${MCSR_MATCH_URL}${card.matchId}`,
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

    // --- Manual sync -------------------------------------------------------------------------
    // The detector reports a confidence and the dashboard already warns when it is low; this is
    // what the operator does about it. Both offsets are "seconds into that POV clip where match
    // start falls", the same numbers every consumer reads out of sync.json.
    if (resource === "sync" && idRaw === "frame" && req.method === "GET") {
      const matchId = parseId(url.searchParams.get("match") ?? undefined);
      if (matchId === null) {
        json(res, 400, { error: "match id must be digits" });
        return;
      }
      const status = await matchStatusFor(matchId);
      const side = url.searchParams.get("side") === "right" ? "right" : "left";
      const nickname = side === "left" ? status.leftNickname : status.rightNickname;
      const offsets = readSyncOffsets(matchDir(matchId));
      const offset = Number(
        url.searchParams.get("offset") ?? (side === "left" ? offsets?.left : offsets?.right) ?? 0,
      );
      const timelineSec = Number(url.searchParams.get("t") ?? 5);
      if (!nickname || !Number.isFinite(offset) || !Number.isFinite(timelineSec)) {
        json(res, 400, { error: "expected ?match=<id>&side=left|right&t=<seconds>&offset=<seconds>" });
        return;
      }
      const clip = povClipPath(matchDir(matchId), nickname);
      if (!existsSync(clip)) {
        json(res, 404, { error: `no POV clip for ${nickname} — the VODs are not on disk` });
        return;
      }
      try {
        const jpeg = await povFrame(clip, clipTimeFor(offset, timelineSec));
        // No caching: the whole point is that the same URL answers differently once the operator
        // nudges the offset, and a 304 would show them the frame they are trying to move away from.
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
        res.end(jpeg);
      } catch (err) {
        json(res, 502, { error: describeError(err) });
      }
      return;
    }

    if (resource === "sync" && req.method === "GET") {
      const matchId = parseId(idRaw);
      if (matchId === null) {
        json(res, 400, { error: "match id must be digits" });
        return;
      }
      json(res, 200, await syncPayload(matchId));
      return;
    }

    if (resource === "sync" && req.method === "PUT") {
      const matchId = parseId(idRaw);
      if (matchId === null) {
        json(res, 400, { error: "match id must be digits" });
        return;
      }
      let body: { left?: unknown; right?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as { left?: unknown; right?: unknown };
      } catch (err) {
        json(res, 400, { error: describeError(err) });
        return;
      }
      const left = validOffset(body.left, "left offset");
      const right = validOffset(body.right, "right offset");
      if ("error" in left) {
        json(res, 400, { error: left.error });
        return;
      }
      if ("error" in right) {
        json(res, 400, { error: right.error });
        return;
      }
      const dir = matchDir(matchId);
      const previous = readSyncOffsets(dir);
      // Confidence 1: a human read the two countdowns, which is the measurement the detector was
      // trying to approximate. The warning line keys off this, so leaving it low would keep
      // telling them to verify an alignment they just verified.
      writeSyncOffsets(dir, {
        left: left.value,
        right: right.value,
        confidence: 1,
        detail: `set in the dashboard, replacing ${previous?.source ?? "nothing"}`,
        source: "manual",
      });
      console.error(`sync: match ${matchId} set by hand to ${left.value}s / ${right.value}s`);
      // The same shape as the GET: the save is what makes the export stale, and the page repaints
      // its sync check and the Upload button from this answer.
      json(res, 200, await syncPayload(matchId));
      return;
    }

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
    // for suggestCacheTtlMin in src/playoffs.ts; outside a tournament it is one cached read.
    if (resource === "playoffs" && idRaw === undefined && req.method === "GET") {
      json(res, 200, await playoffBoard());
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
        // The same line "Finish on YouTube" posts (src/youtubeUpload.ts), so the paste and the
        // API call cannot say two different things.
        pinnedComment: pinnedCommentText(entry.leftNickname ?? null, entry.rightNickname ?? null),
        // The slot to schedule for, so the morning's paste into Studio carries a time too —
        // and the first free one, not the same time every match ready this morning would show.
        publishAt: nextPublishSlot(
          Date.now(),
          config.publishHourUtc,
          await claimedPublishTimes(matchId),
        ).toISOString(),
        publishHourUtc: config.publishHourUtc,
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
    // archived copy survived it. See src/matchShelf.ts for why this exists at all.
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
