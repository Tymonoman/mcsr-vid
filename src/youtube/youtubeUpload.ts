/**
 * What an upload does, from the files on disk to the finished video on the channel.
 *
 * Shared by the route (src/dashboard/youtubeRoutes.ts), the Short chain (src/dashboard/shortFlow.ts) and the channel scan
 * (src/youtube/channelUploads.ts, for a Studio upload it pairs), so the three cannot drift on what gets
 * refused, what gets sent, or what happens after the insert. Nothing here calls `videos.insert`
 * while `youtubeUploadEnabled` is off — see src/config.ts and CLAUDE.md.
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { archiveMatch } from "../dashboard/archive.js";
import type { ChannelVideo } from "./channelUploads.js";
import { blockedIn, config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { getMatch } from "../api/mcsrApi.js";
import { blockedOnDisk, listProcessedMatchIds, matchStatusFor } from "../dashboard/matchStatus.js";
import { dnfRefusal, matchIsDnf, playoffContextForId } from "../playoffs/playoffs.js";
import { exportStale, staleExportMessage } from "../pipeline/syncFile.js";
import { readManifest } from "../thumbnails/thumbnailVariants.js";
import { thumbnailRunning } from "../thumbnails/rerender.js";
import { pinnedQuestion } from "../pipeline/pinnedQuestion.js";
import { HOOK_PLACEHOLDER, metaPaths, titleName } from "../pipeline/title.js";
import { RIVALRY_PLAYLIST_LINE, withRivalry } from "../pipeline/description.js";
import { readHandShort, WAITING_FOR_HAND_SHORT } from "../shorts/handShort.js";
import { readShortCut, readShortHook, WAITING_FOR_HOOK } from "../shorts/shortHook.js";
import { activityProgress, boxFailure, endActivity, shortLog, startActivity } from "../shorts/shortLog.js";
import { pinComment } from "./studioActions.js";
import {
  isRunning as studioBrowserRunning,
  probe as probeStudio,
  start as startStudioBrowser,
} from "./studioBrowser.js";
import {
  addTags,
  addToPlaylist,
  matchupPlaylistDescription,
  matchupPlaylistTitle,
  playerPlaylistDescription,
  playerPlaylistTitle,
  playoffPlaylistDescription,
  playoffPlaylistTitle,
  commentThreads,
  findOrCreatePlaylist,
  findPlaylistId,
  isConfigured,
  playlistUrl,
  postComment,
  SEASON_PLAYLIST_DESCRIPTION,
  resumableSession,
  sessionPath,
  setThumbnail,
  uploadVideo,
  type UploadResult,
  videoStats,
} from "./youtube.js";
import {
  findExportedVideo,
  lastMeetingFor,
  pinnedComment,
  splitTitle,
  allUploads,
  longFormRecord,
  onVideo,
  readUpload,
  uploadTextFor,
  writeUpload,
  type FinishedSteps,
  type UploadKind,
  type UploadRecord,
} from "./youtubeStore.js";

/** An upload in flight, so the browser can show a byte-level bar on a multi-GB file. */
export interface UploadProgress {
  matchId: number;
  kind: UploadKind;
  uploaded: number;
  total: number;
  done: boolean;
  /** The upload itself failed; the video is not up. */
  error: string | null;
  /** The video is up, but a step after the insert was not: thumbnail, a playlist, the comment. */
  warnings: string[];
  videoId: string | null;
}

/** The long-form and the Short of one match are two uploads, tracked apart (the chain runs them back to back). */
const uploads = new Map<string, UploadProgress>();
const progressKey = (matchId: number, kind: UploadKind) => `${kind}:${matchId}`;

/** An upload reading this match's export or Short right now. */
export const uploadRunning = (matchId: number): boolean =>
  [...uploads.values()].some((u) => u.matchId === matchId && !u.done);

/** Any upload in flight, whichever match or kind — restartWhenIdle.ts's gate. */
export const anyUploadRunning = (): boolean => [...uploads.values()].some((u) => !u.done);

const idle = (matchId: number, kind: UploadKind): UploadProgress => ({
  matchId,
  kind,
  uploaded: 0,
  total: 0,
  done: false,
  error: null,
  warnings: [],
  videoId: null,
});

/** The gate on `videos.insert`. See `youtubeUploadEnabled` in src/config.ts. */
const UPLOADS_OFF = "uploads are switched off (youtubeUploadEnabled) — this one goes through Studio";

/** What the browser polls; an idle answer for a match nothing has started on. */
export const uploadProgress = (matchId: number, kind: UploadKind): UploadProgress =>
  uploads.get(progressKey(matchId, kind)) ?? idle(matchId, kind);

export interface UploadRequest {
  kind: UploadKind;
  privacyStatus: "private" | "unlisted" | "public";
  /** RFC 3339, already validated as a future time. */
  publishAt?: string;
  /** Escape hatch for a hand-named export; must sit inside the match directory. */
  videoPath?: string;
}

type Begun =
  { status: number; error: string } | { progress: UploadProgress; finished: Promise<UploadProgress> };

/**
 * Whether this match's own files (`blockedOnDisk`, src/dashboard/matchStatus.ts: POV clips, chats, title) name a
 * blocked player (config.blockedPlayers) — disk only, no network: the clips are on disk by the
 * time anything is ever uploaded, and this must never be slower or less available than the
 * upload it gates. The same reader `matchStatusFor` uses, so a generated MP4
 * (`overlay-timer.mp4`, `final-<id>.mp4`, …) is never mistaken for a player.
 */
function hasBlockedPlayer(dir: string): boolean {
  // The chats and the title too (`blockedOnDisk`): finishOnYouTube's retry ticks reach matches
  // whose clips are already archived.
  return blockedOnDisk(dir);
}

/** Why a blocked match's still-pending finish steps are left undone — `finishOnYouTube`'s own note. */
const BLOCKED_FINISH = "a blocked player — no YouTube writes are made for this match";

/**
 * Nothing goes up before the operator has saved the hooks (23 Sept 2026). The long-form needs a
 * saved title hook — the edited title, not the generated one the pipeline fills with its first
 * chip; the Short needs its confirmed hook, burned into the file being sent (the cut records
 * which), and goes up once: a second Short of one match is a duplicate only Studio removes.
 */
export async function hookRefusal(
  matchId: number,
  kind: UploadKind,
): Promise<{ status: number; error: string } | null> {
  const dir = matchDir(matchId);
  // Checked before anything else, hook state included: a blocked player's match is refused
  // outright, long-form or Short (config.blockedPlayers — the operator, 2 Oct 2026: "blacklist him").
  if (hasBlockedPlayer(dir))
    return { status: 403, error: `match ${matchId} has a blocked player — uploads of it are refused` };
  if (kind === "video") {
    // Once, like the Short: on 24 Sept a press of Upload 3 minutes after the chain's own upload
    // put the same long-form on the channel twice (spIyAaQmZr8 / hMA09SfxwxE), both scheduled.
    // A Studio upload the channel scan paired has this record too.
    if (existsSync(path.join(dir, "youtube.json")))
      return { status: 409, error: `the long-form of match ${matchId} is already on the channel` };
    const edited = await readFile(metaPaths(matchId, "title").edited, "utf8").catch(() => "");
    const line = edited.split("\n")[0]!.trim();
    if (line === "") return { status: 409, error: "no saved title hook — save the hooks first" };
    if (line.includes(HOOK_PLACEHOLDER))
      return { status: 400, error: `title still contains ${HOOK_PLACEHOLDER} — save the hooks first` };
    return null;
  }
  if (existsSync(path.join(dir, "youtube-short.json")))
    return {
      status: 409,
      error: `the Short of match ${matchId} is already on the channel (youtube-short.json) — it goes up once; a second copy is a duplicate only Studio removes`,
    };
  // Hand mode (config.shortsByHand): the chain's own render step never runs, so there is no
  // cut.json to match a saved hook against — short-<id>.hand.json (npm run short:hand) is the
  // one source of the Short's title, built straight into its title.txt (src/shorts/handShort.ts).
  if (config.shortsByHand) {
    if (!(await readHandShort(dir, matchId)) || !existsSync(path.join(dir, `short-${matchId}.mp4`)))
      return { status: 409, error: `${WAITING_FOR_HAND_SHORT} — npm run short:hand` };
    return null;
  }
  const hook = await readShortHook(dir, matchId);
  if (hook === null) return { status: 409, error: `${WAITING_FOR_HOOK} — save the hooks first` };
  const cut = await readShortCut(dir, matchId);
  if (cut?.hook !== hook)
    return {
      status: 409,
      error:
        "the Short on disk was cut behind another hook — save the hooks and the chain re-cuts it before it uploads",
    };
  return null;
}

/**
 * Everything an upload is, minus the HTTP: the route answers 202 with `progress` and lets the
 * browser poll it, the chain awaits `finished`. One place, so the two cannot drift on what
 * gets refused, what gets sent, or what happens after the insert.
 *
 * Title, description and tags come off the match's files (`uploadTextFor`), not the request:
 * the dashboard's title editor already writes the `.edited.txt` the publish kit pastes from, and
 * a second copy of the text in a form was how a title picked up a stray newline.
 */
/**
 * A re-render or a new tile's Use this in flight (src/thumbnails/rerender.ts): the long-form's
 * thumbnail and manifest could move under it. Use this refuses an upload in flight in turn.
 */
export const thumbnailRefusal = (
  matchId: number,
  kind: UploadKind,
): { status: number; error: string } | null =>
  kind === "video" && thumbnailRunning(matchId)
    ? {
        status: 409,
        error: `the thumbnails of match ${matchId} are being re-rendered or put in place — try again once they are done`,
      }
    : null;

export async function beginUpload(
  matchId: number,
  req: UploadRequest,
  /** `videos.insert` itself — the one seam the tests and the end-to-end run replace. */
  send: typeof uploadVideo = uploadVideo,
): Promise<Begun> {
  const begun = await startUpload(matchId, req, send);
  // Every upload of the match is a line of its Short log, whoever pressed: a refusal too.
  if ("error" in begun)
    shortLog(matchId, logStep(req.kind), `upload refused: ${begun.error}`, { level: "error" });
  return begun;
}

const logStep = (kind: UploadKind) => (kind === "video" ? "upload-video" : "upload-short");
const kindName = (kind: UploadKind) => (kind === "video" ? "the long-form" : "the Short");
const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/**
 * What an upload's failure means for the operator: "what happened — what to do", from the text
 * youtube.ts builds out of Google's answer (`error.errors[].reason` among it). What is none of the
 * known cases is returned as it came. Every retry is a press of Save on the hooks (the chain) or of
 * Upload (the panel); the chain lists the channel first, so a retry never puts a video up twice.
 */
export function explainUploadError(raw: string): string {
  const first = raw.split("\n")[0]!;
  if (/No YouTube credentials|has no refresh_token/.test(raw))
    return `no YouTube sign-in on the lab (${first}) — run npm run youtube-auth on a machine with a browser, copy youtube-token.json to the lab, then try again`;
  if (/invalid_grant|token refresh failed|expired or revoked/i.test(raw))
    return "the YouTube sign-in expired or was revoked (invalid_grant) — run npm run youtube-auth on a machine with a browser, copy youtube-token.json to the lab, then try again";
  if (/uploadLimitExceeded/.test(raw))
    return "the channel reached YouTube's daily upload limit (uploadLimitExceeded) — try again tomorrow";
  if (/quotaExceeded|dailyLimitExceeded|exceeded your quota/i.test(raw))
    return "YouTube's daily API quota is used up (an upload costs 1,600 of 10,000 units) — it resets at midnight Pacific (09:00 in Warsaw); try again after that";
  if (/invalidPublishAt|scheduled publishing time/i.test(raw))
    return `YouTube refused the publish time — it had passed, or is too far out (${first}); try again to take the next free slot`;
  if (/-> 401\b/.test(raw))
    return `YouTube refused the access token (${first}) — the stored scopes may not cover uploads; re-run npm run youtube-auth`;
  if (/-> 5\d\d\b|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/.test(raw))
    return `YouTube could not be reached or failed mid-upload (${first}) — try again; nothing is on the channel twice`;
  if (/-> (400|403)\b/.test(raw))
    return `YouTube refused the upload (${first}) — fix what it names, then try again`;
  return raw;
}

/**
 * Where a kind's upload reads its bytes from, absent the hand-named `videoPath` escape hatch —
 * shared by a fresh upload and a resume (`resumeUpload`), so the two can never resolve to
 * different files for the same match.
 */
async function uploadFilePath(
  matchId: number,
  kind: UploadKind,
): Promise<{ path: string } | { error: string }> {
  if (kind === "short") return { path: path.join(matchDir(matchId), `short-${matchId}.mp4`) };
  const status = await matchStatusFor(matchId);
  return findExportedVideo(matchId, [status.leftNickname, status.rightNickname]);
}

async function startUpload(matchId: number, req: UploadRequest, send: typeof uploadVideo): Promise<Begun> {
  if (!config.youtubeUploadEnabled) return { status: 403, error: UPLOADS_OFF };
  const key = progressKey(matchId, req.kind);
  const running = uploads.get(key);
  if (running && !running.done)
    return { status: 409, error: `Match ${matchId} is already uploading its ${req.kind}` };

  const dir = path.resolve(matchDir(matchId));
  const refused = await hookRefusal(matchId, req.kind);
  if (refused) return refused;
  const text = await uploadTextFor(matchId, req.kind);
  const bad = (error: string): Begun => ({ status: 400, error });
  if (text.title === "") return bad(`no title on disk for the ${req.kind} of match ${matchId}`);
  // Refuse a title still carrying the `<HOOK>` placeholder — the one string that must never
  // reach YouTube. The client shows the same test; this is the half that needs no UI to be right.
  if (text.title.includes(HOOK_PLACEHOLDER))
    return bad(`title still contains ${HOOK_PLACEHOLDER} — pick a hook first`);
  // YouTube's own limits, checked before the bytes go up: it rejects the metadata only after the
  // whole file has been sent, so a 101-character title costs a gigabyte of upload to find out.
  if (text.title.length > 100 || /[<>]/.test(text.title))
    return bad("title must be at most 100 characters and contain no < or >");
  // The description's ceiling is in bytes (an accented or Polish letter is two), and < > are
  // refused there just as in the title.
  if (Buffer.byteLength(text.description) > 5000 || /[<>]/.test(text.description))
    return bad("description must be at most 5000 bytes and contain no < or >");
  if (text.tags.some((t) => t.length > 30) || text.tags.join(",").length > 500)
    return bad("tags: none over 30 characters, and at most 500 characters in all");

  let filePath: string;
  if (req.videoPath) {
    filePath = path.resolve(req.videoPath);
    if (!filePath.startsWith(dir + path.sep)) return bad(`videoPath must be inside ${dir}`);
  } else {
    const located = await uploadFilePath(matchId, req.kind);
    if ("error" in located) return bad(located.error);
    filePath = located.path;
  }
  if (!existsSync(filePath))
    return bad(
      req.kind === "short" && !req.videoPath
        ? `the Short is not cut yet (no short-${matchId}.mp4) — save the hooks and the chain cuts it`
        : `No such video file: ${filePath}`,
    );
  // A sync.json newer than the export means the clips were re-placed after this file was
  // encoded, so it carries the misalignment the correction was for. The Short is cut from the
  // VODs with sync.json directly, so only the long-form can be stale. `videoPath` too: a
  // hand-named export was still made from the offsets of its day.
  if (req.kind === "video") {
    const staleness = exportStale(dir, filePath);
    if (staleness.stale) return bad(staleExportMessage(matchId, staleness.staleMatchId));
  }

  // YouTube checks a scheduled time only once the whole file is up, and refuses one in the past:
  // a gigabyte sent to be told so. The chain's slots are an hour out at least; a stale form's is not.
  if (req.publishAt !== undefined && !(Date.parse(req.publishAt) > Date.now()))
    return bad(
      `the publish time ${req.publishAt} has already passed — pick a later one (the chain takes the next free slot)`,
    );

  // A DNF is never posted, long-form or Short (`matchIsDnf`: nobody finished; a playoff game or
  // series, forfeited or not, always goes up). The last refusal before the bytes, not in
  // `hookRefusal`, which decides offline: one cached MCSR read, as this upload's match status makes.
  // Saved hooks already refuse a DNF (`saveHooks`), so this catches only hooks saved before 16 Oct 2026.
  if (await matchIsDnf(matchId))
    return { status: 403, error: dnfRefusal(matchId, "uploads of it are refused") };

  const held = thumbnailRefusal(matchId, req.kind);
  if (held) return held;
  // The pair's playlist, made now rather than at finish, so this description can link it: after
  // every refusal above, so a public `playlists.insert` (a dozen a day) is never spent on an
  // upload that then does not happen.
  if (req.kind === "video") text.description = await withMatchupPlaylist(matchId, dir, text);

  // In the tick that marks the upload running, so nothing starts between the two. The running
  // check again too: a double press passes the first one while the other is still awaiting above.
  const again = uploads.get(key);
  if (again && !again.done)
    return { status: 409, error: `Match ${matchId} is already uploading its ${req.kind}` };
  const progress = idle(matchId, req.kind);
  uploads.set(key, progress);
  const step = logStep(req.kind);
  startActivity(
    matchId,
    step,
    `uploading ${kindName(req.kind)} (${Math.round(statSync(filePath).size / 1e6)} MB, ${req.privacyStatus}${req.publishAt ? `, public at ${utc(req.publishAt)}` : ""})`,
  );

  const finished = (async () => {
    let recorded = false;
    try {
      const manifest = await readManifest(dir);
      const result = await send({
        filePath,
        title: text.title,
        description: text.description,
        tags: text.tags,
        privacyStatus: req.privacyStatus,
        publishAt: req.publishAt,
        // A Short must not ring the bell a second time for the same match.
        notifySubscribers: req.kind === "video",
        onProgress: (uploaded, total) => {
          progress.uploaded = uploaded;
          progress.total = total;
          if (total > 0) activityProgress(matchId, step, (uploaded / total) * 100);
        },
      });
      progress.videoId = result.videoId;
      shortLog(
        matchId,
        step,
        `${kindName(req.kind)} is up: https://youtu.be/${result.videoId} — ${result.publishAt ? `public at ${utc(result.publishAt)}` : result.privacyStatus}`,
      );
      const record: UploadRecord = {
        videoId: result.videoId,
        uploadedAt: new Date().toISOString(),
        publishAt: result.publishAt,
        privacyStatus: result.privacyStatus,
        thumbnailVariant: manifest?.chosen ?? null,
        title: titleSent(matchId, step, result, text.title),
        source: "dashboard",
      };
      await writeUpload(matchId, record, req.kind);
      recorded = true;
      // The video is up; what follows is worth reporting but must not read as a failed upload.
      const steps = await finishOnYouTube(matchId, result.videoId, req.kind);
      // Only the steps that actually failed: `null` is done and an absent step was never
      // attempted (a Short's thumbnail, a private video's comment), neither of which is a problem.
      progress.warnings = Object.entries(steps)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .map(([finishStep, error]) => `Uploaded, but the ${finishStep} step failed: ${error}`);
      for (const w of progress.warnings) shortLog(matchId, step, w, { level: "warn" });
      // Published is the point the match is finished with, so it is the point worth backing up.
      // Fire-and-forget (see archiveMatch's note); failures land in the server log and in
      // GET /api/capacity, not here — a NAS blip must not read as a failed upload.
      if (req.kind === "video") archiveMatch(matchId);
    } catch (err) {
      const raw = describeError(err);
      if (recorded) {
        // Up and recorded; only the finishing threw. A problem on the way, not a failed upload.
        progress.warnings.push(`Uploaded, but finishing it failed: ${raw} — Finish on YouTube retries it`);
        shortLog(matchId, step, progress.warnings.at(-1)!, { level: "warn" });
      } else {
        // Up, and the record not written (the disk, most likely): the one failure where trying
        // again would put a second copy on the channel.
        progress.error = progress.videoId
          ? `${kindName(req.kind)} IS on the channel as ${progress.videoId}, but recording it failed (${boxFailure("writing the upload record", raw) ?? raw}) — do not upload it again; fix that, then "check the channel" pairs it`
          : explainUploadError(raw);
        shortLog(matchId, step, progress.error, { level: "error", detail: raw });
      }
    } finally {
      progress.done = true;
      endActivity(matchId, step);
    }
    return progress;
  })();
  return { progress, finished };
}

/**
 * Every playlist a match video joins, as [title, description]. The one place that decides, for
 * the dashboard upload, the nightly's and "Finish on YouTube".
 *
 * A Short joins no playlists: a viewer binge-watching the season hits a 30-second vertical clip
 * between 10-minute replays otherwise. The matchup playlist is for the long-form: a rematch is
 * the strongest series signal this channel has — it is already what the best hook chips say
 * ("Rematch: doogile leads 2-1") — and a playlist is how a viewer who liked one finds the rest;
 * the per-player one is the link a runner shares. Both are skipped when the nicknames are the
 * "?" `matchStatusFor` degrades to with the MCSR API down: a public playlist called "? vs ?" is
 * worse than none, and unlike the upload it cannot be quietly re-done later.
 *
 * A playoff game takes the tournament's playlist in place of the matchup's: the bracket is the
 * series, and the same pair's ranked games have no business in it. `playoff` is passed in rather
 * than looked up here so the shape stays pure and testable; `playoffContextForId` is one cached
 * API read at the caller.
 */
export const playlistTitlesFor = (
  match: { leftNickname: string; rightNickname: string },
  kind: UploadKind,
  playoff: { season: number } | null = null,
): Array<[title: string, description: string]> => {
  if (kind === "short") return [];
  const { leftNickname: l, rightNickname: r } = match;
  const season: Array<[string, string]> = config.youtubePlaylistTitle
    ? [[config.youtubePlaylistTitle, SEASON_PLAYLIST_DESCRIPTION]]
    : [];
  if (l === "?" || r === "?") return season;
  return [
    ...season,
    playoff
      ? [playoffPlaylistTitle(playoff.season), playoffPlaylistDescription(playoff.season)]
      : [matchupPlaylistTitle(l, r), matchupPlaylistDescription(l, r)],
    [playerPlaylistTitle(l), playerPlaylistDescription(l)],
    [playerPlaylistTitle(r), playerPlaylistDescription(r)],
  ];
};

/**
 * The channel's video of another match between the same two players, or null: the matchup
 * playlist exists from the second meeting on. Reads the upload records on disk — the pairing
 * this dashboard made — and each match's status for the names.
 */
async function earlierVideoOfPair(
  matchId: number,
  status: { leftNickname: string; rightNickname: string },
): Promise<string | null> {
  const pair = new Set([status.leftNickname, status.rightNickname]);
  for (const { matchId: other, record } of await allUploads()) {
    if (other === matchId) continue;
    const s = await matchStatusFor(other);
    if (pair.has(s.leftNickname) && pair.has(s.rightNickname)) return record.videoId;
  }
  return null;
}

/**
 * `part()`'s answer, or null with one log line: every part of the pinned comment is best effort
 * (`uploadTextFor`'s rule), so a comment without its question or its link still goes up.
 */
async function quietly<T>(matchId: number, what: string, part: () => Promise<T>): Promise<T | null> {
  try {
    return await part();
  } catch (err) {
    console.warn(`pinned comment, match ${matchId}: no ${what} — ${describeError(err)}`);
    return null;
  }
}

/**
 * `work`, or a rejection once `ms` have passed; no `ms` is no cap. A call to YouTube has no timeout
 * of its own (undici waits up to five minutes for the headers), and a page must not wait on that.
 */
function within<T>(ms: number | undefined, work: Promise<T>): Promise<T> {
  if (ms === undefined) return work;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer after ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * The playlist a viewer is sent to from the first comment: the pair's (or the tournament's) if
 * the channel has one, else a player's, else the season's, as a link, or null. Looked up by title
 * without creating anything — the matchup playlist waits for the pair's second video — so
 * `playlistTitlesFor` (season first) is only reordered, most specific first. A lookup that fails
 * is one title lost, not the chain: a later one may be an id this process already knows. Past
 * `until` (epoch ms) the caller has stopped waiting and no more lookups are made for it.
 */
async function playlistUrlFor(
  matchId: number,
  status: { leftNickname: string; rightNickname: string },
  until = Infinity,
): Promise<{ title: string; url: string } | null> {
  const titles = playlistTitlesFor(status, "video", await playoffContextForId(matchId)).map(
    ([title]) => title,
  );
  const season = config.youtubePlaylistTitle;
  for (const title of [...titles.filter((t) => t !== season), ...titles.filter((t) => t === season)]) {
    if (Date.now() >= until) return null;
    const id = await quietly(matchId, `playlist "${title}"`, () => findPlaylistId(title));
    if (id) return { title, url: playlistUrl(id) };
  }
  return null;
}

/**
 * Rivalry packaging before the insert (22 Oct 2026, new uploads only): a pair's matchup playlist
 * is made at finish, on the pair's second video — after the insert this description goes up
 * with. So the chain's own upload makes it here instead, when the pair has history
 * (`lastMeetingFor`, the "last time they met" test; `uploadTextFor` adds the named ask and stays
 * off the network), and the description gets its "every A vs B on the channel" line
 * (`withRivalry`). The names the
 * title shows, in its order. A playoff game never gets one (`playlistTitlesFor`: the tournament's
 * stands in), nor a blocked pair, nor "?" (the API down), nor a description the operator edited
 * (`uploadTextFor`'s own rule: their words go up as they are, and as the kit showed them). A
 * failed insert is one log line and the season line stays: finish makes the playlist later, as
 * before. Exported for the test.
 */
export async function withMatchupPlaylist(
  matchId: number,
  dir: string,
  text: { title: string; description: string },
): Promise<string> {
  const parts = splitTitle(text.title);
  if (
    !parts ||
    !isConfigured() ||
    RIVALRY_PLAYLIST_LINE.test(text.description) ||
    hasBlockedPlayer(dir) ||
    existsSync(metaPaths(matchId, "description").edited)
  )
    return text.description;
  if (!(await lastMeetingFor(matchId, text.title)) || (await playoffContextForId(matchId)))
    return text.description;
  const { leftNickname: l, rightNickname: r } = await matchStatusFor(matchId);
  if (l === "?" || r === "?") return text.description;
  try {
    const id = await findOrCreatePlaylist(matchupPlaylistTitle(l, r), matchupPlaylistDescription(l, r));
    return withRivalry(text.description, parts.left, parts.right, playlistUrl(id));
  } catch (err) {
    console.warn(`upload, match ${matchId}: no matchup playlist to link — ${describeError(err)}`);
    return text.description;
  }
}

/**
 * The first comment on a match's video, gathered: a spoiler-free question from the match's own
 * race (`pinnedQuestion`) and the playlist to watch next (`playlistUrlFor`), composed by
 * `pinnedComment`. `finishOnYouTube` posts it and the publish kit shows it, so the paste and the
 * call cannot say two different things. A joined series is asked about as a series.
 *
 * Each part is best effort and logged once when it cannot be had, the rule `uploadTextFor`
 * follows: a comment without its question or its link still goes up, and there is no playlist
 * lookup at all without a YouTube sign-in to make it with. `playlistWaitMs` caps the playlist
 * part: the kit answers a page and passes ten seconds, while the finish step waits as long as it
 * takes, since a comment posted without its link stays without it.
 */
export async function pinnedCommentFor(matchId: number, playlistWaitMs?: number): Promise<string> {
  const dir = matchDir(matchId);
  const series = existsSync(path.join(dir, "series.json"));
  const question = await quietly(matchId, "question", async () =>
    pinnedQuestion(await getMatch(matchId), series),
  );
  const until = playlistWaitMs === undefined ? Infinity : Date.now() + playlistWaitMs;
  const status = await matchStatusFor(matchId);
  const found = isConfigured()
    ? await quietly(matchId, "playlist link", () =>
        within(playlistWaitMs, playlistUrlFor(matchId, status, until)),
      )
    : null;
  // Rivalry packaging (22 Oct 2026): the link is the pair's own playlist AND the pair has history
  // on the channel (`lastMeetingFor`, the description's "last time they met" test) — then the
  // comment names the pair and asks. Never for a blocked pair, whoever asks for the text.
  const matchup = found?.title === matchupPlaylistTitle(status.leftNickname, status.rightNickname);
  const earlier =
    matchup && !hasBlockedPlayer(dir)
      ? await quietly(matchId, "earlier meeting", async () =>
          lastMeetingFor(matchId, (await uploadTextFor(matchId, "video")).title),
        )
      : null;
  const rivalry =
    earlier && found
      ? {
          left: titleName(status.leftNickname),
          right: titleName(status.rightNickname),
          playlistUrl: found.url,
          // "last time they met" (growth plan idea 4, 22 Oct 2026): the previous match's link.
          lastVideoId: earlier,
        }
      : null;
  return pinnedComment({ question, playlistUrl: found?.url ?? null, matchId, rivalry });
}

/**
 * What a video needs after it exists on the channel: the chosen thumbnail, its playlists, the
 * first comment and its tags. The same four steps for a dashboard upload and a Studio one, each reported
 * rather than thrown — the video is up, and a rejected thumbnail must not read as a failed
 * upload. Written into the record so the panel can say what is still missing. A Short gets no
 * playlist, no custom thumbnail (Shorts show a frame) and no comment.
 *
 * Idempotent through that record, which is why it is read first: a step that already answered
 * `null` is done and is skipped. Three of the four are writes to the live channel that only a
 * human in Studio can undo — `postComment` de-duplicates nothing, and `addToPlaylist` documents
 * that it never has to, because until this function existed it only ever ran on a video
 * `videos.insert` had returned seconds earlier. The button is on every published match and the
 * scan can auto-finish, so pressing it twice must be free.
 */
export function finishOnYouTube(
  matchId: number,
  videoId: string,
  kind: UploadKind = "video",
  /** The Studio pin itself — a real browser, so this is the one seam tests replace. */
  pinAction: typeof attemptStudioPin = attemptStudioPin,
): Promise<FinishedSteps> {
  // Waits out a "Put on YouTube" on this match, whose image and ledger it would otherwise undo.
  return onVideo(matchId, () => finishSteps(matchId, videoId, kind, pinAction));
}

async function finishSteps(
  matchId: number,
  videoId: string,
  kind: UploadKind,
  pinAction: typeof attemptStudioPin,
): Promise<FinishedSteps> {
  const attempt = async (step: () => Promise<void>): Promise<string | null> => {
    try {
      await step();
      return null;
    } catch (err) {
      return describeError(err);
    }
  };
  const dir = matchDir(matchId);
  const record = await readUpload(matchId, kind);
  const already = record?.finished ?? {};
  // A step is redone only if it has not already succeeded. `undefined` is "not attempted", so a
  // Short that later needs nothing, or a comment skipped while the video was private, is retried
  // — the same press that fixes a genuine failure.
  const todo = (step: keyof FinishedSteps): boolean => already[step] !== null;

  // Checked before any read or write reaches YouTube, and before the match status / manifest
  // reads below: Adopt, the Finish button and the nightly's retries (retryFailedPlaylists,
  // retryPendingComments) all settle through this one function, so all three inherit the
  // refusal without a check of their own. A step already finished (from before the player was
  // blocked) is left alone — nothing true becomes a lie — and nothing not yet done is attempted.
  // Not persisted: the record keeps whatever it already said, so unblocking needs no repair.
  if (hasBlockedPlayer(dir)) {
    return {
      playlists: todo("playlists") ? BLOCKED_FINISH : null,
      thumbnail: todo("thumbnail") ? BLOCKED_FINISH : null,
      comment: todo("comment") ? BLOCKED_FINISH : null,
      tags: todo("tags") ? BLOCKED_FINISH : null,
      // Zero behaviour change while studioAutomation is off (the key is absent, as it always was).
      ...(config.studioAutomation ? { pin: todo("pin") ? BLOCKED_FINISH : null } : {}),
    };
  }

  const status = await matchStatusFor(matchId);
  const manifest = await readManifest(dir);
  const thumb = path.join(
    dir,
    manifest?.variants.find((v) => v.key === manifest.chosen)?.file ?? "thumbnail.png",
  );

  const finished: FinishedSteps = { ...already };

  if (todo("playlists")) {
    // A playoff game joins the tournament's playlist instead of the matchup's. Read here rather
    // than in `playlistTitlesFor` so that stays a pure function of what it is handed.
    const playoff = kind === "video" ? await playoffContextForId(matchId) : null;
    // A matchup playlist waits for the pair's second video: 22 of the channel's 28 playlists held
    // one video (the 22 Sept 2026 audit), each a `playlists.insert` against the day's cap of a
    // dozen. The earlier video is added alongside when the second arrives. `lastMeetingFor` is
    // the test `withMatchupPlaylist` made the playlist on, off the titles on disk alone: with the
    // MCSR API down and the earlier match's clips freed, `earlierVideoOfPair` sees "?" and the
    // playlist the description already links would stay empty.
    const earlier =
      kind === "video" && !playoff
        ? ((await earlierVideoOfPair(matchId, status)) ??
          (await lastMeetingFor(matchId, record?.title ?? "")))
        : null;
    const playlistErrors: string[] = [];
    for (const [title, description] of playlistTitlesFor(status, kind, playoff)) {
      const isMatchup = !playoff && title === matchupPlaylistTitle(status.leftNickname, status.rightNickname);
      if (isMatchup && earlier === null) continue;
      const error = await attempt(() => addToPlaylist(videoId, title, description));
      if (error)
        playlistErrors.push(`"${title}": ${error.includes("RATE_LIMIT_EXCEEDED") ? PLAYLIST_CAP : error}`);
      else if (isMatchup && earlier) await attempt(() => addToPlaylist(earlier, title, description));
    }
    finished.playlists = playlistErrors.length ? playlistErrors.join("; ") : null;
  }
  if (todo("thumbnail")) {
    // A Short shows a frame of itself; there is no custom thumbnail to set.
    //
    // And a video already on the channel keeps the thumbnail it is wearing unless somebody chose
    // one here: pressing this on a Studio upload should add it to its playlists and post its
    // comment, not overwrite an image the operator picked in Studio with the renderer's own
    // default. `chosenBy: "operator"` is the only evidence that the manifest's pick is a decision
    // rather than a fallback — the same test the publish checklist uses.
    const wasUploadedElsewhere = (record?.source ?? "dashboard") !== "dashboard";
    const variantConfirmed = manifest?.chosenBy === "operator";
    // And only the folder that owns the video sets its image: a series' games 2..n carry game 1's
    // video id (a copied record, or none — the channel scan records none for them, while the panel
    // still pairs them from the description and offers Finish), and would put their own pick over
    // the series' — over a "Put on YouTube" from game 1 too — with no ledger to stop the next press.
    finished.thumbnail =
      kind === "short"
        ? null
        : !(await longFormRecord(matchId))
          ? "left alone — this folder holds no upload record of its own for the video (a series' games 2..n: game 1's folder sets its image)"
          : wasUploadedElsewhere && !variantConfirmed
            ? "left alone — this video was uploaded elsewhere and no variant was confirmed here"
            : existsSync(thumb)
              ? await attempt(() => setThumbnail(videoId, thumb))
              : `no thumbnail at ${thumb}`;
  }
  if (todo("comment")) {
    // A Short gets no comment. On the long-form, YouTube refuses comments while the video is
    // private — and the nightly uploads private by design — so that is left unattempted rather
    // than recorded as a failure, which would put ", with a problem" on every nightly push.
    //
    // The record's `privacyStatus` is whatever it was when the video was uploaded or adopted, and
    // it is never updated: a draft adopted while private and published an hour later would carry
    // "private" for ever, and this step would skip for ever with it. So the record is the cheap
    // "definitely not yet" and the live status is what actually decides.
    if (kind === "short") finished.comment = null;
    else {
      const live =
        record?.privacyStatus === "private"
          ? ((await videoStats([videoId]))[0]?.privacyStatus ?? "private")
          : record?.privacyStatus;
      if (live !== "private") {
        finished.comment = await attempt(async () => {
          // One comment per video, whoever posted it: a series' games, a Studio upload paired by
          // the scan and a second press all come through here, and YouTube is the only record
          // they share (ZqI4Cf1g3_w got four, 26 Sept 2026). A failed read posts nothing.
          // ponytail: reads the newest 50 threads; page through them once a video has more.
          if ((await commentThreads(videoId, config.youtubeChannelId)).some((t) => t.byChannel)) return;
          await postComment(videoId, await pinnedCommentFor(matchId));
        });
      }
    }
  }
  if (todo("tags")) {
    // Tags are the step that silently gets skipped: they are pasted by hand in Studio, and every
    // video on this channel is missing some of them, both player nicknames included. This is
    // `videos.update`, not `videos.insert`, so the compliance audit does not gate it, and the
    // merge only ever adds — nothing typed in Studio is lost. A Short carries its tags in its
    // title, and there is nothing to add when the file lists none.
    if (kind === "short") finished.tags = null;
    else {
      const { tags } = await uploadTextFor(matchId, kind);
      finished.tags =
        tags.length === 0
          ? null
          : await attempt(async () => {
              await addTags(videoId, tags);
            });
    }
  }
  // Studio automation's own step (config.studioAutomation, default off — a deliberate edit on the
  // box, like nightlyUpload): pins the channel's first comment through a real browser, since
  // pinning has no API. Off, this reads and launches nothing — `finished.pin` stays whatever it
  // already was (absent, on every record, while the setting has never been on).
  if (config.studioAutomation && kind === "video" && todo("pin")) {
    // Waits for the comment itself to have landed (Studio pins an existing thread) and for the
    // video to actually be public — re-read live, the same reason the comment step does: the
    // record's `privacyStatus` is from upload time and is never updated.
    if (finished.comment === null) {
      const live =
        record?.privacyStatus === "public"
          ? "public"
          : ((await videoStats([videoId]))[0]?.privacyStatus ?? record?.privacyStatus);
      if (live === "public") finished.pin = await pinAction(matchId, videoId);
    }
    // Neither condition met yet: `finished.pin` is left untouched (absent, or whatever `already`
    // carried), which is exactly what `todo` reads as "still to do" on the next call.
  }
  // Read again: the steps above take seconds of API calls, and a Move on YouTube or the Studio
  // worker's pin (another process, outside onVideo) may have written the record meanwhile — only
  // this step's own field goes back. A record now for another video, or none, is not this ledger's.
  const latest = await readUpload(matchId, kind);
  if (record && latest?.videoId === record.videoId) await writeUpload(matchId, { ...latest, finished }, kind);
  return finished;
}

/**
 * One Studio action: launches Chrome fresh, probes the session, pins the comment, then always
 * stops the browser again — one browser at a time (src/youtube/studioBrowser.ts). A `verify`,
 * `signed-out` or `wrong-channel` probe is recorded as this attempt's error and not chased any
 * further within this call; nothing about the session actually changes until the operator logs
 * in again through the YouTube panel's Studio login, so a later tick finding the same thing is
 * expected, not a bug.
 */
async function attemptStudioPin(matchId: number, videoId: string): Promise<string | null> {
  if (studioBrowserRunning()) return "another Studio job holds the browser — retried next tick";
  let handle;
  try {
    handle = await startStudioBrowser();
  } catch (err) {
    return describeError(err);
  }
  try {
    const probed = await probeStudio(handle);
    if (probed.result !== "ok")
      return `Studio ${probed.result} — log in again through the YouTube panel's Studio login`;
    const outcome = await pinComment(handle, videoId, { matchId });
    if (typeof outcome === "object") return outcome.error;
    return outcome === "pinned" || outcome === "already-pinned" ? null : `Studio: ${outcome}`;
  } catch (err) {
    return describeError(err);
  } finally {
    await handle.stop().catch(() => {});
  }
}

/**
 * One long-form video whose comment has already landed but whose Studio pin has not: `matchId` is
 * whichever folder first recorded it, same shape as `pendingComments` (a series copies one record
 * into every game's folder).
 */
interface PendingPin {
  matchId: number;
  done: boolean;
}

async function pendingPins(): Promise<Map<string, PendingPin>> {
  const byVideo = new Map<string, PendingPin>();
  for (const matchId of listProcessedMatchIds()) {
    const record = await readUpload(matchId, "video");
    // The pin step itself waits for the comment to land (above); so does this list — there is
    // nothing yet for Studio to pin.
    if (!record || record.finished?.comment !== null) continue;
    const done = record.finished?.pin === null;
    const seen = byVideo.get(record.videoId);
    if (seen) seen.done ||= done;
    else byVideo.set(record.videoId, { matchId, done });
  }
  return byVideo;
}

/**
 * The nightly's tick for a comment already posted whose pin is not — one Chrome launch per
 * pending video, at most `maxPerTick` (10). Off (the default, `config.studioAutomation`), this
 * reads nothing and launches nothing: the whole body is skipped. `nightly.ts` calls this only
 * when no export is running, since Chrome and ffmpeg share this box's four cores.
 */
export async function retryPendingStudio(
  finish: typeof finishOnYouTube = finishOnYouTube,
  maxPerTick = 10,
): Promise<void> {
  if (!config.studioAutomation) return;
  const byVideo = await pendingPins();
  let attempted = 0;
  for (const [videoId, v] of byVideo) {
    if (attempted >= maxPerTick) break;
    if (v.done) continue;
    attempted++;
    const { pin } = await finish(v.matchId, videoId, "video");
    console.error(`studio: #${v.matchId} pin ${pin === null ? "done" : (pin ?? "pending")}`);
  }
}

/**
 * A record with no session left to resume and no proof it was ever finished: the channel scan's
 * own premature pairing (`recordStudioUpload`), or anything else this chain did not itself write.
 * `hookRefusal` would have refused the chain's own upload from ever starting had this record
 * existed first, so finding one now means it appeared *after* — almost certainly the scan pairing
 * the very upload this step is trying to settle. Deleting it on a guess would risk forgetting a
 * genuinely finished upload (and uploading it a second time), so it is named instead: Retry alone
 * only clears the step, never this file, so without deleting the file too it would keep reading
 * as already uploaded forever.
 */
const studioNoSession = (kind: UploadKind, matchId: number, record: UploadRecord): string => {
  const file = kind === "video" ? "youtube.json" : "youtube-short.json";
  return (
    `${kindName(kind)} shows as uploaded (${record.videoId}, from ${record.source === "studio" ? "Studio" : "elsewhere"}) ` +
    `but this chain never finished sending it and its upload session is gone — check Studio (delete the video there ` +
    `if it is broken), then delete ${path.join(matchDir(matchId), file)} by hand: Retry alone will not, and this ` +
    `record would keep reading as already uploaded`
  );
};

/**
 * A cut-short upload's session YouTube could still resume for this kind: only `resumeUpload` may
 * settle it. A dead one (over a day old, or left by bytes re-encoded since) is not: the normal
 * upload starts fresh over it, where a resume could only refuse, on every Save, for good.
 */
export async function uploadSessionOnDisk(matchId: number, kind: UploadKind): Promise<boolean> {
  const located = await uploadFilePath(matchId, kind);
  return !("error" in located) && (await resumableSession(located.path));
}

/**
 * The title YouTube actually holds, for the record. A resumed session carries the one its start
 * sent, which a hook changed since the failure does not reach: said in the log, never retitled
 * here (a retitle on the channel is the operator's call).
 */
function titleSent(
  matchId: number,
  step: ReturnType<typeof logStep>,
  result: UploadResult,
  onDisk: string,
): string {
  const sent = result.title ?? onDisk;
  if (sent !== onDisk)
    shortLog(
      matchId,
      step,
      `went up under the title its upload started with, "${sent}"; the title on disk now reads "${onDisk}" — change it in Studio if that one should stand`,
      { level: "warn" },
    );
  return sent;
}

/**
 * A step `shortTick` finds recorded "running" with no chain alive in this process to finish it:
 * whatever was sending the bytes is gone, but the upload itself may not be — YouTube keeps a
 * resumable session for about a day. Finishes it through `uploadVideo`'s own resume (its 2xx
 * probe path is "already all there", 308 is "keep sending") rather than trusting whatever is on
 * disk: the channel scan can pair a half-uploaded video to its match by the description link
 * alone, long before every byte of it has actually landed (`recordStudioUpload` below), and that
 * record used to read as "done" and leave the step "running" forever (2 Oct 2026, the Grand
 * Final's `series-13530634.mp4`, paired at 30% uploaded). `resumeOnly` is the guarantee this never
 * falls through to starting a second copy of the video — the one thing a restart must not cause.
 * Reserves the same `uploads` slot `startUpload` does, so `uploadRunning` — and so `writeHooks`'s
 * in-flight guard, the manual Upload route's own, and the publish-time lock — can see a resume in
 * flight exactly as they would a fresh upload; a browser poll of `uploadProgress` sees it too.
 *
 * No session left and no record either is a safe no-op (nothing of this chain's is in flight, and
 * the normal upload step starts fresh right after). No session and a `source: "dashboard"` record
 * is trusted as done (the crash landed between writing it and marking the step so). No session and
 * anything else on record fails the step and names Studio, never a guess (`studioNoSession`).
 *
 * `send` succeeding is not the same as the step succeeding: `uploadVideo` has already forgotten
 * the session by the time it returns, so if writing the record or finishing it then throws, the
 * video is live under `result.videoId` with nothing here that remembers it — the one failure
 * where sending it again would be a second copy, same as `startUpload`'s own `recorded` tracking
 * exists for. That takes priority over a foreign record: a live id is worth more than a guess.
 * Null settles the step done; a message is its failure.
 */
export async function resumeUpload(
  matchId: number,
  kind: UploadKind,
  send: typeof uploadVideo = uploadVideo,
): Promise<string | null> {
  const located = await uploadFilePath(matchId, kind);
  // A runner blocked since the upload started: the rest of the bytes never go up either, with or
  // without a session. A half-sent one's session file stays and is named — deleting it (and the
  // half-sent video in Studio) is the operator's call.
  if (hasBlockedPlayer(matchDir(matchId))) {
    const session = "error" in located ? null : sessionPath(located.path);
    return session && existsSync(session)
      ? `match ${matchId} has a blocked player — ${kindName(kind)} a restart cut short is left unfinished; delete it in Studio and ${path.basename(session)} by hand`
      : `match ${matchId} has a blocked player — uploads of it are refused`;
  }
  if ("error" in located) return located.error;
  const filePath = located.path;
  const record = await readUpload(matchId, kind);
  if (!existsSync(sessionPath(filePath))) {
    if (!record || record.source === "dashboard") return null;
    return studioNoSession(kind, matchId, record);
  }
  // A sync.json corrected since these bytes were encoded: the rest of them would finish a desynced
  // video, which `startUpload` refuses too. Nothing is sent and the session stays; a re-encode is
  // different bytes, so the next Save starts fresh over it.
  if (kind === "video") {
    const staleness = exportStale(matchDir(matchId), filePath);
    if (staleness.stale) return staleExportMessage(matchId, staleness.staleMatchId);
  }
  const manifest = await readManifest(matchDir(matchId));
  const text = await uploadTextFor(matchId, kind);
  const step = logStep(kind);
  const key = progressKey(matchId, kind);
  const progress = idle(matchId, kind);
  uploads.set(key, progress);
  startActivity(matchId, step, `resuming ${kindName(kind)} after a restart`);
  let recorded = false;
  try {
    const result = await send({
      filePath,
      title: text.title,
      description: text.description,
      tags: text.tags,
      privacyStatus: "private",
      resumeOnly: true,
      onProgress: (uploaded, total) => {
        progress.uploaded = uploaded;
        progress.total = total;
        if (total > 0) activityProgress(matchId, step, (uploaded / total) * 100);
      },
    });
    progress.videoId = result.videoId;
    shortLog(
      matchId,
      step,
      `resumed after a restart — ${kindName(kind)} is up: https://youtu.be/${result.videoId}`,
    );
    await writeUpload(
      matchId,
      {
        videoId: result.videoId,
        uploadedAt: new Date().toISOString(),
        publishAt: result.publishAt,
        privacyStatus: result.privacyStatus,
        thumbnailVariant: manifest?.chosen ?? null,
        title: titleSent(matchId, step, result, text.title),
        source: "dashboard",
      },
      kind,
    );
    recorded = true;
    const steps = await finishOnYouTube(matchId, result.videoId, kind);
    for (const [finishStep, error] of Object.entries(steps))
      if (typeof error === "string")
        shortLog(matchId, step, `Uploaded, but the ${finishStep} step failed: ${error}`, { level: "warn" });
    if (kind === "video") archiveMatch(matchId);
    return null;
  } catch (err) {
    const raw = describeError(err);
    if (recorded) {
      // Up and recorded; only the finishing threw. A problem on the way, not a failed step —
      // startUpload's own catch treats this the same way, as a warning, not an error.
      shortLog(matchId, step, `Uploaded, but finishing it failed: ${raw} — Finish on YouTube retries it`, {
        level: "warn",
      });
      return null;
    }
    if (progress.videoId) {
      // send() finished and forgot the session; only writing the record threw. The video is up
      // with nothing here that remembers it — sending it again would be the second copy this
      // whole function exists to prevent.
      const message = `${kindName(kind)} IS on the channel as ${progress.videoId}, but recording it failed (${boxFailure("writing the upload record", raw) ?? raw}) — do not upload it again; fix that, then "check the channel" pairs it`;
      shortLog(matchId, step, message, { level: "error", detail: raw });
      return message;
    }
    // send() itself failed (resumeOnly's own refusal included). The session on disk, with
    // YouTube no longer honouring it (expired, say), is the same "ask the operator" case as no
    // session at all, just discovered live instead of from a missing file.
    if (record && record.source !== "dashboard") return studioNoSession(kind, matchId, record);
    const message = explainUploadError(raw);
    shortLog(matchId, step, `resuming after a restart failed: ${message}`, { level: "error", detail: raw });
    return message;
  } finally {
    progress.done = true;
    endActivity(matchId, step);
  }
}

/**
 * The channel scan found a Studio upload for a match with no record: give it the record a
 * dashboard upload would have, back it up, and — only when asked — finish it. Called once per
 * match, the first time the pairing is seen (src/youtube/channelUploads.ts).
 */
export async function recordStudioUpload(matchId: number, video: ChannelVideo): Promise<void> {
  const manifest = await readManifest(matchDir(matchId));
  await writeUpload(matchId, {
    videoId: video.videoId,
    uploadedAt: video.publishedAt,
    // Scheduled in Studio: the Short's time and the kit's Move are worked out from it (r3 #1).
    publishAt: video.publishAt ?? null,
    privacyStatus: video.privacyStatus,
    thumbnailVariant: manifest?.chosen ?? null,
    title: video.title,
    source: "studio",
  });
  console.error(`channel: #${matchId} is ${video.videoId}, uploaded from Studio`);
  // Published is the point a match is finished with, so it is the point worth backing up — and a
  // Studio upload never went through the dashboard's upload path, so this is its only chance.
  // `archiveMatch` itself skips a match already on the NAS and queues the rest one at a time
  // (src/dashboard/archive.ts), so a first scan pairing a dozen does not storm it.
  archiveMatch(matchId);
  if (config.youtubeAutoFinish) await finishOnYouTube(matchId, video.videoId);
}

/**
 * How long after the long-form the Short goes live: the Short lands while the match video is
 * still fresh in Browse. The dashboard's chain schedules by it (src/dashboard/shortFlow.ts).
 */
export const SHORT_DELAY_MS = 18 * 3600_000;

/**
 * YouTube caps `playlists.insert` at about a dozen per rolling 24 h. Undocumented: twelve went
 * through in one minute at 19:27 UTC on 15 Sept 2026, the thirteenth was refused with 429
 * RATE_LIMIT_EXCEEDED, and so was one more at 18:00 the next day — 23 h later. A press the
 * following day succeeds.
 */
const PLAYLIST_CAP = "YouTube's playlist-creation cap (about a dozen a day) — the nightly retries it";

/**
 * The press that clears a playlist step which failed — the cap above, or any other refusal — on
 * every record still carrying one, videos and Shorts both. The nightly's tick makes it, at an
 * hour the cap has rolled over. `finish` is the test's seam.
 */
export async function retryFailedPlaylists(finish: typeof finishOnYouTube = finishOnYouTube): Promise<void> {
  for (const matchId of listProcessedMatchIds()) {
    for (const kind of ["video", "short"] as const) {
      const record = await readUpload(matchId, kind);
      if (typeof record?.finished?.playlists !== "string") continue;
      const { playlists } = await finish(matchId, record.videoId, kind);
      console.error(`playlists: #${matchId} ${kind} ${playlists ?? "done"}`);
    }
  }
}

/** One long-form video, as the comment step sees it: who it belongs to, when it went public, and
 * whether the comment is already posted. */
interface PendingComment {
  matchId: number;
  publishAt: string | null;
  done: boolean;
}

/**
 * Every long-form video with an upload record, one entry per video id rather than per match
 * directory — a series' record is copied into every game's folder (the same videoId), so the
 * ledgers are read per VIDEO and any folder that already has the comment settles all of them.
 * Shared by `retryPendingComments` and `commentSoonTick`, so the two can never disagree about
 * which videos still need a comment.
 */
async function pendingComments(): Promise<Map<string, PendingComment>> {
  const byVideo = new Map<string, PendingComment>();
  for (const matchId of listProcessedMatchIds()) {
    const record = await readUpload(matchId, "video");
    if (!record) continue;
    const seen = byVideo.get(record.videoId);
    const done = record.finished?.comment === null;
    if (seen) seen.done ||= done;
    else byVideo.set(record.videoId, { matchId, publishAt: record.publishAt ?? null, done });
  }
  return byVideo;
}

/**
 * The press that posts the first comment (with the tip jar) on a video uploaded
 * private-and-scheduled once it goes public. The comment step cannot post while a video is
 * private, so a scheduled video gets no comment at upload time. The nightly's tick runs this
 * for every long-form video whose finish ledger has no comment yet and whose publish time is in
 * the past (or which is public now). Shorts never get comments and are skipped. At most a handful
 * per tick; failures are recorded and retried next tick like playlists. `finish` is the test's seam.
 */
export async function retryPendingComments(
  finish: typeof finishOnYouTube = finishOnYouTube,
  maxPerTick = 5,
  nowMs = Date.now(),
): Promise<void> {
  // Only a scheduled upload whose time has come: its comment could not go up while it was
  // private. A video uploaded public got its comment at upload; older ones are not this loop's.
  // Newest first: a record that can never settle (a deleted video, one made private again,
  // comments off) only gets the attempts the fresh ones leave over, instead of starving them.
  const due = [...(await pendingComments())]
    .filter(([, v]) => !v.done && v.publishAt !== null && Date.parse(v.publishAt) <= nowMs)
    .sort(([, a], [, b]) => Date.parse(b.publishAt!) - Date.parse(a.publishAt!))
    .slice(0, maxPerTick);
  for (const [videoId, v] of due) {
    const { comment } = await finish(v.matchId, videoId, "video");
    console.error(`comment: #${v.matchId} ${comment === null ? "done" : (comment ?? "private")}`);
  }
}

/** How long after `publishAt` `commentSoonTick` still considers a video its own — past this, a
 * video is `retryPendingComments`'s to catch on the nightly tick, so a restart or an old stuck
 * record does not make every 15-minute tick re-list the whole channel's history. */
const COMMENT_SOON_WINDOW_MS = 2 * 3600_000;

/** The jittered delay range `commentSoonTick` posts within: 5-20 minutes after `publishAt`. */
const COMMENT_SOON_MIN_MS = 5 * 60_000;
const COMMENT_SOON_RANGE_MS = 15 * 60_000;

/**
 * How long after `publishAt` this video's comment goes up — 5 to 20 minutes, derived from the
 * video id so every video does not land in the same minute of its own hour (ponytail: a simple
 * string hash, not a CSPRNG — nothing here is adversarial, it only has to not be a constant).
 */
function commentSoonDelayMs(videoId: string): number {
  let hash = 0;
  for (let i = 0; i < videoId.length; i++) hash = (hash * 31 + videoId.charCodeAt(i)) >>> 0;
  return COMMENT_SOON_MIN_MS + (hash % COMMENT_SOON_RANGE_MS);
}

/**
 * With `config.commentSoonAfterPublish` on, posts a scheduled video's first comment within
 * minutes of it actually going public, rather than waiting for `retryPendingComments`'s once-a-
 * night tick hours later — the gap between "video goes public at 19:00" and "first comment at
 * 03:00" was one of the clearest machine-made tells a viewer could catch (packaging diagnosis,
 * 6 Oct 2026). Same comment, same `finishOnYouTube` step, same once-only guards (a channel
 * comment already there, a still-private video skipped) — only the schedule moves earlier.
 *
 * Checked by the 15-minute tick that already drives `shortTick` (src/dashboard/server.ts), so a
 * video crosses its delay within one tick of it elapsing. `maxPerTick` keeps a quiet night from
 * spending more than one `finishOnYouTube` call per tick even if several videos are due at once;
 * anything it does not reach this tick is simply due again next tick, or caught by the nightly's
 * own sweep regardless.
 *
 * Off (the default), this reads nothing and calls nothing — `retryPendingComments`'s nightly tick
 * is the only thing that ever posts this comment, exactly as before this existed.
 */
export async function commentSoonTick(
  finish: typeof finishOnYouTube = finishOnYouTube,
  maxPerTick = 1,
  nowMs = Date.now(),
): Promise<void> {
  if (!config.commentSoonAfterPublish) return;
  const byVideo = await pendingComments();
  let attempted = 0;
  for (const [videoId, v] of byVideo) {
    if (attempted >= maxPerTick) break;
    if (v.done || v.publishAt === null) continue;
    const publishMs = Date.parse(v.publishAt);
    if (Number.isNaN(publishMs)) continue;
    const since = nowMs - publishMs;
    if (since < 0 || since > COMMENT_SOON_WINDOW_MS || since < commentSoonDelayMs(videoId)) continue;
    attempted++;
    const { comment } = await finish(v.matchId, videoId, "video");
    console.error(
      `comment: #${v.matchId} ${comment === null ? "done" : (comment ?? "private")} (soon after publish)`,
    );
  }
}
