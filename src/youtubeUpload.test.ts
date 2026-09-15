// Self-check for youtubeUpload.ts: the three pieces that decide what reaches the live channel.
// Nothing here touches the network or the real media directory.
// Run: npx tsx src/youtubeUpload.test.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import {
  beginUpload,
  nightlyUploads,
  playlistTitlesFor,
  SHORT_DELAY_MS,
  shortAfterUpload,
} from "./youtubeUpload.js";
import { staleExportMessage, writeSyncOffsets } from "./syncFile.js";
import type { UploadProgress } from "./youtubeUpload.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-upload-test-"));
const mediaDir = config.mediaDir;
const playlistTitle = config.youtubePlaylistTitle;
const uploadEnabled = config.youtubeUploadEnabled;
const nightly = config.nightlyUpload;
config.mediaDir = media;
config.youtubePlaylistTitle = "MCSR Replayoffs · Season 11";

try {
  /* --- Which playlists a video joins -------------------------------------------------------- */
  // Every one of these is a public, hand-undoable write. The two branches that must NOT create a
  // playlist are the ones nothing else guards.

  const match = { leftNickname: "doogile", rightNickname: "Feinberg" };
  const titles = playlistTitlesFor(match, "video").map(([t]) => t);
  assert.equal(titles.length, 4, "season, matchup, and one per player");
  assert.equal(titles[0], "MCSR Replayoffs · Season 11");
  assert.ok(titles.includes("doogile vs Feinberg · MCSR Ranked"));
  assert.ok(titles.includes("doogile · MCSR Ranked matches"));
  assert.ok(titles.includes("Feinberg · MCSR Ranked matches"));
  // Every entry carries a description: it is set at creation, and a playlist created without one
  // stays without one for good. Pinned word for word — this is public copy on the channel, in the
  // same plain voice as the video description, with no subscribe ask and no pipeline talk.
  assert.deepEqual(
    playlistTitlesFor(match, "video").map(([, d]) => d),
    [
      "Every MCSR Ranked 1v1 on the channel, oldest first. Both players' streams side by side with the split timer between them.",
      "doogile vs Feinberg: every match between them on the channel, oldest first.",
      "doogile's MCSR Ranked matches on the channel, oldest first.",
      "Feinberg's MCSR Ranked matches on the channel, oldest first.",
    ],
  );

  // A Short is a pointer at the long-form, not a second entry in the series.
  assert.deepEqual(
    playlistTitlesFor(match, "short").map(([t]) => t),
    ["MCSR Replayoffs · Season 11"],
  );

  // "?" is what matchStatusFor degrades to with the MCSR API down. A public playlist called
  // "? vs ?" cannot be quietly re-done later, so it must never be created.
  assert.deepEqual(
    playlistTitlesFor({ leftNickname: "?", rightNickname: "Feinberg" }, "video").map(([t]) => t),
    ["MCSR Replayoffs · Season 11"],
  );
  assert.deepEqual(
    playlistTitlesFor({ leftNickname: "doogile", rightNickname: "?" }, "video").map(([t]) => t),
    ["MCSR Replayoffs · Season 11"],
  );

  // A playoff game takes the tournament's playlist in place of the matchup's: the bracket is the
  // series, and the same pair's ranked games have no business in it. The per-player ones stay.
  const playoffLists = playlistTitlesFor(match, "video", { season: 11 });
  const playoffTitles = playoffLists.map(([t]) => t);
  assert.ok(playoffTitles.includes("MCSR Ranked Season 11 Playoffs · Replayoffs"));
  assert.equal(
    playoffLists.find(([t]) => t.includes("Playoffs"))?.[1],
    "MCSR Ranked Season 11 Playoffs, game by game in bracket order.",
  );
  assert.ok(!playoffTitles.includes("doogile vs Feinberg · MCSR Ranked"), "not both");
  assert.equal(playoffTitles.length, 4);
  // A Short of a playoff game is still season-only.
  assert.deepEqual(
    playlistTitlesFor(match, "short", { season: 11 }).map(([t]) => t),
    ["MCSR Replayoffs · Season 11"],
  );

  // No season playlist configured turns the step off rather than creating one called "".
  config.youtubePlaylistTitle = "";
  assert.deepEqual(playlistTitlesFor(match, "short"), []);
  config.youtubePlaylistTitle = "MCSR Replayoffs · Season 11";

  /* --- The videoPath escape hatch ------------------------------------------------------------ */
  // A trust boundary: the request names a file the server then reads and publishes. Anything
  // outside the match's own directory must be refused before a byte is read.

  const matchId = 12345678;
  const dir = path.join(media, String(matchId));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `match-${matchId}.title.txt`), "A hook | a vs b | MCSR Ranked 1v1\n");

  config.youtubeUploadEnabled = true;
  const tryPath = async (videoPath: string) => {
    const begun = await beginUpload(matchId, { kind: "video", privacyStatus: "private", videoPath });
    assert.ok("error" in begun, `${videoPath} should have been refused`);
    return begun;
  };

  const outside = await tryPath(path.join(media, "elsewhere.mp4"));
  assert.equal(outside.status, 400);
  assert.match(outside.error, /must be inside/);
  // ..-traversal out of the match directory, which `startsWith` on the raw string would let past.
  const traversal = await tryPath(path.join(dir, "..", "99999999", "final.mp4"));
  assert.match(traversal.error, /must be inside/);
  // A prefix of the directory name is not the directory: `<media>/12345678-old` is another match.
  const sibling = await tryPath(`${dir}-old${path.sep}final.mp4`);
  assert.match(sibling.error, /must be inside/);
  // And a path that IS inside gets past the guard, reaching the ordinary "no such file".
  const inside = await tryPath(path.join(dir, "final.mp4"));
  assert.match(inside.error, /No such video file/);

  /* --- An export older than its sync.json ---------------------------------------------------- */
  // One video reached the channel out of sync because the offsets were corrected by hand after
  // the MP4 was exported and nobody re-exported. The export file is empty so that a request the
  // guard lets through fails at `uploadVideo`'s first line, before any token or network — which
  // is how "not refused" is told apart from "refused" without uploading anything.
  const exportFile = path.join(dir, `final-${matchId}.mp4`);
  const shortFile = path.join(dir, `short-${matchId}.mp4`);
  await writeFile(exportFile, "");
  await writeFile(shortFile, "");
  await writeFile(path.join(dir, `short-${matchId}.title.txt`), "A hook #minecraft #mcsr\n");
  const stamp = (file: string, iso: string) => utimes(file, new Date(iso), new Date(iso));
  await stamp(exportFile, "2026-09-10T12:00:00Z");
  await stamp(shortFile, "2026-09-10T12:00:00Z");
  writeSyncOffsets(dir, { left: 150, right: 150, confidence: 1, detail: "", source: "manual" });
  await stamp(path.join(dir, "sync.json"), "2026-09-10T13:00:00Z");

  const staleVideo = await beginUpload(matchId, {
    kind: "video",
    privacyStatus: "private",
    videoPath: exportFile,
  });
  assert.ok("error" in staleVideo, "a stale export is refused");
  assert.equal(staleVideo.status, 400);
  assert.equal(staleVideo.error, staleExportMessage(matchId), "with the exact re-export line");

  // The Short is cut from the VODs with sync.json directly, so the same clock says nothing about it.
  const staleShort = await beginUpload(matchId, { kind: "short", privacyStatus: "private" });
  assert.ok(!("error" in staleShort), "the Short is not held by the video's staleness");
  assert.match(String((await staleShort.finished).error), /is empty/, "and got as far as the file");

  // Re-exported: the file is newer than the correction, and the guard steps aside.
  await stamp(exportFile, "2026-09-10T14:00:00Z");
  const freshVideo = await beginUpload(matchId, {
    kind: "video",
    privacyStatus: "private",
    videoPath: exportFile,
  });
  assert.ok(!("error" in freshVideo), "a fresh export is not refused");
  assert.match(String((await freshVideo.finished).error), /is empty/);

  await rm(exportFile);
  await rm(shortFile);
  await rm(path.join(dir, "sync.json"));
  console.log("OK: a video whose sync.json is newer than its export is refused; a Short never is");

  // The gate itself: off, nothing is even looked at.
  config.youtubeUploadEnabled = false;
  const gated = await beginUpload(matchId, { kind: "video", privacyStatus: "private" });
  assert.ok("error" in gated && gated.status === 403 && /Studio/.test(gated.error));

  /* --- The nightly's clause ------------------------------------------------------------------ */
  // What the 3 a.m. push actually says, and the order it does things in. The uploader is injected
  // so this exercises the assembly and never the API.

  const asked: Array<{ kind: string; publishAt?: string; privacyStatus: string }> = [];
  const fake = (
    result: (kind: string) => { videoId: string | null; error: string | null; warnings: string[] },
  ) =>
    (async (id: number, req: { kind: string; privacyStatus: string; publishAt?: string }) => {
      asked.push({ kind: req.kind, privacyStatus: req.privacyStatus, publishAt: req.publishAt });
      const r = result(req.kind);
      const progress = {
        matchId: id,
        kind: req.kind,
        uploaded: 0,
        total: 0,
        done: true,
        ...r,
      } as unknown as UploadProgress;
      return { progress, finished: Promise.resolve(progress) };
    }) as unknown as typeof beginUpload;

  const both = () => ({ videoId: "vidX", error: null, warnings: [] });

  // Off on either switch is silence, not a skip line: the operator has not asked for uploads.
  config.youtubeUploadEnabled = false;
  config.nightlyUpload = "private";
  assert.equal(await nightlyUploads(matchId, fake(both)), "");
  config.youtubeUploadEnabled = true;
  config.nightlyUpload = "off";
  assert.equal(await nightlyUploads(matchId, fake(both)), "");

  config.nightlyUpload = "private";
  asked.length = 0;
  const clause = await nightlyUploads(matchId, fake(both));
  assert.match(clause, /\+ video uploaded vidX \(private\)/);
  assert.match(clause, /\+ short uploaded vidX \(private\)/);
  assert.deepEqual(
    asked.map((a) => a.kind),
    ["video", "short"],
    "long-form first",
  );
  assert.ok(
    asked.every((a) => a.privacyStatus === "private" && a.publishAt === undefined),
    '"private" schedules nothing',
  );

  // A post-insert problem is reported, but the video is still up: never "failed".
  const warned = await nightlyUploads(
    matchId,
    fake((kind) => ({
      videoId: "vidX",
      error: null,
      warnings: kind === "video" ? ["thumbnail rejected"] : [],
    })),
  );
  assert.match(warned, /video uploaded vidX \(private, with a problem\)/);
  assert.doesNotMatch(warned, /video upload failed/);

  // No Short without its long-form — the Short's whole job is to send viewers to the match.
  asked.length = 0;
  const failed = await nightlyUploads(
    matchId,
    fake((kind) => ({
      videoId: kind === "video" ? null : "vidS",
      error: kind === "video" ? "network went away" : null,
      warnings: [],
    })),
  );
  assert.match(failed, /video upload failed: network went away/);
  assert.doesNotMatch(failed, /short/);
  assert.deepEqual(
    asked.map((a) => a.kind),
    ["video"],
    "the Short is not attempted",
  );

  // "scheduled": the long-form takes the next slot and the Short lands 18h later, while the
  // long-form is still fresh in Browse.
  config.nightlyUpload = "scheduled";
  asked.length = 0;
  await nightlyUploads(matchId, fake(both));
  const [video, short] = asked;
  assert.ok(video?.publishAt && short?.publishAt, "both are scheduled");
  assert.equal(
    Date.parse(short.publishAt) - Date.parse(video.publishAt),
    18 * 3600_000,
    "the Short is 18h after the match video",
  );
  assert.equal(SHORT_DELAY_MS, 18 * 3600_000, "and that is the one constant the dashboard's chain shares");

  // A stale export is a skip line the operator can act on, and the Short stays home with it.
  asked.length = 0;
  const stale = await nightlyUploads(matchId, (async () => ({
    status: 400,
    error: staleExportMessage(matchId),
  })) as unknown as typeof beginUpload);
  assert.equal(
    stale,
    ` + video upload skipped: sync changed after this export — re-export first (npm run export:fast -- ${matchId})`,
  );

  console.log("OK: playlists, the videoPath guard and the nightly's clause");

  /* --- The Short that follows a dashboard upload --------------------------------------------- */
  // The nightly sends both; the operator's press sent only the long-form and the Short waited for
  // a second press that was easy to forget. Same visibility, the same 18 h after the video's
  // publish time, and one line into the video's warnings saying what became of it.

  asked.length = 0;
  const followed = await shortAfterUpload(
    matchId,
    { privacyStatus: "unlisted", publishAt: "2026-09-16T19:00:00.000Z" },
    fake(() => ({ videoId: "vidS", error: null, warnings: [] })),
  );
  assert.deepEqual(asked, [
    { kind: "short", privacyStatus: "unlisted", publishAt: "2026-09-17T13:00:00.000Z" },
  ]);
  assert.equal(followed, "short uploaded vidS (scheduled 2026-09-17T13:00:00.000Z)");

  // No publish time on the video: none on the Short either, it is simply as private as the video.
  asked.length = 0;
  const unscheduled = await shortAfterUpload(
    matchId,
    { privacyStatus: "private", publishAt: null },
    fake(() => ({ videoId: "vidS", error: null, warnings: [] })),
  );
  assert.equal(asked[0]?.publishAt, undefined);
  assert.equal(unscheduled, "short uploaded vidS (private)");

  // beginUpload's refusal (no short-<id>.mp4, say) is the reason, not a failure.
  const noFile = await shortAfterUpload(
    matchId,
    { privacyStatus: "private", publishAt: null },
    (async () => ({
      status: 400,
      error: `No such video file: ${dir}/short-${matchId}.mp4`,
    })) as unknown as typeof beginUpload,
  );
  assert.match(noFile, /^short upload skipped: No such video file/);

  // A Short already on the channel is not sent twice: a duplicate is a Studio clean-up.
  const { writeUpload: writeRecord } = await import("./youtubeStore.js");
  await writeRecord(
    matchId,
    {
      videoId: "vidOld",
      uploadedAt: "2026-09-01T00:00:00Z",
      publishAt: null,
      privacyStatus: "private",
      thumbnailVariant: null,
      title: "t",
    },
    "short",
  );
  asked.length = 0;
  const already = await shortAfterUpload(
    matchId,
    { privacyStatus: "private", publishAt: null },
    fake(() => ({ videoId: "vidS", error: null, warnings: [] })),
  );
  assert.equal(already, "short upload skipped: already up as vidOld");
  assert.deepEqual(asked, [], "and beginUpload was not called");
  await rm(path.join(dir, "youtube-short.json"));
  console.log("OK: the Short follows a dashboard upload, once, at the same visibility, 18h later");

  /* --- Finishing twice ----------------------------------------------------------------------- */
  // "Finish on YouTube" is on every published match and the channel scan can run it by itself, so
  // it must be free to press again. A second comment and a second playlist join are writes to the
  // live channel that only manual Studio cleanup undoes — `postComment` de-duplicates nothing and
  // `addToPlaylist` documents that it never has to. Counted at the wire, so a step that is skipped
  // is proven to have spent nothing.

  const tokenFile = path.join(media, "token.json");
  await writeFile(tokenFile, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }));
  process.env.YOUTUBE_TOKEN_FILE = tokenFile;

  /** What YouTube says the video's privacy is *now*, which the record may disagree with. */
  let livePrivacy = "public";
  const hits: string[] = [];
  /** What was actually PUT/POSTed, so a replace-the-whole-snippet call can be inspected. */
  const sent: Array<{ url: string; body: unknown }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    hits.push(`${init?.method ?? "GET"} ${url}`);
    if (typeof init?.body === "string") {
      try {
        sent.push({ url, body: JSON.parse(init.body) });
      } catch {
        sent.push({ url, body: init.body });
      }
    }
    const body = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/"))
      return body({ access_token: "t", expires_in: 3600 });
    if (url.includes("mcsrranked.com"))
      return body({
        status: "success",
        data: { players: [{ nickname: "doogile" }, { nickname: "Feinberg" }] },
      });
    if (url.includes("/playlists?")) return body({ items: [{ id: "PL1", snippet: { title: "x" } }] });
    // The finish flow re-reads the live privacy before it skips the comment step.
    if (url.includes("/videos?part=snippet,status,statistics"))
      return body({
        items: [{ id: "vidX", snippet: { title: "t" }, status: { privacyStatus: livePrivacy } }],
      });
    // videos.update replaces the part it is given, so addTags reads the snippet before writing.
    if (url.includes("/videos?part=snippet&"))
      return body({
        items: [
          {
            id: "vidX",
            snippet: { title: "t", description: "d", categoryId: "20", tags: ["already-there"] },
          },
        ],
      });
    // The video is not in the playlist yet, so the join goes ahead.
    if (url.includes("/playlistItems?") && (init?.method ?? "GET") === "GET") return body({ items: [] });
    return body({ id: "ok" });
  }) as typeof fetch;

  const { finishOnYouTube } = await import("./youtubeUpload.js");
  const { writeUpload } = await import("./youtubeStore.js");
  const record = {
    videoId: "vidX",
    uploadedAt: "2026-09-08T19:00:00Z",
    publishAt: null,
    privacyStatus: "public",
    thumbnailVariant: null,
    title: "t",
  };

  // Everything already done: nothing is called again, and the record is unchanged.
  await writeUpload(matchId, {
    ...record,
    finished: { thumbnail: null, playlists: null, comment: null, tags: null },
  });
  hits.length = 0;
  const again = await finishOnYouTube(matchId, "vidX");
  assert.deepEqual(again, { thumbnail: null, playlists: null, comment: null, tags: null });
  assert.deepEqual(
    hits.filter((h) => h.includes("googleapis.com/youtube")),
    [],
    "a finished match must not be commented on or playlisted a second time",
  );

  // A step that failed last time is the one thing a second press is for.
  await writeUpload(matchId, {
    ...record,
    finished: { thumbnail: null, playlists: '"Season 11": quota', comment: null, tags: null },
  });
  hits.length = 0;
  const retried = await finishOnYouTube(matchId, "vidX");
  assert.equal(retried.playlists, null, "the failed step was retried and succeeded");
  assert.ok(
    hits.some((h) => h.startsWith("POST") && h.includes("/playlistItems?")),
    "and it actually called the API",
  );
  // A partial playlist failure is one string for four joins, so a retry re-runs all four —
  // which is only safe because `addToPlaylist` asks before it inserts.
  assert.ok(
    hits.some((h) => h.startsWith("GET") && h.includes("/playlistItems?")),
    "and asked whether the video was already in the playlist",
  );
  assert.ok(
    !hits.some((h) => h.includes("/commentThreads?")),
    "while the step that had succeeded stayed untouched",
  );

  // A private video — every nightly upload — cannot be commented on. Left unattempted rather than
  // recorded as an error, or every nightly push would read ", with a problem".
  livePrivacy = "private";
  await writeUpload(matchId, {
    ...record,
    privacyStatus: "private",
    finished: { playlists: null, tags: null },
  });
  hits.length = 0;
  const priv = await finishOnYouTube(matchId, "vidX");
  assert.equal("comment" in priv && priv.comment !== undefined, false, "no comment on a private video");
  assert.ok(!hits.some((h) => h.includes("/commentThreads?")));

  // ...but the record's privacy is whatever it was at upload and is never updated, so a draft
  // adopted while private and published an hour later would carry "private" for ever and never
  // get its first comment. The record is the cheap "not yet"; YouTube is what decides.
  livePrivacy = "public";
  await writeUpload(matchId, {
    ...record,
    privacyStatus: "private",
    finished: { playlists: null, tags: null },
  });
  hits.length = 0;
  const published = await finishOnYouTube(matchId, "vidX");
  assert.equal(published.comment, null, "a record that says private is re-checked against the live video");
  assert.ok(
    hits.some((h) => h.startsWith("POST") && h.includes("/commentThreads?")),
    "and the comment actually goes up once it really is public",
  );

  // A video uploaded elsewhere keeps the thumbnail it is wearing. "Finish on YouTube" is there to
  // give it the playlists and the comment it never got; the manifest's `chosen` is the renderer's
  // default unless somebody confirmed it here, and pushing that would replace a picture the
  // operator picked in Studio.
  await writeUpload(matchId, { ...record, source: "studio", finished: {} });
  hits.length = 0;
  const studio = await finishOnYouTube(matchId, "vidX");
  assert.match(String(studio.thumbnail), /left alone/, "the thumbnail step declines");
  assert.ok(!hits.some((h) => h.includes("/thumbnails/set")), "and no thumbnails.set request was made");
  assert.equal(studio.playlists, null, "while the playlists it came for still happen");

  // --- Tags: the manual paste that silently never happens ------------------------------------
  // Every video on the channel is missing tags, both nicknames included, because pasting them is
  // a separate step in Studio. `videos.update` is not `videos.insert`, so this is not gated by the
  // compliance audit — and the merge only adds, so a tag typed in Studio survives.
  await writeFile(path.join(dir, `match-${matchId}.tags.txt`), "doogile\nFeinberg\nalready-there\n");
  await writeUpload(matchId, {
    ...record,
    source: "studio",
    finished: { thumbnail: null, playlists: null, comment: null },
  });
  hits.length = 0;
  sent.length = 0;
  const tagged = await finishOnYouTube(matchId, "vidX");
  assert.equal(tagged.tags, null, "the tags step succeeds");
  const put = sent.find((r) => r.url.includes("/videos?part=snippet"));
  assert.ok(put, "videos.update was called");
  const snippet = (put!.body as { id: string; snippet: Record<string, unknown> }).snippet;
  assert.equal((put!.body as { id: string }).id, "vidX", "the body carries the video id");
  assert.deepEqual(
    snippet.tags,
    ["already-there", "doogile", "Feinberg"],
    "what the video had, then what it was missing -- and no duplicate",
  );
  // The whole snippet goes back or YouTube blanks what was left out. This is the assertion that
  // matters: a partial write here would wipe the description off a published video.
  assert.equal(snippet.title, "t", "the title survives the replace");
  assert.equal(snippet.description, "d", "and so does the description");
  assert.equal(snippet.categoryId, "20", "and the category");

  // Once recorded as done it is not written again -- a second press is for the steps that failed.
  hits.length = 0;
  const twice = await finishOnYouTube(matchId, "vidX");
  assert.equal(twice.tags, null);
  assert.ok(!hits.some((h) => h.includes("/videos?part=snippet")), "a second press writes nothing");

  // A Short carries its tags in its title; there is nothing to update and nothing to spend.
  await writeUpload(matchId, { ...record, finished: {} }, "short");
  hits.length = 0;
  const shortSteps = await finishOnYouTube(matchId, "vidX", "short");
  assert.equal(shortSteps.tags, null, "a Short's tags step is a no-op");
  assert.ok(!hits.some((h) => h.includes("/videos?part=snippet")), "and it calls nothing");

  globalThis.fetch = realFetch;
  console.log("OK: the tags step adds what is missing without blanking the snippet");
  console.log("OK: finishing an already-finished video calls nothing");
  console.log("OK: a video uploaded elsewhere keeps the thumbnail it is wearing");
} finally {
  config.mediaDir = mediaDir;
  config.youtubePlaylistTitle = playlistTitle;
  config.youtubeUploadEnabled = uploadEnabled;
  config.nightlyUpload = nightly;
  await rm(media, { recursive: true, force: true });
}
