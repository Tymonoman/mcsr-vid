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
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { listProcessedMatchIds, matchStatusFor } from "../dashboard/matchStatus.js";
import { playoffContextForId } from "../playoffs/playoffs.js";
import { exportStale, staleExportMessage } from "../pipeline/syncFile.js";
import { readManifest } from "../thumbnails/thumbnailVariants.js";
import { HOOK_PLACEHOLDER, metaPaths } from "../pipeline/title.js";
import { readShortCut, readShortHook, WAITING_FOR_HOOK } from "../shorts/shortHook.js";
import { activityProgress, boxFailure, endActivity, shortLog, startActivity } from "../shorts/shortLog.js";
import {
  addTags,
  addToPlaylist,
  matchupPlaylistDescription,
  matchupPlaylistTitle,
  playerPlaylistDescription,
  playerPlaylistTitle,
  playoffPlaylistDescription,
  playoffPlaylistTitle,
  postComment,
  SEASON_PLAYLIST_DESCRIPTION,
  setThumbnail,
  uploadVideo,
  videoStats,
} from "./youtube.js";
import {
  findExportedVideo,
  PINNED_COMMENT,
  allUploads,
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
  if (kind === "video") {
    const edited = await readFile(metaPaths(matchId, "title").edited, "utf8").catch(() => "");
    const line = edited.split("\n")[0]!.trim();
    if (line === "") return { status: 409, error: "no saved title hook — save the hooks first" };
    if (line.includes(HOOK_PLACEHOLDER))
      return { status: 400, error: `title still contains ${HOOK_PLACEHOLDER} — save the hooks first` };
    return null;
  }
  if (existsSync(path.join(dir, "youtube-short.json")))
    return { status: 409, error: `the Short of match ${matchId} is already on the channel` };
  const hook = await readShortHook(dir, matchId);
  if (hook === null) return { status: 409, error: `${WAITING_FOR_HOOK} — save the hooks first` };
  const cut = await readShortCut(dir, matchId);
  if (cut?.hook !== hook)
    return {
      status: 409,
      error: "the Short on disk was cut behind another hook — it re-renders before it uploads",
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
  if (text.description.length > 5000) return bad("description must be at most 5000 characters");
  if (text.tags.some((t) => t.length > 30) || text.tags.join(",").length > 500)
    return bad("tags: none over 30 characters, and at most 500 characters in all");

  let filePath: string;
  if (req.videoPath) {
    filePath = path.resolve(req.videoPath);
    if (!filePath.startsWith(dir + path.sep)) return bad(`videoPath must be inside ${dir}`);
  } else if (req.kind === "short") {
    filePath = path.join(dir, `short-${matchId}.mp4`);
  } else {
    const status = await matchStatusFor(matchId);
    const located = findExportedVideo(matchId, [status.leftNickname, status.rightNickname]);
    if ("error" in located) return bad(located.error);
    filePath = located.path;
  }
  if (!existsSync(filePath)) return bad(`No such video file: ${filePath}`);
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

  const manifest = await readManifest(dir);
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
        title: text.title,
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
 * A Short joins the season playlist only. The matchup playlist is for the long-form: a rematch is
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
  const { leftNickname: l, rightNickname: r } = match;
  const season: Array<[string, string]> = config.youtubePlaylistTitle
    ? [[config.youtubePlaylistTitle, SEASON_PLAYLIST_DESCRIPTION]]
    : [];
  if (kind === "short" || l === "?" || r === "?") return season;
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
 * What a video needs after it exists on the channel: the chosen thumbnail, its playlists, the
 * first comment and its tags. The same four steps for a dashboard upload and a Studio one, each reported
 * rather than thrown — the video is up, and a rejected thumbnail must not read as a failed
 * upload. Written into the record so the panel can say what is still missing. A Short gets the
 * season playlist only: no custom thumbnail (Shorts show a frame) and no comment.
 *
 * Idempotent through that record, which is why it is read first: a step that already answered
 * `null` is done and is skipped. Three of the four are writes to the live channel that only a
 * human in Studio can undo — `postComment` de-duplicates nothing, and `addToPlaylist` documents
 * that it never has to, because until this function existed it only ever ran on a video
 * `videos.insert` had returned seconds earlier. The button is on every published match and the
 * scan can auto-finish, so pressing it twice must be free.
 */
export async function finishOnYouTube(
  matchId: number,
  videoId: string,
  kind: UploadKind = "video",
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
  const status = await matchStatusFor(matchId);
  const manifest = await readManifest(dir);
  const thumb = path.join(
    dir,
    manifest?.variants.find((v) => v.key === manifest.chosen)?.file ?? "thumbnail.png",
  );
  const record = await readUpload(matchId, kind);
  const already = record?.finished ?? {};
  // A step is redone only if it has not already succeeded. `undefined` is "not attempted", so a
  // Short that later needs nothing, or a comment skipped while the video was private, is retried
  // — the same press that fixes a genuine failure.
  const todo = (step: keyof FinishedSteps): boolean => already[step] !== null;

  const finished: FinishedSteps = { ...already };

  if (todo("playlists")) {
    // A playoff game joins the tournament's playlist instead of the matchup's. Read here rather
    // than in `playlistTitlesFor` so that stays a pure function of what it is handed.
    const playoff = kind === "video" ? await playoffContextForId(matchId) : null;
    // A matchup playlist waits for the pair's second video: 22 of the channel's 28 playlists held
    // one video (the 22 Sept 2026 audit), each a `playlists.insert` against the day's cap of a
    // dozen. The earlier video is added alongside when the second arrives.
    const earlier = kind === "video" && !playoff ? await earlierVideoOfPair(matchId, status) : null;
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
    finished.thumbnail =
      kind === "short"
        ? null
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
        finished.comment = await attempt(() => postComment(videoId, PINNED_COMMENT));
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
  if (record) await writeUpload(matchId, { ...record, finished }, kind);
  return finished;
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
    publishAt: null,
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
