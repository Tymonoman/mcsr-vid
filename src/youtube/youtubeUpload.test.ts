// Self-check for youtubeUpload.ts: the three pieces that decide what reaches the live channel.
// Nothing here touches the network or the real media directory.
// Run: npx tsx src/youtubeUpload.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cacheMatch } from "../api/mcsrApi.js";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";
import type { UploadOptions, UploadResult } from "./youtube.js";
import {
  beginUpload,
  commentSoonTick,
  type finishOnYouTube,
  explainUploadError,
  playlistTitlesFor,
  resumeUpload,
  retryFailedPlaylists,
  retryPendingComments,
  retryPendingStudio,
  SHORT_DELAY_MS,
  uploadRunning,
} from "./youtubeUpload.js";
import { readShortLog, stepActivity } from "../shorts/shortLog.js";
import { staleExportMessage, writeSyncOffsets } from "../pipeline/syncFile.js";
import { startRerender, thumbJob } from "../thumbnails/rerender.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-upload-test-"));
/** A publish time always ahead of the clock: 2 January next year, 13:00 UTC. */
const LATER = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 2, 13)).toISOString();
const LATER_UTC = `${LATER.slice(0, 16).replace("T", " ")} UTC`;
const mediaDir = config.mediaDir;
const playlistTitle = config.youtubePlaylistTitle;
const uploadEnabled = config.youtubeUploadEnabled;
const commentSoonAfterPublish = config.commentSoonAfterPublish;
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

  // A Short joins no playlists: a pointer at the long-form, not an entry in a binge playlist.
  assert.deepEqual(
    playlistTitlesFor(match, "short").map(([t]) => t),
    [],
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
  // A Short of a playoff game joins none either.
  assert.deepEqual(
    playlistTitlesFor(match, "short", { season: 11 }).map(([t]) => t),
    [],
  );

  // No season playlist configured turns the step off rather than creating one called "".
  config.youtubePlaylistTitle = "";
  assert.deepEqual(playlistTitlesFor({ leftNickname: "?", rightNickname: "?" }, "video"), []);
  config.youtubePlaylistTitle = "MCSR Replayoffs · Season 11";

  /* --- The videoPath escape hatch ------------------------------------------------------------ */
  // A trust boundary: the request names a file the server then reads and publishes. Anything
  // outside the match's own directory must be refused before a byte is read.

  const matchId = 12345678;
  const dir = path.join(media, String(matchId));
  await mkdir(dir, { recursive: true });
  // The upload's last refusal reads the match (`matchIsDnf`): served from the API cache as a finished
  // match with the players the stubbed API below names, never the live record (12345678 is a real
  // forfeit on mcsrranked.com, which would refuse every upload here as a DNF).
  cacheMatch({
    id: matchId,
    type: 2,
    forfeited: false,
    result: { uuid: "u-doogile", time: 600_000 },
    completions: [{ uuid: "u-doogile", time: 600_000 }],
    players: [
      { nickname: "doogile", uuid: "u-doogile" },
      { nickname: "Feinberg", uuid: "u-feinberg" },
    ],
  } as unknown as MatchInfo);
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

  // YouTube refuses a description over 5000 BYTES or with < >, and only after the whole file has
  // gone up: both are refused before a byte is sent. "é" is two bytes — 2600 of them, 5200 bytes.
  {
    const descriptionEdited = path.join(dir, `match-${matchId}.description.edited.txt`);
    let sent = 0;
    const neverSend = (async () => (sent++, {})) as unknown as typeof import("./youtube.js").uploadVideo;
    for (const description of ["gg <3", "é".repeat(2600)]) {
      await writeFile(descriptionEdited, description);
      const refused = await beginUpload(matchId, { kind: "video", privacyStatus: "private" }, neverSend);
      assert.ok(
        "error" in refused &&
          refused.status === 400 &&
          /5000 bytes and contain no < or >/.test(refused.error),
        `description refused: ${description.slice(0, 8)}`,
      );
    }
    assert.equal(sent, 0, "nothing sent");
    await rm(descriptionEdited);
  }

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

  /* --- A blocked player's match is refused outright, before any hook, file or network lookup. -- */
  {
    const saved = config.blockedPlayers;
    config.blockedPlayers = ["TestBlocked"];
    // Case-insensitive, and read off the POV clips on disk — not the title text.
    await writeFile(path.join(dir, "testblocked.mp4"), "x");
    const blockedVideo = await beginUpload(matchId, { kind: "video", privacyStatus: "private" });
    assert.ok(
      "error" in blockedVideo && blockedVideo.status === 403 && /blocked player/.test(blockedVideo.error),
      "the long-form is refused",
    );
    const blockedShort = await beginUpload(matchId, { kind: "short", privacyStatus: "private" });
    assert.ok(
      "error" in blockedShort && blockedShort.status === 403 && /blocked player/.test(blockedShort.error),
      "and so is the Short",
    );
    await rm(path.join(dir, "testblocked.mp4"));
    config.blockedPlayers = saved;
    // Unblocked: past the gate. Whatever the next check says (no title file yet, at this point in
    // the test), it is not the blocklist refusing it a second time.
    const clear = await beginUpload(matchId, { kind: "short", privacyStatus: "private" });
    assert.ok(
      !("error" in clear) || !/blocked player/.test(clear.error),
      "unblocked, it is not the blocklist refusing it any more",
    );
    console.log("OK: a blocked player's match is refused outright, for both kinds, case-insensitively");
  }
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
  // ...but not while the thumbnails are re-rendering or a new tile's Use this is moving them: the
  // long-form would send a thumbnail and a manifest that change under it. The Short carries none.
  {
    let drawn!: () => void;
    startRerender(matchId, (() => new Promise((r) => (drawn = () => r({} as never)))) as never);
    const held = await beginUpload(matchId, {
      kind: "video",
      privacyStatus: "private",
      videoPath: exportFile,
    });
    assert.ok("error" in held && held.status === 409, JSON.stringify(held));
    assert.match(held.error, /thumbnails of match \d+ are being re-rendered or put in place/);
    assert.ok(!("error" in (await beginUpload(matchId, { kind: "short", privacyStatus: "private" }))));
    drawn();
    await thumbJob(matchId)!.finished;
  }
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
  /** The video's comment threads as YouTube lists them (the comment step's guard reads them). */
  let threads: unknown[] = [];
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
    // The comment step reads the video's threads first: one comment per video, whoever posted it.
    if (url.includes("/commentThreads?") && (init?.method ?? "GET") === "GET")
      return body({ items: threads });
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
    // The title file predates today's Short rule: what goes up is the saved hook and both names (uploadTextFor).
    assert.deepEqual(sent, [{ title: "Down to the last heart | a vs b #mcsr #minecraft", publishAt: LATER }]);
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

  // A double press: both requests pass the early running check while the other is still awaiting
  // the hook/text/status reads, so the one that reserves the slot must check again in its tick.
  {
    const file = path.join(dir, `short-${matchId}.mp4`);
    await writeFile(file, "x");
    let sends = 0;
    const send = async (args: UploadOptions): Promise<UploadResult> => {
      sends++;
      return { videoId: "vidOnce", publishAt: args.publishAt ?? null, privacyStatus: "private" };
    };
    const req = { kind: "short" as const, privacyStatus: "private" as const, publishAt: LATER };
    const both = await Promise.all([beginUpload(matchId, req, send), beginUpload(matchId, req, send)]);
    assert.deepEqual(
      both.map((b) => ("error" in b ? b.status : 0)).sort(),
      [0, 409],
      `exactly one goes up: ${JSON.stringify(both)}`,
    );
    for (const b of both) if (!("error" in b)) await b.finished;
    assert.equal(sends, 1, "videos.insert once");
    await rm(file);
    await rm(path.join(dir, "youtube-short.json"));
    console.log("OK: a double press uploads once, the second is a 409");
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
      [
        "error",
        `upload refused: the Short of match ${matchId} is already on the channel (youtube-short.json) — it goes up once; a second copy is a duplicate only Studio removes`,
      ],
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
  const { readUpload, writeUpload } = await import("./youtubeStore.js");
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
    !hits.some((h) => h.startsWith("POST") && h.includes("/commentThreads?")),
    "while the step that had succeeded stayed untouched",
  );

  // A blocked player's match: no further writes, ever — Adopt, the Finish button and the
  // nightly's retries all settle through this one function (config.blockedPlayers).
  {
    const savedBlocked = config.blockedPlayers;
    config.blockedPlayers = ["TestBlocked"];
    await writeFile(path.join(dir, "TestBlocked.mp4"), "x");
    await writeUpload(matchId, {
      ...record,
      finished: { playlists: '"Season 11": quota', thumbnail: null, comment: undefined, tags: undefined },
    });
    hits.length = 0;
    const blocked = await finishOnYouTube(matchId, "vidX");
    assert.deepEqual(
      blocked,
      {
        playlists: "a blocked player — no YouTube writes are made for this match",
        thumbnail: null,
        comment: "a blocked player — no YouTube writes are made for this match",
        tags: "a blocked player — no YouTube writes are made for this match",
      },
      "already-done steps are left alone; pending ones get the blocked note instead of a retry",
    );
    assert.deepEqual(
      hits.filter((h) => h.includes("googleapis.com/youtube")),
      [],
      "no playlist, thumbnail, comment or tag write reaches YouTube",
    );
    const onDisk = await readUpload(matchId);
    assert.equal(
      onDisk?.finished?.playlists,
      '"Season 11": quota',
      "not persisted — the record is untouched, so unblocking needs no repair",
    );
    await rm(path.join(dir, "TestBlocked.mp4"));
    config.blockedPlayers = savedBlocked;
    console.log("OK: a blocked player's match makes no YouTube writes on Finish, and nothing is persisted");
  }

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
  assert.ok(!hits.some((h) => h.startsWith("POST") && h.includes("/commentThreads?")));

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

  // The folder that owns the video sets its image, and no other: a series' game 2 with no record
  // (the channel scan records none for it, the panel still pairs it and offers Finish) or with
  // game 1's record copied in never puts its own pick on the series video — over a "Put on
  // YouTube" from game 1, with no undo copy, on every press.
  {
    const variant = { key: "walking-crossed", file: "thumbnail.walking-crossed.png" };
    const game2 = matchId + 1;
    const dir2 = path.join(media, String(game2));
    await mkdir(dir2, { recursive: true });
    await writeFile(path.join(dir2, variant.file), "game 2's pick");
    await writeFile(
      path.join(dir2, "thumbnail.json"),
      JSON.stringify({ chosen: variant.key, chosenBy: "operator", hookText: null, variants: [variant] }),
    );
    await writeUpload(matchId, { ...record, finished: { thumbnail: null } });
    for (const copied of [false, true]) {
      if (copied) await writeUpload(game2, { ...record, finished: {} });
      hits.length = 0;
      const steps = await finishOnYouTube(game2, "vidX");
      assert.match(String(steps.thumbnail), /left alone — this folder holds no upload record of its own/);
      assert.ok(
        !hits.some((h) => h.includes("/thumbnails/set")),
        `copied record ${copied}: no thumbnails.set`,
      );
    }
    await rm(dir2, { recursive: true });
    console.log("OK: only the folder that owns the video sets its thumbnail");
  }

  // Finish holds the match's turn at the video (a "Put on YouTube" waits for it) while it runs.
  {
    const { videoWriting } = await import("./youtubeStore.js");
    const running = finishOnYouTube(matchId, "vidX");
    assert.equal(videoWriting(matchId), true);
    await running;
    assert.equal(videoWriting(matchId), false);
  }

  // A record written while Finish runs, outside its turn (the Studio worker's pin is another
  // process): Finish puts back only its ledger, never its own stale copy of the rest — and never
  // turns a record now for another video back into the one it started on.
  {
    const done = { thumbnail: null, playlists: null, comment: null, tags: null };
    await writeUpload(matchId, { ...record, publishAt: "2026-10-20T19:00:00.000Z", finished: done });
    const running = finishOnYouTube(matchId, "vidX");
    const before = (await readUpload(matchId))!;
    await writeUpload(matchId, { ...before, publishAt: "2026-10-22T19:00:00.000Z" });
    await running;
    const after = await readUpload(matchId);
    assert.equal(after?.publishAt, "2026-10-22T19:00:00.000Z", "the newer time stands");
    assert.deepEqual(after?.finished, done, "and the ledger with it");
    const again = finishOnYouTube(matchId, "vidX");
    await writeUpload(matchId, { ...record, videoId: "vidYYYYYYYY", finished: {} });
    await again;
    assert.equal((await readUpload(matchId))?.videoId, "vidYYYYYYYY", "another video's record is left alone");
    console.log("OK: Finish writes back its ledger onto the record as it is now, not as it was");
  }

  // A thumbnail put on from the Thumbnail panel: the A/B tab files the video under a row of its
  // own (it wore two images), and Adopt of the same video keeps it — the "on YouTube since" line,
  // Undo and that row with it. Another video starts afresh.
  {
    const { handleYoutubeRoute } = await import("../dashboard/youtubeRoutes.js");
    const route = async (method: string, parts: string[], reqBody = "") => {
      const answers: Array<{ status: number; body: { rows?: Array<{ variant: string }> } }> = [];
      await handleYoutubeRoute({ method, headers: {} } as never, {} as never, ["", "youtube", ...parts], {
        json: (_r, status, body) => void answers.push({ status, body: body as never }),
        readBody: async () => reqBody,
        matchDir: (id) => path.join(media, String(id)),
        parseId: (raw) => (raw && /^\d+$/.test(raw) ? Number(raw) : null),
      });
      return answers[0]!;
    };
    await writeFile(path.join(dir, `match-${matchId}.description.txt`), `x /matches/${matchId} y\n`);
    await writeFile(
      path.join(dir, "thumbnail.json"),
      JSON.stringify({ chosen: "walking-crossed", chosenBy: "operator", hookText: null, variants: [] }),
    );
    const swapped = { variant: "cheering-relaxing", at: "2026-09-26T10:00:00Z", from: "thumbnail-new" };
    const done = { thumbnail: null, playlists: null, comment: null, tags: null };
    await writeUpload(matchId, { ...record, videoId: "vidXXXXXXXX", thumbnailSet: swapped, finished: done });
    const rows = (await route("GET", ["abtest"])).body.rows ?? [];
    assert.ok(
      rows.some((r) => r.variant === "(swapped)"),
      JSON.stringify(rows),
    );
    const readopt = { videoId: "vidXXXXXXXX" };
    // Adopt's finish sets the live thumbnail.png: refused while a re-render or its Use this runs.
    let drawn!: () => void;
    startRerender(matchId, (() => new Promise((r) => (drawn = () => r({} as never)))) as never);
    const held = await route("POST", ["adopt", String(matchId)], JSON.stringify(readopt));
    assert.equal(held.status, 409);
    assert.match(String((held.body as { error?: string }).error), /re-rendered or put in place/);
    drawn();
    await thumbJob(matchId)!.finished;
    const same = await route("POST", ["adopt", String(matchId)], JSON.stringify(readopt));
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.deepEqual((await readUpload(matchId))?.thumbnailSet, swapped, "re-adopting keeps it");
    const other = await route("POST", ["adopt", String(matchId)], JSON.stringify({ videoId: "vidYYYYYYYY" }));
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal((await readUpload(matchId))?.thumbnailSet, undefined, "another video starts afresh");
    await rm(path.join(dir, "thumbnail.json"));
    console.log("OK: a swapped thumbnail is its own A/B row, and survives re-adopting the same video");
  }

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

  // --- Comment retry on the nightly tick ---------------------------------------------------
  // A scheduled record past its publishAt gets one comment; a second tick posts nothing;
  // a still-private video is skipped; a Short is never touched.
  const pastPublishAt = "2026-09-08T19:00:00Z";

  // 1. A scheduled record past its publishAt gets one comment.
  livePrivacy = "public";
  await writeUpload(matchId, {
    ...record,
    publishAt: pastPublishAt,
    privacyStatus: "private",
    finished: { playlists: null, thumbnail: null, tags: null },
  });
  hits.length = 0;
  await retryPendingComments();
  assert.equal(
    hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
    1,
    "a scheduled record past its publishAt gets one comment",
  );
  const scheduledDone = await readUpload(matchId, "video");
  assert.equal(scheduledDone?.finished?.comment, null, "comment recorded in ledger as done");

  // 2. A second tick posts nothing.
  hits.length = 0;
  await retryPendingComments();
  assert.equal(
    hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
    0,
    "a second tick posts nothing",
  );

  // 3. A still-private video is skipped.
  livePrivacy = "private";
  await writeUpload(matchId, {
    ...record,
    publishAt: pastPublishAt,
    privacyStatus: "private",
    finished: { playlists: null, thumbnail: null, tags: null },
  });
  hits.length = 0;
  await retryPendingComments();
  assert.equal(
    hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
    0,
    "a still-private video is skipped",
  );
  const stillPrivateRecord = await readUpload(matchId, "video");
  assert.equal(
    stillPrivateRecord?.finished?.comment,
    undefined,
    "still-private video has no comment recorded",
  );

  // 4. A Short is never touched.
  await rm(path.join(dir, "youtube.json"));
  await writeUpload(
    matchId,
    {
      ...record,
      publishAt: pastPublishAt,
      privacyStatus: "private",
      finished: {},
    },
    "short",
  );
  hits.length = 0;
  await retryPendingComments();
  assert.equal(
    hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
    0,
    "a Short is never commented on",
  );
  const shortRecord = await readUpload(matchId, "short");
  assert.equal(shortRecord?.finished?.comment, undefined, "Short finish ledger is untouched");

  // 5. A failed comment is retried and succeeds once public.
  livePrivacy = "public";
  await writeUpload(matchId, {
    ...record,
    publishAt: pastPublishAt,
    privacyStatus: "private",
    finished: { playlists: null, comment: "quota exceeded", tags: null },
  });
  hits.length = 0;
  await retryPendingComments();
  assert.equal(
    hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
    1,
    "a failed comment is retried and succeeds once public",
  );
  const retriedRecord = await readUpload(matchId, "video");
  assert.equal(retriedRecord?.finished?.comment, null, "retried comment recorded as done");

  // 6. The channel's comment is already on the video (another folder's ledger, Studio, a second
  // press): nothing is posted and the step is done. ZqI4Cf1g3_w got four on 26 Sept 2026.
  threads = [
    {
      id: "t1",
      snippet: {
        topLevelComment: {
          snippet: {
            authorDisplayName: "MCSR Replayoffs",
            textDisplay: "both povs…",
            publishedAt: "2026-09-26T03:00:02Z",
            likeCount: 0,
            authorChannelId: { value: config.youtubeChannelId },
          },
        },
      },
    },
  ];
  await writeUpload(matchId, {
    ...record,
    publishAt: pastPublishAt,
    privacyStatus: "private",
    finished: { playlists: null, tags: null },
  });
  hits.length = 0;
  await retryPendingComments();
  assert.equal(
    hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
    0,
    "a video that already carries the channel's comment gets no second one",
  );
  assert.equal(
    (await readUpload(matchId, "video"))?.finished?.comment,
    null,
    "and the step is recorded as done",
  );
  threads = [];

  // A series' record sits in every game's folder with one videoId: one comment for the video,
  // and none once any folder's ledger has it (24 Sept: the six live long-forms, two of them series).
  const game2 = path.join(media, String(matchId + 1));
  await mkdir(game2, { recursive: true });
  await writeUpload(matchId, {
    ...record,
    publishAt: pastPublishAt,
    privacyStatus: "private",
    finished: { comment: null },
  });
  await writeUpload(matchId + 1, {
    ...record,
    publishAt: pastPublishAt,
    privacyStatus: "private",
    finished: {},
  });
  hits.length = 0;
  await retryPendingComments();
  assert.equal(
    hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
    0,
    "a series game's copy is not commented again",
  );
  await writeUpload(matchId, { ...record, publishAt: pastPublishAt, privacyStatus: "private", finished: {} });
  hits.length = 0;
  await retryPendingComments();
  assert.equal(
    hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
    1,
    "one comment for the video, not one per game",
  );
  // A public upload with no publishAt is not this loop's: it got its comment at upload, or predates it.
  await rm(game2, { recursive: true });
  await writeUpload(matchId, { ...record, publishAt: null, privacyStatus: "public", finished: {} });
  hits.length = 0;
  await retryPendingComments();
  assert.equal(
    hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
    0,
    "no publishAt, no retry",
  );

  console.log("OK: comment retry posts for public scheduled videos, skips private ones and Shorts");

  // Newest first, capped after the due filter: five old records whose comment never settles (a
  // deleted video reads as private, one made private again, comments off) took every attempt each
  // night in match-id order, and a fresh upload never got its first comment — or its pin.
  {
    const stuck = [8801, 8802, 8803, 8804, 8805];
    const fresh = 8806;
    for (const id of [...stuck, fresh]) {
      await mkdir(path.join(media, String(id)), { recursive: true });
      await writeUpload(id, {
        ...record,
        videoId: `vid${id}`,
        publishAt: id === fresh ? new Date(Date.now() - 86_400_000).toISOString() : pastPublishAt,
        privacyStatus: "private",
        finished: {},
      });
    }
    const pressed: number[] = [];
    const fakeFinish = (async (id: number) => (pressed.push(id), {})) as unknown as typeof finishOnYouTube;
    await retryPendingComments(fakeFinish, 5);
    assert.equal(pressed[0], fresh, "the newest due video is pressed first");
    assert.equal(pressed.length, 5, "still at most five a tick");
    for (const id of [...stuck, fresh]) await rm(path.join(media, String(id)), { recursive: true });
  }

  /* --- commentSoonAfterPublish: the same comment, sooner, only when switched on ------------- */
  {
    // A fixed anchor rather than the wall clock: commentSoonTick takes `nowMs` explicitly, so
    // every case below is deterministic regardless of when this test actually runs.
    const anchor = Date.parse(pastPublishAt) + 21 * 60_000;
    const publishedAt = new Date(anchor - 21 * 60_000).toISOString(); // 21 min before `anchor`
    const dueRecord = {
      ...record,
      publishAt: publishedAt,
      privacyStatus: "private",
      finished: { playlists: null, thumbnail: null, tags: null },
    };

    // Off (the default): reads and calls nothing, even for a video that would otherwise qualify
    // at every step below. This is the state every worktree starts in.
    config.commentSoonAfterPublish = false;
    livePrivacy = "public";
    await writeUpload(matchId, dueRecord);
    hits.length = 0;
    await commentSoonTick(undefined, 1, anchor);
    assert.equal(
      hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
      0,
      "off: nothing posted",
    );
    assert.equal((await readUpload(matchId, "video"))?.finished?.comment, undefined, "and nothing recorded");

    config.commentSoonAfterPublish = true;

    // On, but under the 5-minute floor: never due yet, whatever the video id hashes to.
    hits.length = 0;
    await commentSoonTick(undefined, 1, anchor - 20 * 60_000 + 4 * 60_000); // 4 min after publish
    assert.equal(
      hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
      0,
      "on, 4 minutes in: under the floor, not due",
    );

    // On, past the 20-minute ceiling: always due, whatever the video id hashes to.
    hits.length = 0;
    await commentSoonTick(undefined, 1, anchor);
    assert.equal(
      hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
      1,
      "on, 21 minutes in: past the ceiling, posted",
    );
    assert.equal((await readUpload(matchId, "video"))?.finished?.comment, null, "recorded as done");

    // On, but published over 2 hours ago: left for retryPendingComments's nightly sweep, not this
    // tick's — keeps a restart or an old stuck record from re-listing the whole channel.
    await writeUpload(matchId, dueRecord);
    hits.length = 0;
    await commentSoonTick(undefined, 1, anchor + 3 * 3600_000);
    assert.equal(
      hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
      0,
      "published over 2 hours ago: not this tick's",
    );

    // Same once-only guards as retryPendingComments, through the same finishOnYouTube step:
    // a still-private video is skipped and recorded as nothing attempted...
    livePrivacy = "private";
    await writeUpload(matchId, dueRecord);
    hits.length = 0;
    await commentSoonTick(undefined, 1, anchor);
    assert.equal(
      hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
      0,
      "still private: skipped",
    );
    assert.equal(
      (await readUpload(matchId, "video"))?.finished?.comment,
      undefined,
      "not recorded either way",
    );
    livePrivacy = "public";

    // ...and the channel's comment already on the video means nothing is posted a second time.
    threads = [
      {
        id: "t1",
        snippet: {
          topLevelComment: {
            snippet: {
              authorDisplayName: "MCSR Replayoffs",
              textDisplay: "both povs…",
              publishedAt: "2026-09-26T03:00:02Z",
              likeCount: 0,
              authorChannelId: { value: config.youtubeChannelId },
            },
          },
        },
      },
    ];
    await writeUpload(matchId, dueRecord);
    hits.length = 0;
    await commentSoonTick(undefined, 1, anchor);
    assert.equal(
      hits.filter((h) => h.startsWith("POST") && h.includes("/commentThreads?")).length,
      0,
      "the channel's comment is already there: nothing posted again",
    );
    assert.equal((await readUpload(matchId, "video"))?.finished?.comment, null, "and the step reads as done");
    threads = [];

    // maxPerTick bounds the API cost even with several videos due in the same tick.
    const dir2 = path.join(media, String(matchId + 2));
    await mkdir(dir2, { recursive: true });
    await writeUpload(matchId, dueRecord);
    await writeUpload(matchId + 2, { ...dueRecord, videoId: "vidY" });
    const attempted: string[] = [];
    await commentSoonTick(
      async (id, videoId) => {
        attempted.push(videoId);
        return { comment: null };
      },
      1,
      anchor,
    );
    assert.equal(attempted.length, 1, "at most one comment per tick, however many videos are due");
    await rm(dir2, { recursive: true, force: true });

    config.commentSoonAfterPublish = false;
    console.log("OK: commentSoonAfterPublish posts the same comment within minutes, nothing when off");
  }

  /* --- Resuming a cut-short upload (shortTick → src/dashboard/shortFlow.ts, after a restart) - */
  // The channel scan can pair a half-uploaded video to its match long before every byte of it has
  // landed (`recordStudioUpload`), so a record on disk is not proof of anything: only a session
  // still on disk, or a record this chain itself wrote, settle the step without the operator.
  {
    const rMatchId = matchId + 500;
    const rDir = path.join(media, String(rMatchId));
    await mkdir(rDir, { recursive: true });
    const rFile = path.join(rDir, `short-${rMatchId}.mp4`);
    const rSession = path.join(rDir, `.upload-session-short-${rMatchId}.mp4.json`);
    const sent: Array<{ resumeOnly?: boolean; filePath: string }> = [];
    const stubSend = async (opts: UploadOptions): Promise<UploadResult> => {
      sent.push({ resumeOnly: opts.resumeOnly, filePath: opts.filePath });
      return { videoId: "vidResumed", publishAt: null, privacyStatus: "private" };
    };

    // No session, no record: nothing of this chain's is in flight — a safe no-op, so the normal
    // upload step starts fresh right after.
    assert.equal(await resumeUpload(rMatchId, "short", stubSend), null);
    assert.equal(sent.length, 0, "nothing in flight, nothing to resume");

    // No session, a dashboard record: the crash landed between writing it and marking the step
    // done, so it is trusted as done.
    await writeUpload(rMatchId, { ...record, videoId: "vidOld", source: "dashboard" }, "short");
    assert.equal(await resumeUpload(rMatchId, "short", stubSend), null);
    assert.equal(sent.length, 0);

    // No session, a studio record — the channel scan's own premature pairing, or anything else
    // this chain did not write itself: the step fails rather than guessing, and nothing is sent.
    await writeUpload(rMatchId, { ...record, videoId: "vidOld", source: "studio" }, "short");
    const refused = await resumeUpload(rMatchId, "short", stubSend);
    assert.match(String(refused), /Studio/);
    assert.match(String(refused), /Retry/);
    assert.equal(sent.length, 0, "a foreign record with no session is never sent");

    // A session on disk: resumed through `send` with resumeOnly, and the chain's own record
    // replaces whatever (the studio one above) was there — the scan's premature pairing does not
    // stick once the chain actually finishes the upload.
    await writeFile(rFile, "x");
    await writeFile(rSession, JSON.stringify({ filePath: rFile, total: 1, sessionUrl: "https://x" }));
    // The record names the title YouTube holds — the one the session's start sent, before a hook
    // changed since — not the one on disk now.
    const resumed = await resumeUpload(rMatchId, "short", async (opts) => ({
      ...(await stubSend(opts)),
      title: "Hook from before | a vs b",
    }));
    assert.equal(resumed, null);
    assert.deepEqual(sent, [{ resumeOnly: true, filePath: rFile }], "resumed, never a fresh start");
    const after = await readUpload(rMatchId, "short");
    assert.equal(after?.videoId, "vidResumed");
    assert.equal(after?.source, "dashboard", "the chain's record replaces the scan's studio one");
    assert.equal(after?.title, "Hook from before | a vs b", "recorded under the title it went up with");

    // The session resumes, but `send` itself still fails (expired, say) with a foreign record on
    // disk: the same "ask the operator" message as no session at all, discovered live instead.
    await writeUpload(rMatchId, { ...record, videoId: "vidOld", source: "studio" }, "short");
    await writeFile(rSession, JSON.stringify({ filePath: rFile, total: 1, sessionUrl: "https://x" }));
    const failingSend = async (): Promise<UploadResult> => {
      throw new Error("No resumable session for x — refusing to start a new upload (resumeOnly)");
    };
    const stillForeign = await resumeUpload(rMatchId, "short", failingSend);
    assert.match(String(stillForeign), /Studio/);
    assert.match(String(stillForeign), /Retry/);

    // `send` itself succeeds — the video is live, and uploadVideo has already forgotten the
    // session — but writing the record then throws: the one failure where sending it again
    // would be a second copy, so it must say the video is up under its id, not read as foreign
    // (the stale studio record above is still on disk) and not a generic "send failed" either.
    await writeFile(rSession, JSON.stringify({ filePath: rFile, total: 1, sessionUrl: "https://x" }));
    const recordFile = path.join(rDir, "youtube-short.json");
    await rm(recordFile, { force: true });
    await mkdir(recordFile); // a directory where the record file must go: writeUpload's write throws
    const sendOk = async (): Promise<UploadResult> => ({
      videoId: "vidLive",
      publishAt: null,
      privacyStatus: "private",
    });
    const liveNotRecorded = await resumeUpload(rMatchId, "short", sendOk);
    assert.match(String(liveNotRecorded), /vidLive/, "names the id that is actually live");
    assert.match(String(liveNotRecorded), /do not upload it again/);
    assert.ok(!/Studio/.test(String(liveNotRecorded)), "not the foreign-record message");
    await rm(recordFile, { recursive: true, force: true });

    // uploadRunning() must see a resume in flight too, or a concurrent manual Upload press, or a
    // writeHooks save, cannot tell one is already sending bytes — and could race the same session.
    await writeFile(rSession, JSON.stringify({ filePath: rFile, total: 1, sessionUrl: "https://x" }));
    assert.equal(uploadRunning(rMatchId), false, "nothing running before this one starts");
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowSend = async (): Promise<UploadResult> => {
      await gate;
      return { videoId: "vidSlow", publishAt: null, privacyStatus: "private" };
    };
    const inFlight = resumeUpload(rMatchId, "short", slowSend);
    await new Promise((r) => setTimeout(r, 10)); // past the file reads, into the send() await
    assert.equal(uploadRunning(rMatchId), true, "a live resume is visible to uploadRunning");
    release();
    assert.equal(await inFlight, null);
    assert.equal(uploadRunning(rMatchId), false, "and not once it has settled");

    // A long-form whose sync.json was corrected after its export: the rest of the bytes would
    // finish a desynced video, so nothing is sent and the session stays for the re-encode.
    {
      const vFile = path.join(rDir, `final-${rMatchId}.mp4`);
      const vSession = path.join(rDir, `.upload-session-final-${rMatchId}.mp4.json`);
      await writeFile(vFile, "x");
      await writeFile(vSession, JSON.stringify({ filePath: vFile, total: 1, sessionUrl: "https://x" }));
      await utimes(vFile, new Date("2026-09-10T12:00:00Z"), new Date("2026-09-10T12:00:00Z"));
      writeSyncOffsets(rDir, { left: 150, right: 150, confidence: 1, detail: "", source: "manual" });
      let staleSent = false;
      const staleSend = async (): Promise<UploadResult> => {
        staleSent = true;
        return { videoId: "vidStale", publishAt: null, privacyStatus: "private" };
      };
      assert.equal(await resumeUpload(rMatchId, "video", staleSend), staleExportMessage(rMatchId));
      assert.equal(staleSent, false, "a stale export is never resumed");
      assert.ok(existsSync(vSession), "its session is left for the re-encode to start fresh over");
      await rm(path.join(rDir, "sync.json"));
      await rm(vFile);
      await rm(vSession);
    }

    // A runner blocked since the upload started: the rest of the bytes never go up either.
    {
      const saved = config.blockedPlayers;
      config.blockedPlayers = ["TestBlocked"];
      await writeFile(path.join(rDir, "testblocked.mp4"), "x");
      let blockedSent = false;
      const blockedSend = async (): Promise<UploadResult> => {
        blockedSent = true;
        return { videoId: "vidBlocked", publishAt: null, privacyStatus: "private" };
      };
      assert.match(String(await resumeUpload(rMatchId, "short", blockedSend)), /blocked player/);
      assert.equal(blockedSent, false, "a blocked match is never resumed");
      await rm(path.join(rDir, "testblocked.mp4"));
      config.blockedPlayers = saved;
    }

    console.log("OK: a cut-short upload resumes its own session and never starts a second one");
  }

  /* --- Studio automation's pin step: off is a no-op, on waits for comment+public ------------- */
  {
    const savedStudio = config.studioAutomation;

    // Off (the default): the key never appears, and the browser seam is never called — "zero
    // behaviour change, nothing launched, nothing read."
    config.studioAutomation = false;
    livePrivacy = "public";
    let pinCalls = 0;
    const neverCalled = async (): Promise<string | null> => {
      pinCalls++;
      return null;
    };
    await writeUpload(matchId, { ...record, finished: { comment: null } });
    const off = await finishOnYouTube(matchId, "vidX", "video", neverCalled);
    assert.equal("pin" in off, false, "off: no pin key at all");
    assert.equal(pinCalls, 0, "off: the browser seam is never reached");

    config.studioAutomation = true;

    // On, but the comment has not landed yet (the video is still private, so the comment step
    // itself leaves it unattempted): Studio has nothing to pin, so this waits too — left absent,
    // which `todo()` reads as still-to-do on the next call, not a failure.
    livePrivacy = "private";
    await writeUpload(matchId, { ...record, privacyStatus: "private", finished: {} });
    const noComment = await finishOnYouTube(matchId, "vidX", "video", neverCalled);
    assert.equal(noComment.comment, undefined, "sanity: the comment step itself is still pending too");
    assert.equal(noComment.pin, undefined, "on, comment pending: pin waits, not attempted");
    assert.equal(pinCalls, 0);
    livePrivacy = "public";

    // On, comment done, but the video is not actually public yet (re-checked live, the same
    // reason the comment step itself re-checks): waits rather than failing.
    livePrivacy = "unlisted";
    await writeUpload(matchId, { ...record, privacyStatus: "private", finished: { comment: null } });
    const notPublic = await finishOnYouTube(matchId, "vidX", "video", neverCalled);
    assert.equal(notPublic.pin, undefined, "on, not public yet: pin waits");
    assert.equal(pinCalls, 0);

    // On, comment done, live public: the seam is called once, and its answer lands verbatim.
    livePrivacy = "public";
    await writeUpload(matchId, { ...record, finished: { comment: null } });
    const ok = await finishOnYouTube(matchId, "vidX", "video", async () => null);
    assert.equal(ok.pin, null, "pinned (or already pinned) reads as done");

    // A verify/signed-out/wrong-channel probe is this attempt's error, recorded — and the
    // ledger's own idempotence means a fresh call retries it, rather than this function looping.
    await writeUpload(matchId, { ...record, finished: { comment: null } });
    const verify = await finishOnYouTube(
      matchId,
      "vidX",
      "video",
      async () => "Studio verify — log in again through the YouTube panel's Studio login",
    );
    assert.match(String(verify.pin), /^Studio verify/, "a verify probe is recorded as this attempt's error");
    // Called again without a login having happened: fails the same way, and does not hang —
    // this is "not retried in the same run," not "never retried at all."
    const stillVerify = await finishOnYouTube(
      matchId,
      "vidX",
      "video",
      async () => "Studio verify — log in again through the YouTube panel's Studio login",
    );
    assert.match(String(stillVerify.pin), /^Studio verify/);

    // A Short never gets a pin — there is no comment on one to pin.
    await writeUpload(matchId, { ...record, finished: {} }, "short");
    const shortPin = await finishOnYouTube(matchId, "vidX", "short", neverCalled);
    assert.equal("pin" in shortPin, false, "a Short's finish never touches pin");
    assert.equal(pinCalls, 0);

    // A blocked player, with studioAutomation on: the pin step gets the same refusal note as the
    // other three, pending only — an already-done pin (from before the block) is left alone.
    const savedBlocked = config.blockedPlayers;
    config.blockedPlayers = ["TestBlocked"];
    await writeFile(path.join(dir, "TestBlocked.mp4"), "x");
    await writeUpload(matchId, { ...record, finished: { comment: null, pin: null } });
    const blockedDone = await finishOnYouTube(matchId, "vidX", "video", neverCalled);
    assert.equal(blockedDone.pin, null, "an already-done pin stays done under a later block");
    await writeUpload(matchId, { ...record, finished: { comment: null } });
    const blockedPending = await finishOnYouTube(matchId, "vidX", "video", neverCalled);
    assert.match(String(blockedPending.pin), /blocked player/);
    await rm(path.join(dir, "TestBlocked.mp4"));
    config.blockedPlayers = savedBlocked;

    config.studioAutomation = savedStudio;
    console.log("OK: the Studio pin step is off by default and waits for the comment and for public");
  }

  /* --- retryPendingStudio: the nightly's once-a-tick pass over pending pins ------------------- */
  {
    const savedStudio = config.studioAutomation;

    // Off: reads nothing, calls nothing.
    config.studioAutomation = false;
    await writeUpload(matchId, { ...record, finished: { comment: null } });
    const offPressed: string[] = [];
    await retryPendingStudio(async (id) => {
      offPressed.push(String(id));
      return {};
    });
    assert.deepEqual(offPressed, [], "off: retryPendingStudio touches nothing");

    config.studioAutomation = true;

    // A pending pin (comment done, pin not) is pressed; a done one and one whose comment has not
    // landed yet are both left alone.
    const dirB = path.join(media, String(matchId + 50));
    await mkdir(dirB, { recursive: true });
    await writeUpload(matchId, { ...record, videoId: "vidPending", finished: { comment: null } });
    await writeUpload(matchId + 50, {
      ...record,
      videoId: "vidDone",
      finished: { comment: null, pin: null },
    });
    const pressedOn: string[] = [];
    await retryPendingStudio(async (id, videoId) => {
      pressedOn.push(videoId);
      return { pin: null };
    });
    assert.deepEqual(pressedOn, ["vidPending"], "only the comment-done, pin-pending video is pressed");

    // maxPerTick bounds it even with several pending at once.
    const dirC = path.join(media, String(matchId + 51));
    await mkdir(dirC, { recursive: true });
    await writeUpload(matchId + 51, { ...record, videoId: "vidPending2", finished: { comment: null } });
    const bounded: string[] = [];
    await retryPendingStudio(async (id, videoId) => {
      bounded.push(videoId);
      return { pin: null };
    }, 1);
    assert.equal(bounded.length, 1, "at most maxPerTick videos are pressed in one tick");
    await rm(dirB, { recursive: true, force: true });
    await rm(dirC, { recursive: true, force: true });

    config.studioAutomation = savedStudio;
    console.log("OK: retryPendingStudio is off by default and otherwise presses only pending pins");
  }

  /* --- Rivalry packaging before the insert (22 Oct 2026) ------------------------------------- */
  // A pair's matchup playlist is made at finish, after the insert the description goes up with:
  // the upload makes it first when the pair has history, and links it. Nothing for a first
  // meeting or a blocked pair, and a description already linking one is left as it is.
  {
    const { withMatchupPlaylist } = await import("./youtubeUpload.js");
    const { RIVALRY_PLAYLIST_LINE, rivalrySubscribeLine, SUBSCRIBE_LINE } =
      await import("../pipeline/description.js");
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/playlists?") && init?.method === "POST") {
        hits.push(`POST ${url}`);
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ id: "PLRIVAL" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return stubbed(input, init);
    }) as typeof fetch;
    const text = {
      title: "A hook | doogile vs Feinberg | MCSR Ranked 1v1",
      description: [
        "doogile vs Feinberg, mcsr ranked 1v1 on the same seed.",
        "",
        SUBSCRIBE_LINE,
        "",
        "0:00 intro",
        "",
        `match page: https://magmamcsr.com/ranked/player/x/matches/${matchId}?season=12`,
        "all the matches: https://www.youtube.com/playlist?list=PL",
        "",
        "fan channel, x",
        "",
        "#MCSRRanked",
      ].join("\n"),
    };
    const posts = () => hits.filter((h) => h.startsWith("POST") && h.includes("/playlists?")).length;
    // A first meeting: nothing made, every byte kept.
    const before = posts();
    assert.equal(await withMatchupPlaylist(matchId, dir, text), text.description);
    assert.equal(posts(), before, "no playlist for a first meeting");
    // The pair's earlier public long-form on the channel: the playlist is made, the line links it.
    const earlierDir = path.join(media, "12000001");
    await mkdir(earlierDir, { recursive: true });
    await writeFile(
      path.join(earlierDir, "youtube.json"),
      JSON.stringify({
        videoId: "EEEEEEEEEEE",
        uploadedAt: "2026-09-01T19:00:00Z",
        publishAt: null,
        privacyStatus: "public",
        thumbnailVariant: null,
        title: "Hook | Feinberg vs doogile | MCSR Ranked 1v1",
      }),
    );
    const packed = await withMatchupPlaylist(matchId, dir, text);
    assert.equal(posts(), before + 1, "one playlists.insert");
    const made = sent
      .filter((s) => s.url.includes("/playlists?") && s.url.includes("part=snippet,status"))
      .at(-1);
    assert.equal(
      (made?.body as { snippet: { title: string } }).snippet.title,
      "doogile vs Feinberg · MCSR Ranked",
    );
    assert.ok(
      packed.includes(
        "every doogile vs Feinberg on the channel: https://www.youtube.com/playlist?list=PLRIVAL",
      ),
      packed,
    );
    assert.ok(packed.includes(rivalrySubscribeLine("doogile", "Feinberg")), "the ask names the pair too");
    assert.ok(!packed.includes(SUBSCRIBE_LINE));
    assert.ok(RIVALRY_PLAYLIST_LINE.test(packed));
    // Already linked (uploadTextFor found it): nothing more, not a second insert.
    assert.equal(await withMatchupPlaylist(matchId, dir, { ...text, description: packed }), packed);
    assert.equal(posts(), before + 1);
    // A blocked pair, whatever the history: nothing, and no write.
    const savedBlocked = config.blockedPlayers;
    config.blockedPlayers = ["TestBlocked"];
    await writeFile(path.join(dir, "testblocked.mp4"), "x");
    assert.equal(await withMatchupPlaylist(matchId, dir, text), text.description);
    await rm(path.join(dir, "testblocked.mp4"));
    config.blockedPlayers = savedBlocked;
    assert.equal(posts(), before + 1);
    await rm(earlierDir, { recursive: true, force: true });
    globalThis.fetch = stubbed;
    console.log("OK: the upload makes the pair's playlist before the insert, for a pair with history only");
  }

  globalThis.fetch = realFetch;
  console.log("OK: the tags step adds what is missing without blanking the snippet");
  console.log("OK: finishing an already-finished video calls nothing");
  console.log("OK: a video uploaded elsewhere keeps the thumbnail it is wearing");
} finally {
  config.mediaDir = mediaDir;
  config.youtubePlaylistTitle = playlistTitle;
  config.youtubeUploadEnabled = uploadEnabled;
  config.commentSoonAfterPublish = commentSoonAfterPublish;
  await rm(media, { recursive: true, force: true });
}
