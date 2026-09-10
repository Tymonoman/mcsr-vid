// Self-check for youtubeUpload.ts: the three pieces that decide what reaches the live channel.
// Nothing here touches the network or the real media directory.
// Run: npx tsx src/youtubeUpload.test.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { beginUpload, nightlyUploads, playlistTitlesFor } from "./youtubeUpload.js";
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
  // stays without one for good.
  assert.ok(playlistTitlesFor(match, "video").every(([, d]) => d.length > 0));

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
  const playoffTitles = playlistTitlesFor(match, "video", { season: 11 }).map(([t]) => t);
  assert.ok(playoffTitles.includes("MCSR Ranked Season 11 Playoffs · Replayoffs"));
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

  console.log("OK: playlists, the videoPath guard and the nightly's clause");

  /* --- Finishing twice ----------------------------------------------------------------------- */
  // "Finish on YouTube" is on every published match and the channel scan can run it by itself, so
  // it must be free to press again. A second comment and a second playlist join are writes to the
  // live channel that only manual Studio cleanup undoes — `postComment` de-duplicates nothing and
  // `addToPlaylist` documents that it never has to. Counted at the wire, so a step that is skipped
  // is proven to have spent nothing.

  const tokenFile = path.join(media, "token.json");
  await writeFile(tokenFile, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }));
  process.env.YOUTUBE_TOKEN_FILE = tokenFile;

  const hits: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    hits.push(`${init?.method ?? "GET"} ${url}`);
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
    finished: { thumbnail: null, playlists: null, comment: null },
  });
  hits.length = 0;
  const again = await finishOnYouTube(matchId, "vidX");
  assert.deepEqual(again, { thumbnail: null, playlists: null, comment: null });
  assert.deepEqual(
    hits.filter((h) => h.includes("googleapis.com/youtube")),
    [],
    "a finished match must not be commented on or playlisted a second time",
  );

  // A step that failed last time is the one thing a second press is for.
  await writeUpload(matchId, {
    ...record,
    finished: { thumbnail: null, playlists: '"Season 11": quota', comment: null },
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
  await writeUpload(matchId, { ...record, privacyStatus: "private", finished: { playlists: null } });
  hits.length = 0;
  const priv = await finishOnYouTube(matchId, "vidX");
  assert.equal("comment" in priv && priv.comment !== undefined, false, "no comment on a private video");
  assert.ok(!hits.some((h) => h.includes("/commentThreads?")));

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

  globalThis.fetch = realFetch;
  console.log("OK: finishing an already-finished video calls nothing");
  console.log("OK: a video uploaded elsewhere keeps the thumbnail it is wearing");
} finally {
  config.mediaDir = mediaDir;
  config.youtubePlaylistTitle = playlistTitle;
  config.youtubeUploadEnabled = uploadEnabled;
  config.nightlyUpload = nightly;
  await rm(media, { recursive: true, force: true });
}
