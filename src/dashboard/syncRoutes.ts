/**
 * The sync editor's routes: a frame out of either POV clip at a moment of the finished
 * timeline, the offsets as sync.json holds them, and the save that makes them manual. Its own
 * file, as the YouTube, export and Shorts groups are; server.ts keeps one dispatch chain.
 */
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { ANCHOR_SEC } from "../pipeline/kdenliveProject.js";
import { clipTimeFor, povClipExists, povClipPath, povFrame, validOffset } from "../pipeline/syncEdit.js";
import { exportStale, readSyncOffsets, staleExportMessage, writeSyncOffsets } from "../pipeline/syncFile.js";
import { findExportedVideo } from "../youtube/youtubeStore.js";
import { matchStatusFor } from "./matchStatus.js";

export interface SyncRouteContext {
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
  matchDir: (matchId: number) => string;
  parseId: (raw: string | undefined) => number | null;
}

/**
 * What the sync editor and the sync check read: the offsets, the clips, and whether the finished
 * export was made from them. `syncStale` is the mtime test `beginUpload` and the adopt route
 * refuse on (src/pipeline/syncFile.ts), so the page can disable the Upload button for the same reason the
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
    staleMessage: staleness?.stale ? staleExportMessage(matchId, staleness.staleMatchId) : null,
  };
}

/** Returns true when it handled the request; false for anything that is not `/api/sync/…`. */
export async function handleSyncRoute(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  ctx: SyncRouteContext,
): Promise<boolean> {
  const [, resource, idRaw] = segments;
  if (resource !== "sync") return false;
  const url = new URL(req.url ?? "/", "http://x");
  // --- Manual sync -------------------------------------------------------------------------
  // The detector reports a confidence and the dashboard already warns when it is low; this is
  // what the operator does about it. Both offsets are "seconds into that POV clip where match
  // start falls", the same numbers every consumer reads out of sync.json.
  if (idRaw === "frame" && req.method === "GET") {
    const matchId = ctx.parseId(url.searchParams.get("match") ?? undefined);
    if (matchId === null) {
      ctx.json(res, 400, { error: "match id must be digits" });
      return true;
    }
    const status = await matchStatusFor(matchId);
    const side = url.searchParams.get("side") === "right" ? "right" : "left";
    const nickname = side === "left" ? status.leftNickname : status.rightNickname;
    const offsets = readSyncOffsets(ctx.matchDir(matchId));
    const offset = Number(
      url.searchParams.get("offset") ?? (side === "left" ? offsets?.left : offsets?.right) ?? 0,
    );
    const timelineSec = Number(url.searchParams.get("t") ?? 5);
    if (!nickname || !Number.isFinite(offset) || !Number.isFinite(timelineSec)) {
      ctx.json(res, 400, { error: "expected ?match=<id>&side=left|right&t=<seconds>&offset=<seconds>" });
      return true;
    }
    const clip = povClipPath(ctx.matchDir(matchId), nickname);
    if (!existsSync(clip)) {
      ctx.json(res, 404, { error: `no POV clip for ${nickname} — the VODs are not on disk` });
      return true;
    }
    try {
      const jpeg = await povFrame(clip, clipTimeFor(offset, timelineSec));
      // No caching: the whole point is that the same URL answers differently once the operator
      // nudges the offset, and a 304 would show them the frame they are trying to move away from.
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
      res.end(jpeg);
    } catch (err) {
      ctx.json(res, 502, { error: describeError(err) });
    }
    return true;
  }

  if (req.method === "GET") {
    const matchId = ctx.parseId(idRaw);
    if (matchId === null) {
      ctx.json(res, 400, { error: "match id must be digits" });
      return true;
    }
    ctx.json(res, 200, await syncPayload(matchId));
    return true;
  }

  if (req.method === "PUT") {
    const matchId = ctx.parseId(idRaw);
    if (matchId === null) {
      ctx.json(res, 400, { error: "match id must be digits" });
      return true;
    }
    let body: { left?: unknown; right?: unknown };
    try {
      body = JSON.parse(await ctx.readBody(req)) as { left?: unknown; right?: unknown };
    } catch (err) {
      ctx.json(res, 400, { error: describeError(err) });
      return true;
    }
    const left = validOffset(body.left, "left offset");
    const right = validOffset(body.right, "right offset");
    if ("error" in left) {
      ctx.json(res, 400, { error: left.error });
      return true;
    }
    if ("error" in right) {
      ctx.json(res, 400, { error: right.error });
      return true;
    }
    const dir = ctx.matchDir(matchId);
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
    ctx.json(res, 200, await syncPayload(matchId));
    return true;
  }

  return false;
}
