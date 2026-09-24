// Self-check for youtubeUpload.ts: the three pieces that decide what reaches the live channel.
// Nothing here touches the network or the real media directory.
// Run: npx tsx src/youtubeUpload.test.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import {
  beginUpload,
  explainUploadError,
  playlistTitlesFor,
  retryFailedPlaylists,
  SHORT_DELAY_MS,
} from "./youtubeUpload.js";
import { readShortLog, stepActivity } from "../shorts/shortLog.js";
import { staleExportMessage, writeSyncOffsets } from "../pipeline/syncFile.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-upload-test-"));
/** A publish time always ahead of the clock: 2 January next year, 13:00 UTC. */
const LATER = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 2, 13)).toISOString();
const LATER_UTC = `${LATER.slice(0, 16).replace("T", " ")} UTC`;
const mediaDir = config.mediaDir;
const playlistTitle = config.youtubePlaylistTitle;
const uploadEnabled = config.youtubeUploadEnabled;
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
    "MCSR Ranked Season 11 Playoffs — every series as one video, both streams side by side, in bracket order.",
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

  /* --- Nothing goes up before the hooks are saved (23 Sept 2026) ----------------------------- */
  // The generated title carries the pipeline's first chip, which used to be enough: now the
  // operator's saved title hook (the edited title) is what lets the long-form through.
  const titleEdited = path.join(dir, `match-${matchId}.title.edited.txt`);
  const noHook = await beginUpload(matchId, { kind: "video", privacyStatus: "private" });
  assert.ok("error" in noHook && noHook.status === 409 && /no saved title hook/.test(noHook.error));
  await writeFile(titleEdited, "<HOOK> | a vs b | MCSR Ranked 1v1\n");
  const placeholder = await beginUpload(matchId, { kind: "video", privacyStatus: "private" });
  assert.ok(
    "error" in placeholder && placeholder.status === 400 && /<HOOK>/.test(placeholder.error),
    "a placeholder is no hook",
  );
  await writeFile(titleEdited, "A hook | a vs b | MCSR Ranked 1v1\n");

  // The Short: its confirmed hook, burned into the file being sent, and only once.
  const shortHookPath = path.join(dir, `short-${matchId}.hook.txt`);
  const cutPath = path.join(dir, `short-${matchId}.cut.json`);
  const cutWith = (hook: string) =>
    writeFile(
      cutPath,
      JSON.stringify({
        gameMatchId: matchId,
        startMs: 0,
        endMs: 20000,
        pov: "both",
        hook,
        pickCreatedAt: "t",
        renderedAt: "t",
      }),
    );
  const noShortHook = await beginUpload(matchId, { kind: "short", privacyStatus: "private" });
  assert.ok("error" in noShortHook && /waiting for the Short's hook/.test(noShortHook.error));
  await writeFile(shortHookPath, "Down to the last heart\n");
  await cutWith("An older line");
  const oldCut = await beginUpload(matchId, { kind: "short", privacyStatus: "private" });
  assert.ok(
    "error" in oldCut && /cut behind another hook/.test(oldCut.error),
    "a Short cut behind another hook",
  );
  await cutWith("Down to the last heart");
  await writeFile(path.join(dir, "youtube-short.json"), JSON.stringify({ videoId: "vidS" }));
  const shortTwice = await beginUpload(matchId, { kind: "short", privacyStatus: "private" });
  assert.ok("error" in shortTwice && /already on the channel/.test(shortTwice.error), "a Short goes up once");
  await rm(path.join(dir, "youtube-short.json"));
  console.log("OK: no upload without its saved hook, no Short behind another hook, no Short twice");
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

  // The Short's delay is the chain's one constant (src/dashboard/shortFlow.ts `shortPublishAt`).
  assert.equal(SHORT_DELAY_MS, 18 * 3600_000);

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

  // `send` is videos.insert: what goes to it, and the record written from its answer. A Short, so
  // no archive copy starts (a long-form's would rsync this directory to the NAS).
  {
    const file = path.join(dir, `short-${matchId}.mp4`);
    await writeFile(file, "x");
    config.youtubeUploadEnabled = true;
    const sent: Array<{ title: string; publishAt?: string }> = [];
    const begun = await beginUpload(
      matchId,
      { kind: "short", privacyStatus: "private", publishAt: LATER },
      async (args) => {
        sent.push({ title: args.title, publishAt: args.publishAt });
        return { videoId: "vidNew", publishAt: args.publishAt ?? null, privacyStatus: "private" };
      },
    );
    assert.ok(!("error" in begun), `the saved hook's cut goes up: ${JSON.stringify(begun)}`);
    const done = await begun.finished;
    assert.equal(done.error, null);
    assert.deepEqual(sent, [{ title: "A hook #minecraft #mcsr", publishAt: LATER }]);
    const { readUpload } = await import("./youtubeStore.js");
    assert.equal((await readUpload(matchId, "short"))?.publishAt, LATER);
    const again = await beginUpload(matchId, { kind: "short", privacyStatus: "private" }, async () => {
      throw new Error("sent twice");
    });
    assert.ok("error" in again, "and a Short that is up is not sent again");
    await rm(file);
    await rm(path.join(dir, "youtube-short.json"));
    console.log("OK: the send seam gets the Short's title and time, once");
  }

  // The Short log: each upload's start, its progress as the activity's percent, its end — and a
  // refusal. YouTube's failures in words, with Google's own text as the detail.
  {
    const log = () => readShortLog(matchId, 500).filter((l) => l.step === "upload-short");
    const file = path.join(dir, `short-${matchId}.mp4`);
    await writeFile(file, "x");
    let midway: number | undefined;
    const begun = await beginUpload(
      matchId,
      { kind: "short", privacyStatus: "private", publishAt: LATER },
      async (args) => {
        args.onProgress?.(50, 100);
        midway = stepActivity(matchId, "upload-short")?.percent;
        return { videoId: "vidLog", publishAt: args.publishAt ?? null, privacyStatus: "private" };
      },
    );
    assert.ok(!("error" in begun));
    await begun.finished;
    assert.equal(midway, 50, "the live percent while the bytes go up");
    assert.equal(stepActivity(matchId, "upload-short"), undefined, "and no activity once it is done");
    assert.deepEqual(
      log()
        .slice(-3)
        .map((l) => l.text),
      [
        `uploading the Short (0 MB, private, public at ${LATER_UTC})`,
        `uploading the Short (0 MB, private, public at ${LATER_UTC}) · 50%`,
        `the Short is up: https://youtu.be/vidLog — public at ${LATER_UTC}`,
      ],
    );
    const twice = await beginUpload(matchId, { kind: "short", privacyStatus: "private" });
    assert.ok("error" in twice);
    assert.deepEqual(
      [log().at(-1)!.level, log().at(-1)!.text],
      ["error", `upload refused: the Short of match ${matchId} is already on the channel`],
    );
    await rm(path.join(dir, "youtube-short.json"));

    // A publish time already gone: refused before a byte is sent.
    const late = await beginUpload(matchId, {
      kind: "short",
      privacyStatus: "private",
      publishAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.ok("error" in late && late.status === 400 && /has already passed/.test(late.error));

    // YouTube's quota: the words and the wait, Google's text as the detail.
    const quota = await beginUpload(matchId, { kind: "short", privacyStatus: "private" }, async () => {
      throw new Error(
        "YouTube API videos.insert (start) -> 403 Forbidden: The request cannot be completed because you have exceeded your quota. (quotaExceeded)",
      );
    });
    assert.ok(!("error" in quota));
    const failed = await quota.finished;
    assert.match(String(failed.error), /^YouTube's daily API quota is used up .* resets at midnight Pacific/);
    assert.equal(log().at(-1)!.level, "error");
    assert.match(log().at(-1)!.detail ?? "", /quotaExceeded/);
    await rm(file);
    console.log("OK: an upload logs its start, its quarters, its end or its refusal; a past time is refused");
  }

  {
    const cases: Array<[string, RegExp]> = [
      [
        'YouTube token refresh failed: 400 Bad Request. { "error": "invalid_grant", "error_description": "Token has been expired or revoked." }',
        /^the YouTube sign-in expired or was revoked \(invalid_grant\) — run npm run youtube-auth/,
      ],
      [
        "No YouTube credentials at /app/youtube-token.json. Run `npm run youtube-auth`",
        /^no YouTube sign-in on the lab/,
      ],
      ["YouTube API videos.insert (start) -> 403 Forbidden: x (quotaExceeded)", /daily API quota is used up/],
      ["YouTube API videos.insert (start) -> 400 Bad Request: x (uploadLimitExceeded)", /daily upload limit/],
      [
        "YouTube API videos.insert (chunk) -> 400 Bad Request: The request metadata specifies an invalid scheduled publishing time. (invalidPublishAt)",
        /^YouTube refused the publish time/,
      ],
      [
        "YouTube API videos.insert (start) -> 401 Unauthorized: Invalid Credentials",
        /refused the access token/,
      ],
      [
        "YouTube API videos.insert (chunk) -> 503 Service Unavailable: backend error",
        /could not be reached or failed mid-upload/,
      ],
      ["fetch failed", /could not be reached/],
      [
        "YouTube API videos.insert (start) -> 400 Bad Request: x (invalidTitle)",
        /^YouTube refused the upload \(.*\(invalidTitle\)\) — fix what it names/,
      ],
      ["/media/1/short-1.mp4 is empty", /^\/media\/1\/short-1\.mp4 is empty$/],
    ];
    for (const [raw, message] of cases) assert.match(explainUploadError(raw), message, raw);
    console.log(
      "OK: YouTube's failures — the sign-in, the quota, the limit, the time, the network — in words",
    );
  }
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

  // The nightly's retry presses only the records whose playlist step failed — any string, the
  // cap's line included — and leaves a clean (null) or never-attempted (absent) one alone.
  await writeUpload(matchId, { ...record, finished: { playlists: `"x": ${"cap"}`, thumbnail: null } });
  await writeUpload(matchId, { ...record, finished: { playlists: null } }, "short");
  const pressed: string[] = [];
  await retryFailedPlaylists(async (id, videoId, kind) => {
    pressed.push(`${id}/${kind}/${videoId}`);
    return { playlists: null };
  });
  assert.deepEqual(pressed, [`${matchId}/video/vidX`], "only the failed step is pressed again");

  globalThis.fetch = realFetch;
  console.log("OK: the tags step adds what is missing without blanking the snippet");
  console.log("OK: finishing an already-finished video calls nothing");
  console.log("OK: a video uploaded elsewhere keeps the thumbnail it is wearing");
} finally {
  config.mediaDir = mediaDir;
  config.youtubePlaylistTitle = playlistTitle;
  config.youtubeUploadEnabled = uploadEnabled;
  await rm(media, { recursive: true, force: true });
}
