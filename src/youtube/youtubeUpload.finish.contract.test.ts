// Contract test for the upload and the finish steps (src/youtube/youtubeUpload.ts), written from the
// documentation alone (CLAUDE.md "Upload", "videos.insert is the only call the audit gated",
// "A cut-short upload resumes its own session, never trusts a record"; the long form of each in
// handbook/claude-md-reference.md; README "Upload"). It covers what youtubeUpload.test.ts does not
// already pin, end to end through the public surface: the real `uploadVideo` and the real YouTube
// client run against a stubbed global fetch, so every call is counted at the wire.
//
// The promises, as the docs make them:
//  1. Upload refuses a title still containing `<HOOK>` — anywhere in the title, not only as its head.
//  2. Upload sends `match-<id>.tags.txt` with the long-form.
//  3. Upload adds the long-form to the season playlist and a per-player playlist for each runner.
//  4. A matchup playlist is created on a pair's *second* video, with the first added alongside —
//     and not on the first.
//  5. A Short joins no playlist, gets no custom thumbnail and no comment.
//  6. A Short's description gains "the whole match: https://youtu.be/<id>" at upload, once the
//     long-form's id is in youtube.json (and not before).
//  7. `playlists.insert`'s cap (429 RATE_LIMIT_EXCEEDED): the step records the refusal in the ledger
//     as a cap line, and the nightly's `retryFailedPlaylists` presses again — no operator action.
//  8. A retry presses only what failed: a done comment or thumbnail is not redone.
//  9. `videos.insert` is the only call the audit gated: with `youtubeUploadEnabled` off the upload is
//     refused, while Finish on YouTube still repairs a Studio upload — playlists, comment, tags —
//     and never calls `videos.insert`.
// 10. Finish leaves the thumbnail alone on a Studio upload whose variant nobody confirmed here, and
//     sets it once the operator has confirmed one.
// 11. An operator's Retry after a chunk 503 cannot start a second `videos.insert`: the session file
//     stays, and the Retry resumes it.
// 12. A cut-short upload resumes its own session with `resumeOnly` and writes the chain's own
//     `source: "dashboard"` record over the scan's, so the finish steps run as for any dashboard
//     upload (the thumbnail is not declined as "uploaded elsewhere").
// 13. No session and anything other than a `source: "dashboard"` record (a record with no source
//     included) fails the step, naming Studio.
// 14. The resume probe reads a 5xx as "try again", not "gone": nothing new is started and the
//     session file is kept.
// 15. A resume whose session YouTube no longer honours (404) never falls through to a fresh start.
// 16. A blocked player's match is never uploaded, long-form or Short (CLAUDE.md "Blocked players").
// 17. Asked, not asserted: should a restart finish a `videos.insert` begun while
//     `youtubeUploadEnabled` was on, after the flag went off? (printed as a QUESTION line)
//
// Hermetic: a temp media directory, a temp archive directory, a temp token file, fetch stubbed
// (anything unrouted throws). A doc clause the code does not keep prints a DEVIATION line and the
// run ends "KNOWN-FAILING", never "all checks passed" — exit 0 all the same, so test:unit runs on.
// Run: npx tsx src/youtube/youtubeUpload.finish.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { buildShortDescription } from "../shorts/shortHook.js";
import type { UploadOptions, UploadResult } from "./youtube.js";
import { sessionPath } from "./youtube.js";
import type { UploadRecord } from "./youtubeStore.js";
// youtubeUpload.js and youtubeStore.js are imported below, once MCSR_ARCHIVE_DIR points inside the
// temp dir: both reach src/dashboard/archive.ts, which reads it once, at import.

/** A doc clause the code does not keep: reported, not bent to fit, and the run goes on. */
const deviations: string[] = [];
async function deviation(clause: string, check: () => void | Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.replace(/\s+/g, " ")}`);
    deviations.push(clause);
  }
}

const media = await mkdtemp(path.join(tmpdir(), "mcsr-upload-finish-contract-"));
const saved = {
  mediaDir: config.mediaDir,
  playlist: config.youtubePlaylistTitle,
  enabled: config.youtubeUploadEnabled,
  blocked: config.blockedPlayers,
  token: process.env.YOUTUBE_TOKEN_FILE,
};
config.mediaDir = media;
config.youtubePlaylistTitle = "MCSR Ranked matches · contract";
config.youtubeUploadEnabled = true;
const SEASON = config.youtubePlaylistTitle;
const LATER = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 2, 19)).toISOString();
// A long-form upload queues archiveMatch(): inside the NAS window (03:00-08:00 Warsaw) a standalone
// run would otherwise rsync this temp folder into the real /archive.
const archiveDir = path.join(media, "archive");
const tokenFile = path.join(media, "token.json");
process.env.MCSR_ARCHIVE_DIR = archiveDir;
process.env.YOUTUBE_TOKEN_FILE = tokenFile;

/* --- The wire: a small fake YouTube + MCSR API ------------------------------------------------ */
const fixture = (id: number) =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as unknown;
const calls: string[] = [];
const bodies: Array<{ url: string; method: string; body: string }> = [];
const playlists = new Map<string, string>(); // title -> id
const playlistItems = new Set<string>(); // `${playlistId}/${videoId}`
const livePrivacy = new Map<string, string>();
let capPlaylists = false;
let sessionAnswer: (init: RequestInit) => Response = () => new Response("", { status: 500 });
let sessionNo = 0;
const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  calls.push(`${method} ${url}`);
  if (typeof init.body === "string") bodies.push({ url, method, body: init.body });
  const q = new URL(url).searchParams;
  if (url.startsWith("https://oauth2.googleapis.com/")) return json({ access_token: "at", expires_in: 3600 });
  const mcsr = /^https:\/\/api\.mcsrranked\.com\/matches\/(\d+)$/.exec(url);
  if (mcsr) {
    try {
      return json({ status: "success", data: fixture(Number(mcsr[1])) });
    } catch {
      return json({ status: "error", data: "not found" }, 404);
    }
  }
  if (url.startsWith("https://upload.test/session/")) return sessionAnswer(init);
  if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable"))
    return json({}, 200, { location: `https://upload.test/session/${++sessionNo}` });
  if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/thumbnails/set")) return json({});
  const api = "https://www.googleapis.com/youtube/v3";
  if (url.startsWith(`${api}/playlists?`) && method === "GET")
    return json({ items: [...playlists].map(([title, id]) => ({ id, snippet: { title } })) });
  if (url.startsWith(`${api}/playlists?`) && method === "POST") {
    // The cap as it was met on 15-16 Sept 2026: a 429 whose reason reads RATE_LIMIT_EXCEEDED.
    if (capPlaylists)
      return json(
        {
          error: {
            code: 429,
            message: "The request cannot be completed because you have exceeded a rate limit.",
            errors: [{ domain: "youtube.playlist", reason: "RATE_LIMIT_EXCEEDED" }],
          },
        },
        429,
      );
    const { snippet } = JSON.parse(String(init.body)) as { snippet: { title: string } };
    const id = `PL${playlists.size + 1}`;
    playlists.set(snippet.title, id);
    return json({ id });
  }
  if (url.startsWith(`${api}/playlistItems?`) && method === "GET")
    return json({
      items: playlistItems.has(`${q.get("playlistId")}/${q.get("videoId")}`) ? [{ id: "x" }] : [],
    });
  if (url.startsWith(`${api}/playlistItems?`) && method === "POST") {
    const { snippet } = JSON.parse(String(init.body)) as {
      snippet: { playlistId: string; resourceId: { videoId: string } };
    };
    playlistItems.add(`${snippet.playlistId}/${snippet.resourceId.videoId}`);
    return json({ id: "item" });
  }
  if (url.startsWith(`${api}/commentThreads?`))
    return json(method === "GET" ? { items: [] } : { id: "thread" });
  if (url.startsWith(`${api}/videos?part=snippet,status,statistics`)) {
    const id = q.get("id")!;
    return json({
      items: [{ id, snippet: { title: "t" }, status: { privacyStatus: livePrivacy.get(id) ?? "private" } }],
    });
  }
  if (url.startsWith(`${api}/videos?part=snippet&id=`))
    return json({
      items: [
        {
          id: q.get("id"),
          snippet: {
            channelId: config.youtubeChannelId,
            title: "t",
            description: "d",
            categoryId: "20",
            tags: ["typed-in-studio"],
          },
        },
      ],
    });
  if (url.startsWith(`${api}/videos?part=snippet`) && method === "PUT") return json({ id: "ok" });
  throw new Error(`unrouted fetch in a hermetic test: ${method} ${url}`);
}) as typeof fetch;

const since = (mark: number) => calls.slice(mark);
const hit = (mark: number, method: string, part: string) =>
  since(mark).filter((c) => c.startsWith(`${method} `) && c.includes(part));
const INSERTS = "googleapis.com/upload/youtube/v3/videos?uploadType=resumable";

/** A match folder as the render leaves it, ready for the long-form's upload. */
async function longFormDir(id: number, left: string, right: string, opts: { tags?: string[] } = {}) {
  const dir = path.join(media, String(id));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `final-${id}.mp4`), Buffer.alloc(1024, 1));
  await writeFile(
    path.join(dir, `match-${id}.title.txt`),
    `<HOOK> | ${left} vs ${right} | MCSR Ranked 1v1\n`,
  );
  await writeFile(
    path.join(dir, `match-${id}.title.edited.txt`),
    `Does the lead ever settle? | ${left} vs ${right} | MCSR Ranked 1v1\n`,
  );
  await writeFile(path.join(dir, "thumbnail.png"), "png");
  if (opts.tags) await writeFile(path.join(dir, `match-${id}.tags.txt`), `${opts.tags.join("\n")}\n`);
  return dir;
}

/** A Short cut behind its saved hook, ready for its upload. */
async function shortDir(id: number, left: string, right: string) {
  const dir = path.join(media, String(id));
  await mkdir(dir, { recursive: true });
  const hook = "DOES THE LEAD EVER SETTLE?";
  await writeFile(
    path.join(dir, `match-${id}.title.edited.txt`),
    `Does the lead ever settle? | ${left} vs ${right} | MCSR Ranked 1v1\n`,
  );
  await writeFile(path.join(dir, `short-${id}.hook.txt`), `${hook}\n`);
  await writeFile(
    path.join(dir, `short-${id}.cut.json`),
    JSON.stringify({
      gameMatchId: id,
      startMs: 0,
      endMs: 20000,
      pov: "left",
      hook,
      pickCreatedAt: "t",
      renderedAt: "t",
    }),
  );
  await writeFile(
    path.join(dir, `short-${id}.title.txt`),
    `${hook} | ${left} vs ${right} #mcsr #minecraft\n`,
  );
  await writeFile(path.join(dir, `short-${id}.description.txt`), buildShortDescription(id, left, right));
  await writeFile(path.join(dir, `short-${id}.mp4`), Buffer.alloc(1024, 2));
  return dir;
}

const record = (videoId: string, extra: Partial<UploadRecord> = {}): UploadRecord => ({
  videoId,
  uploadedAt: "2026-10-01T19:00:00Z",
  publishAt: null,
  privacyStatus: "public",
  thumbnailVariant: null,
  title: "t",
  source: "dashboard",
  ...extra,
});

/** A spy standing in for `videos.insert`, for the cases where its arguments are the point. */
const spySend = () => {
  const sent: UploadOptions[] = [];
  const send = async (opts: UploadOptions): Promise<UploadResult> => {
    sent.push(opts);
    return { videoId: `vidSpy${sent.length}`, privacyStatus: "private", publishAt: opts.publishAt ?? null };
  };
  return { sent, send };
};

try {
  await mkdir(archiveDir, { recursive: true });
  await writeFile(tokenFile, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }));
  const { beginUpload, finishOnYouTube, hookRefusal, resumeUpload, retryFailedPlaylists } =
    await import("./youtubeUpload.js");
  const { readUpload, writeUpload } = await import("./youtubeStore.js");

  /* --- 1. <HOOK> anywhere in the title is refused before a byte is sent -------------------------- */
  {
    const id = 13782182;
    const dir = await longFormDir(id, "silverrruns", "ANJOUU");
    await writeFile(
      path.join(dir, `match-${id}.title.edited.txt`),
      "Down to the last <HOOK> | silverrruns vs ANJOUU | MCSR Ranked 1v1\n",
    );
    const refused = await hookRefusal(id, "video");
    // The one string that must never reach YouTube; a placeholder mid-title is no saved hook either.
    assert.equal(refused?.status, 400, JSON.stringify(refused));
    assert.match(String(refused?.error), /<HOOK>/);
    const { sent, send } = spySend();
    const begun = await beginUpload(id, { kind: "video", privacyStatus: "private", publishAt: LATER }, send);
    assert.ok("error" in begun, "the upload itself refuses it too");
    assert.equal(sent.length, 0, "and videos.insert is never reached");
    await rm(dir, { recursive: true });
    console.log("OK: a title carrying <HOOK> anywhere is refused before videos.insert");
  }

  /* --- 2, 3, 4 (first video of a pair). The long-form's upload, end to end ----------------------- */
  {
    const id = 13560037; // v_strid vs doogile, a real ranked match
    await longFormDir(id, "v_strid", "doogile", {
      tags: ["v_strid", "doogile", "mcsr ranked", "minecraft speedrun"],
    });
    const { sent, send } = spySend();
    const mark = calls.length;
    const begun = await beginUpload(id, { kind: "video", privacyStatus: "private", publishAt: LATER }, send);
    assert.ok(!("error" in begun), JSON.stringify(begun));
    const done = await begun.finished;
    assert.equal(done.error, null, "the upload went through");
    assert.deepEqual(done.warnings, [], `no finish step failed: ${JSON.stringify(done.warnings)}`);
    // Upload sends match-<id>.tags.txt: the nicknames are the tags a viewer searches by.
    for (const tag of ["v_strid", "doogile", "mcsr ranked", "minecraft speedrun"])
      assert.ok(sent[0]!.tags?.includes(tag), `tag "${tag}" sent: ${JSON.stringify(sent[0]!.tags)}`);
    const rec = await readUpload(id);
    assert.equal(rec?.source, "dashboard", "the chain's own record");
    assert.equal(rec?.finished?.playlists, null, "the playlist step is done");
    // The season and one playlist per player — joined at the wire, not only planned.
    for (const title of [SEASON, "v_strid · MCSR Ranked matches", "doogile · MCSR Ranked matches"])
      assert.ok(playlistItems.has(`${playlists.get(title)}/vidSpy1`), `joined "${title}"`);
    // The pair's first video: no matchup playlist (22 of 28 held one video on 22 Sept 2026) —
    // under any spelling, not only the one the second video will use.
    assert.deepEqual(
      [...playlists.keys()].filter((title) => title.includes(" vs ")),
      [],
      "no matchup playlist on a first meeting",
    );
    assert.equal(hit(mark, "POST", INSERTS).length, 0, "the send seam stood in for videos.insert");
    console.log("OK: the long-form sends its tags and joins the season and both players' playlists");
  }

  /* --- 4. The pair's second video creates the matchup playlist, the first added alongside -------- */
  {
    const first = 13446429; // Infume vs Feinberg
    const second = 13673240; // Infume vs Feinberg again — a real rematch
    await longFormDir(first, "Infume", "Feinberg");
    await writeUpload(first, record("vidFirstIF"));
    await longFormDir(second, "Infume", "Feinberg");
    await writeUpload(second, record("vidSecondIF"));
    livePrivacy.set("vidSecondIF", "public");
    const steps = await finishOnYouTube(second, "vidSecondIF");
    assert.equal(steps.playlists, null, JSON.stringify(steps));
    const matchup = playlists.get("Feinberg vs Infume · MCSR Ranked");
    assert.ok(matchup, `the matchup playlist exists now: ${JSON.stringify([...playlists.keys()])}`);
    assert.ok(playlistItems.has(`${matchup}/vidSecondIF`), "the second video is in it");
    assert.ok(playlistItems.has(`${matchup}/vidFirstIF`), "and the first one was added alongside");
    console.log("OK: a matchup playlist arrives with the pair's second video, the first added alongside");
  }

  /* --- 7, 8. The playlist cap is a ledger line the nightly presses again ------------------------ */
  {
    const id = 12929221; // Feinberg vs silverrruns: the Feinberg playlist exists, silverrruns' does not
    await longFormDir(id, "Feinberg", "silverrruns");
    await writeUpload(id, record("vidCap"));
    livePrivacy.set("vidCap", "public");
    capPlaylists = true;
    const first = await finishOnYouTube(id, "vidCap");
    assert.equal(typeof first.playlists, "string", "the capped join is recorded as failed");
    // The panel line names the cap and says who retries it, rather than quoting Google's 429.
    assert.match(String(first.playlists), /silverrruns · MCSR Ranked matches/);
    assert.match(String(first.playlists), /cap/);
    assert.match(String(first.playlists), /nightly retries it/);
    assert.equal(first.comment, null, "the cap does not hold up the steps that could go through");
    assert.equal((await readUpload(id))?.finished?.playlists, first.playlists, "and it is in the ledger");

    // The nightly's tick, with the cap rolled over: no press from anyone.
    capPlaylists = false;
    const mark = calls.length;
    await retryFailedPlaylists();
    assert.equal((await readUpload(id))?.finished?.playlists, null, "the retry cleared the step");
    assert.ok(playlistItems.has(`${playlists.get("silverrruns · MCSR Ranked matches")}/vidCap`));
    // A retry presses only what failed: a second comment or thumbnail is a hand-removal in Studio.
    assert.equal(hit(mark, "POST", "/commentThreads?").length, 0, "the posted comment is not posted again");
    assert.equal(hit(mark, "POST", "/thumbnails/set").length, 0, "the set thumbnail is not set again");
    assert.equal(hit(mark, "POST", "/playlistItems?").length, 1, "only the join that failed is made");
    console.log("OK: a capped playlist join lands in the ledger and the nightly's retry finishes it alone");
  }

  /* --- 9, 10. Uploads off: Finish still repairs a Studio upload, and never inserts -------------- */
  {
    const id = 13448958; // Infume vs bbiddd
    const dir = await longFormDir(id, "Infume", "bbiddd", { tags: ["Infume", "bbiddd"] });
    config.youtubeUploadEnabled = false;
    const { sent, send } = spySend();
    const refused = await beginUpload(
      id,
      { kind: "video", privacyStatus: "private", publishAt: LATER },
      send,
    );
    assert.ok("error" in refused && refused.status === 403, "videos.insert is the gated call");
    assert.equal(sent.length, 0);

    await writeUpload(id, record("vidStudio", { source: "studio" }));
    livePrivacy.set("vidStudio", "public");
    const mark = calls.length;
    const steps = await finishOnYouTube(id, "vidStudio");
    assert.equal(steps.playlists, null, "playlists repaired");
    assert.equal(steps.comment, null, "the channel's comment posted");
    assert.equal(steps.tags, null, "tags added");
    assert.equal(hit(mark, "POST", "/commentThreads?").length, 1);
    const put = bodies.filter((b) => b.method === "PUT" && b.url.includes("/videos?part=snippet")).at(-1);
    const snippet = (JSON.parse(put!.body) as { snippet: { tags: string[]; description: string } }).snippet;
    assert.deepEqual(snippet.tags, ["typed-in-studio", "Infume", "bbiddd"], "a tag typed in Studio survives");
    assert.equal(snippet.description, "d", "the whole snippet went back, description included");
    // Nobody confirmed a variant here: the image picked in Studio stays.
    assert.match(String(steps.thumbnail), /left alone/);
    assert.equal(hit(mark, "POST", "/thumbnails/set").length, 0);
    assert.equal(
      since(mark).filter((c) => c.includes(INSERTS)).length,
      0,
      "Finish never calls videos.insert",
    );

    // Once the operator confirms a variant, the same press sets it.
    await writeFile(path.join(dir, "thumbnail.walking-crossed.png"), "variant");
    await writeFile(
      path.join(dir, "thumbnail.json"),
      JSON.stringify({
        chosen: "walking-crossed",
        chosenBy: "operator",
        hookText: null,
        variants: [{ key: "walking-crossed", file: "thumbnail.walking-crossed.png" }],
      }),
    );
    const rec = (await readUpload(id))!;
    await writeUpload(id, { ...rec, finished: { ...rec.finished, thumbnail: undefined } });
    const mark2 = calls.length;
    const confirmed = await finishOnYouTube(id, "vidStudio");
    assert.equal(confirmed.thumbnail, null, JSON.stringify(confirmed));
    assert.equal(
      hit(mark2, "POST", "/thumbnails/set?videoId=vidStudio").length,
      1,
      "the confirmed variant goes on",
    );
    config.youtubeUploadEnabled = true;
    console.log("OK: with uploads off, Finish repairs a Studio upload and leaves an unconfirmed thumbnail");
  }

  /* --- 5, 6, 11. The Short: no playlists, the long-form's link, and a Retry after a chunk 503 ---- */
  {
    const id = 12898432; // bbiddd vs BadGamer
    const dir = await shortDir(id, "bbiddd", "BadGamer");
    const shortRecord = path.join(dir, "youtube-short.json");

    // Before the long-form has an id there is nothing to link.
    const { sent, send } = spySend();
    const early = await beginUpload(id, { kind: "short", privacyStatus: "private", publishAt: LATER }, send);
    assert.ok(!("error" in early), JSON.stringify(early));
    await early.finished;
    assert.ok(!sent[0]!.description.includes("youtu.be/"), "no link before the long-form is up");
    await rm(shortRecord);

    // The long-form is up: the Short says where the match is. Sent with the real client this time,
    // and the first attempt dies on a chunk 503.
    await writeUpload(id, record("vidLongBB", { privacyStatus: "private", publishAt: LATER }));
    const session = sessionPath(path.join(dir, `short-${id}.mp4`));
    sessionAnswer = () => new Response("backend error", { status: 503 });
    const mark = calls.length;
    const first = await beginUpload(id, { kind: "short", privacyStatus: "private", publishAt: LATER });
    assert.ok(!("error" in first), JSON.stringify(first));
    const failed = await first.finished;
    assert.match(String(failed.error), /could not be reached or failed mid-upload/);
    assert.equal(existsSync(session), true, "a 503 keeps the session for the Retry");
    assert.equal(existsSync(shortRecord), false, "nothing recorded as up");
    const meta = JSON.parse(bodies.filter((b) => b.url.includes(INSERTS)).at(-1)!.body) as {
      snippet: { description: string };
    };
    assert.match(
      meta.snippet.description,
      /^.*\nthe whole match: https:\/\/youtu\.be\/vidLongBB\n/,
      "the link, under the first line",
    );

    // The operator's Retry: YouTube holds nothing yet (308, no Range), the bytes go up on the same session.
    sessionAnswer = (init) =>
      String((init.headers as Record<string, string>)["content-range"]).startsWith("bytes */")
        ? new Response("", { status: 308 })
        : json({ id: "vidShortOnce", status: { privacyStatus: "private", publishAt: LATER } });
    const retry = await beginUpload(id, { kind: "short", privacyStatus: "private", publishAt: LATER });
    assert.ok(!("error" in retry), JSON.stringify(retry));
    const up = await retry.finished;
    assert.equal(up.error, null, String(up.error));
    assert.equal(hit(mark, "POST", INSERTS).length, 1, "one videos.insert across the failure and its Retry");
    assert.equal((await readUpload(id, "short"))?.videoId, "vidShortOnce");
    assert.equal(existsSync(session), false, "the finished upload forgets its session");
    // A Short joins no playlist, gets no custom thumbnail and no comment.
    for (const part of ["/playlists?", "/playlistItems?", "/thumbnails/set", "/commentThreads?"])
      assert.equal(since(mark).filter((c) => c.includes(part)).length, 0, `no ${part} call for a Short`);
    await rm(shortRecord);

    // A Short description of one line (hand-edited, say): the promise has no "if it has two lines".
    await writeFile(
      path.join(dir, `short-${id}.description.txt`),
      "bbiddd vs BadGamer, the whole match is on the channel.",
    );
    const oneLine = spySend();
    const lone = await beginUpload(
      id,
      { kind: "short", privacyStatus: "private", publishAt: LATER },
      oneLine.send,
    );
    assert.ok(!("error" in lone));
    await lone.finished;
    await deviation(
      'A Short\'s description gains "the whole match: https://youtu.be/<id>" at upload time',
      () =>
        assert.match(
          oneLine.sent[0]!.description,
          /youtu\.be\/vidLongBB/,
          "a one-line description got no link",
        ),
    );
    console.log("OK: a Short links its long-form, joins nothing, and a Retry after a 503 inserts once");
  }

  /* --- 12. A cut-short long-form resumes its own session over the scan's record ----------------- */
  {
    const id = 13617328; // nolqndo vs thecamo6
    const dir = await longFormDir(id, "nolqndo", "thecamo6");
    const file = path.join(dir, `final-${id}.mp4`);
    // The scan paired the half-uploaded video by its description link (2 Oct 2026, the Grand Final).
    await writeUpload(
      id,
      record("vidHalf", { source: "studio", privacyStatus: "private", publishAt: LATER }),
    );
    await writeFile(
      sessionPath(file),
      JSON.stringify({ filePath: file, total: 1024, sessionUrl: "https://upload.test/session/gf" }),
    );
    const probes: string[] = [];
    sessionAnswer = (init) => {
      probes.push(String((init.headers as Record<string, string>)["content-range"]));
      return json({ id: "vidHalf", status: { privacyStatus: "private", publishAt: LATER } });
    };
    const mark = calls.length;
    const settled = await resumeUpload(id, "video");
    assert.equal(settled, null, String(settled));
    assert.deepEqual(probes, ["bytes */1024"], "the session was probed and found complete");
    assert.equal(hit(mark, "POST", INSERTS).length, 0, "no fresh videos.insert");
    const rec = await readUpload(id);
    assert.equal(rec?.source, "dashboard", "the chain's record replaces the scan's");
    // ...so the finish steps run as for any dashboard upload, not declining as "uploaded elsewhere".
    assert.equal(rec?.finished?.thumbnail, null, `thumbnail: ${rec?.finished?.thumbnail}`);
    assert.equal(hit(mark, "POST", "/thumbnails/set?videoId=vidHalf").length, 1);
    console.log("OK: a cut-short long-form resumes its session and finishes as a dashboard upload");
  }

  /* --- 13, 14, 15. Resume without a usable session ------------------------------------------------ */
  {
    const id = 13766294; // silverrruns vs dandannyboy
    const dir = await shortDir(id, "silverrruns", "dandannyboy");
    const file = path.join(dir, `short-${id}.mp4`);
    const session = sessionPath(file);
    const writeSession = () =>
      writeFile(
        session,
        JSON.stringify({ filePath: file, total: 1024, sessionUrl: "https://upload.test/session/r" }),
      );

    // A record with no `source` is not the chain's own: no session, no trust.
    const { sent, send } = spySend();
    const { source: _, ...legacy } = record("vidLegacy");
    await writeUpload(id, legacy, "short");
    const named = await resumeUpload(id, "short", send);
    assert.match(String(named), /Studio/, "anything but a dashboard record fails naming Studio");
    assert.equal(sent.length, 0);
    await rm(path.join(dir, "youtube-short.json"));

    // A probe answered 503: "try again", not "gone" — nothing started, the session kept.
    await writeSession();
    sessionAnswer = () => new Response("backend error", { status: 503 });
    let mark = calls.length;
    const transient = await resumeUpload(id, "short");
    assert.match(String(transient), /try again/, String(transient));
    assert.equal(hit(mark, "POST", INSERTS).length, 0, "a 503 probe starts no second upload");
    assert.equal(existsSync(session), true, "and keeps the session for the next press");
    assert.equal(await readUpload(id, "short"), null);

    // The same 503 with the scan's record on disk: still a "try again", not "the session is gone".
    await writeUpload(id, record("vidScan", { source: "studio" }), "short");
    const withScan = await resumeUpload(id, "short");
    assert.equal(existsSync(session), true, "the session survives this one too");
    await deviation(
      'The resume probe itself reads a 5xx/429 as "try again", not "gone" (handbook, cut-short upload)',
      () =>
        assert.doesNotMatch(
          String(withScan),
          /session is gone/,
          `a 503 probe with the scan's record answers: ${String(withScan).slice(0, 160)}…`,
        ),
    );
    await rm(path.join(dir, "youtube-short.json"));

    // A session YouTube no longer honours (404): resumeOnly never falls through to a fresh start.
    sessionAnswer = () => new Response("", { status: 404 });
    mark = calls.length;
    const gone = await resumeUpload(id, "short");
    assert.notEqual(gone, null, "the step fails rather than settling");
    assert.equal(hit(mark, "POST", INSERTS).length, 0, "and no second videos.insert is started");
    console.log("OK: a resume with no usable session names Studio or waits, never starts a second upload");
  }

  /* --- 16, 17. The gates a resume must still respect ------------------------------------------- */
  {
    const id = 13782182; // silverrruns vs ANJOUU
    const dir = await shortDir(id, "silverrruns", "ANJOUU");
    const file = path.join(dir, `short-${id}.mp4`);
    await writeFile(
      sessionPath(file),
      JSON.stringify({ filePath: file, total: 1024, sessionUrl: "https://upload.test/session/g" }),
    );

    // Not a broken promise: a resume finishes a videos.insert already started while the flag was
    // on, it starts no new one. Whether it should is the operator's call, so it is asked, not pinned.
    config.youtubeUploadEnabled = false;
    const off = spySend();
    await resumeUpload(id, "short", off.send);
    if (off.sent.length > 0)
      console.log(
        "QUESTION for the operator: with youtubeUploadEnabled switched off, a restart still finishes " +
          "a videos.insert begun while it was on (resumeUpload never reads the flag; shortFlow.ts " +
          "advance() resumes before its uploadsOn() gate). Finish it, or leave it for Studio?",
      );
    config.youtubeUploadEnabled = true;
    await rm(path.join(dir, "youtube-short.json"), { force: true });

    // A runner who withdrew permission while the bytes were in flight, then a restart.
    await writeFile(
      sessionPath(file),
      JSON.stringify({ filePath: file, total: 1024, sessionUrl: "https://upload.test/session/g" }),
    );
    config.blockedPlayers = [...saved.blocked, "TestBlocked"];
    await writeFile(path.join(dir, "chat-TestBlocked.json"), "[]");
    assert.equal((await hookRefusal(id, "short"))?.status, 403, "the upload's own gate sees the block");
    const blocked = spySend();
    await resumeUpload(id, "short", blocked.send);
    await deviation(
      'A blocked match is never uploaded (long-form or Short) (CLAUDE.md "Blocked players")',
      () => assert.equal(blocked.sent.length, 0, "a resume finished a blocked match's Short"),
    );
    config.blockedPlayers = saved.blocked;
    console.log("OK: the resume gates were probed (see DEVIATION lines, if any)");
  }

  // A deviation must not read green to anything grepping for "all checks passed". Once the code
  // keeps a clause, turn its deviation() into a plain assert so it stays pinned.
  if (deviations.length > 0)
    console.log(
      `youtubeUpload.finish.contract: KNOWN-FAILING — ${deviations.length} deviation(s): ` +
        `${deviations.join("; ")}. Every other check passed.`,
    );
  else console.log("youtubeUpload.finish.contract: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  config.mediaDir = saved.mediaDir;
  config.youtubePlaylistTitle = saved.playlist;
  config.youtubeUploadEnabled = saved.enabled;
  config.blockedPlayers = saved.blocked;
  await rm(media, { recursive: true, force: true });
}
