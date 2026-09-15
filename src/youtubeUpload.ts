/**
 * What an upload does, from the files on disk to the finished video on the channel.
 *
 * Shared by the route (src/youtubeRoutes.ts), the nightly (src/nightly.ts) and the channel scan
 * (src/channelUploads.ts, for a Studio upload it pairs), so the three cannot drift on what gets
 * refused, what gets sent, or what happens after the insert. Nothing here calls `videos.insert`
 * while `youtubeUploadEnabled` is off — see src/config.ts and CLAUDE.md.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { archiveMatch } from "./archive.js";
import type { ChannelVideo } from "./channelUploads.js";
import { config, matchDir } from "./config.js";
import { describeError } from "./errorText.js";
import { matchStatusFor } from "./matchStatus.js";
import { playoffContextForId } from "./playoffs.js";
import { nextPublishSlot } from "./publishSlot.js";
import { readManifest } from "./thumbnailVariants.js";
import { HOOK_PLACEHOLDER } from "./title.js";
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

/** The long-form and the Short of one match can be in flight together (the nightly runs them back to back). */
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
const UPLOADS_OFF = "uploads go through Studio until the API compliance audit clears";

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
 * Everything an upload is, minus the HTTP: the route answers 202 with `progress` and lets the
 * browser poll it, the nightly awaits `finished`. One place, so the two cannot drift on what
 * gets refused, what gets sent, or what happens after the insert.
 *
 * Title, description and tags come off the match's files (`uploadTextFor`), not the request:
 * the dashboard's title editor already writes the `.edited.txt` the publish kit pastes from, and
 * a second copy of the text in a form was how a title picked up a stray newline.
 */
export async function beginUpload(matchId: number, req: UploadRequest): Promise<Begun> {
  if (!config.youtubeUploadEnabled) return { status: 403, error: UPLOADS_OFF };
  const key = progressKey(matchId, req.kind);
  const running = uploads.get(key);
  if (running && !running.done)
    return { status: 409, error: `Match ${matchId} is already uploading its ${req.kind}` };

  const dir = path.resolve(matchDir(matchId));
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

  const manifest = await readManifest(dir);
  const progress = idle(matchId, req.kind);
  uploads.set(key, progress);

  const finished = (async () => {
    try {
      const result = await uploadVideo({
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
        },
      });
      progress.videoId = result.videoId;
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
      // The video is up; what follows is worth reporting but must not read as a failed upload.
      const steps = await finishOnYouTube(matchId, result.videoId, req.kind);
      // Only the steps that actually failed: `null` is done and an absent step was never
      // attempted (a Short's thumbnail, a private video's comment), neither of which is a problem.
      progress.warnings = Object.entries(steps)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .map(([step, error]) => `Uploaded, but the ${step} step failed: ${error}`);
      // Published is the point the match is finished with, so it is the point worth backing up.
      // Fire-and-forget (see archiveMatch's note); failures land in the server log and in
      // GET /api/capacity, not here — a NAS blip must not read as a failed upload.
      if (req.kind === "video") archiveMatch(matchId);
    } catch (err) {
      progress.error = describeError(err);
    } finally {
      progress.done = true;
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
    const playlistErrors: string[] = [];
    for (const [title, description] of playlistTitlesFor(status, kind, playoff)) {
      const error = await attempt(() => addToPlaylist(videoId, title, description));
      if (error) playlistErrors.push(`"${title}": ${error}`);
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
 * match, the first time the pairing is seen (src/channelUploads.ts).
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
  // (src/archive.ts), so a first scan pairing a dozen does not storm it.
  archiveMatch(matchId);
  if (config.youtubeAutoFinish) await finishOnYouTube(matchId, video.videoId);
}

/**
 * The nightly's uploads of the MP4 it just exported and the Short, as the clause its notification
 * gains. Nothing unless `youtubeUploadEnabled` and `nightlyUpload` both say so (src/config.ts).
 * Private either way; "scheduled" sets the next publish slot on the long-form and 18 h later on
 * the Short, so the Short lands while the long-form is still fresh in Browse. A refusal (a title
 * still carrying `<HOOK>`, no Short on disk) is a skip line, not a failure. `begin` is the test's
 * seam, as `chainShort`'s `run` is.
 */
export async function nightlyUploads(
  matchId: number,
  begin: typeof beginUpload = beginUpload,
): Promise<string> {
  if (!config.youtubeUploadEnabled || config.nightlyUpload === "off") return "";
  const slot =
    config.nightlyUpload === "scheduled" ? nextPublishSlot(Date.now(), config.publishHourUtc) : null;
  const one = async (kind: UploadKind, publishAt: Date | null): Promise<string> => {
    const begun = await begin(matchId, {
      kind,
      privacyStatus: "private",
      publishAt: publishAt?.toISOString(),
    });
    if ("error" in begun) return ` + ${kind} upload skipped: ${begun.error.slice(0, 120)}`;
    const done = await begun.finished;
    if (done.error) return ` + ${kind} upload failed: ${done.error.slice(0, 120)}`;
    const when = publishAt ? `scheduled ${publishAt.toISOString()}` : "private";
    return ` + ${kind} uploaded ${done.videoId} (${when}${done.warnings.length ? ", with a problem" : ""})`;
  };
  const video = await one("video", slot);
  // No Short without its long-form: the Short's job is to send viewers to the match.
  if (!video.includes(" uploaded ")) return video;
  return video + (await one("short", slot ? new Date(slot.getTime() + 18 * 3600_000) : null));
}
