// Contract test for "Adopt a Studio draft" (POST /api/youtube/adopt/:id), written from the docs
// alone by someone outside the project, then driven through the route's public entry point
// (`handleYoutubeRoute`) against an in-memory fake of YouTube and the MCSR API (real match JSONs
// from src/fixtures). No network, no /media, no Chromium. Run:
//   MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/dashboard/youtubeRoutes.adopt.contract.test.ts
//
// What the docs promise (CLAUDE.md "Adopt a Studio draft" + "Known pitfalls";
// handbook/claude-md-reference.md "Adopt a Studio draft" and the blocked-players bullet):
//   1. Adopt writes the dashboard's title, description and tags onto the pasted video through
//      `videos.update` — it REPLACES the draft's title and description.
//   2. Then it runs the finish steps (playlists, thumbnail, comment, tags).
//   3. It is NOT behind `youtubeUploadEnabled` (`videos.update` is not the audited call), and it
//      never calls `videos.insert`.
//   4. The write is what makes the video findable: a blank draft pairs with no match, the adopted
//      one pairs by its `/matches/<id>` link.
//   5. Refuses a malformed id.
//   6. Refuses an id already recorded for another match.
//   7. Refuses an id recorded as ANY match's Short.
//   8. Refuses a video three minutes or shorter (and only those: 3:01 is a match video).
//   9. Refuses a title still reading `<HOOK>`.
//  10. Refuses a description that would not pair.
//  11. Refuses when no thumbnail variant has `chosenBy: "operator"`; with one, the finish puts
//      that image on (the refusal exists so YouTube's auto frame is not left on).
//  12. Refuses a video on someone else's channel.
//  13. Refuses a blocked player, before `videos.update` (POV clip on disk here; the title, chat and
//      API pair are pinned in youtubeRoutes.test.ts / youtube.test.ts).
//  14. `exportStale` refuses adopt with one line until re-encoded — pinned in
//      youtubeRoutes.contract.test.ts, not repeated here.
//  15. Re-adopting the SAME video carries the finish ledger forward: a second press redoes no step.
//  16. A different video for the same match starts afresh.
//  17. The comment step reads the video's threads and posts nothing when the channel's comment is
//      already there.
//  18. Never something `finishOnYouTube` can reach: the Finish button leaves a video's title and
//      description as they are.
// Every refusal above is also checked to make no YouTube write and to record nothing.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, matchDir } from "../config.js";
import { HOOK_PLACEHOLDER } from "../pipeline/title.js";
import { manifestPath } from "../thumbnails/thumbnailVariants.js";
import { channelVideoFor, type ChannelVideo } from "../youtube/channelUploads.js";
import { readUpload, uploadTextFor, writeUpload } from "../youtube/youtubeStore.js";
import { handleYoutubeRoute } from "./youtubeRoutes.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const tmp = await mkdtemp(path.join(tmpdir(), "mcsr-adopt-contract-"));
const saved = {
  mediaDir: config.mediaDir,
  blocked: config.blockedPlayers,
  uploadEnabled: config.youtubeUploadEnabled,
  studioAutomation: config.studioAutomation,
  autoFinish: config.youtubeAutoFinish,
  token: process.env.YOUTUBE_TOKEN_FILE,
};
config.mediaDir = path.join(tmp, "media");
config.blockedPlayers = ["TestBlockedRunner"];
// Off, so the finish never launches a Studio browser (a real Chrome) for the pin step.
config.studioAutomation = false;
config.youtubeAutoFinish = false;
process.env.YOUTUBE_TOKEN_FILE = path.join(tmp, "token.json");
await writeFile(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);
const MINE = config.youtubeChannelId;

/* --- A fake YouTube and MCSR API --------------------------------------------------------------- */

interface Live {
  channelId: string;
  title: string;
  description: string;
  tags: string[];
  privacyStatus: string;
  duration: string;
}
const live = new Map<string, Live>();
/** videoId -> the channel ids of its top-level comment authors. No comment text, ever. */
const commentAuthors = new Map<string, string[]>();
const calls: Array<{ method: string; url: string; body: unknown }> = [];
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init?.method ?? "GET";
  let body: unknown = init?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* form-encoded token refresh */
    }
  }
  calls.push({ method, url, body });
  if (url.startsWith("https://oauth2.googleapis.com/")) return json({ access_token: "t", expires_in: 3600 });
  const u = new URL(url);
  if (u.hostname === "api.mcsrranked.com") {
    const id = /^\/matches\/(\d+)$/.exec(u.pathname)?.[1];
    const file = id ? path.join(FIXTURES, `match-${id}.json`) : "";
    if (file && existsSync(file))
      return json({ status: "success", data: JSON.parse(readFileSync(file, "utf8")) });
    return json({ status: "error", data: "not found" }, 404);
  }
  if (u.pathname === "/youtube/v3/videos" && method === "GET") {
    const ids = (u.searchParams.get("id") ?? "").split(",");
    return json({
      items: ids
        .filter((id) => live.has(id))
        .map((id) => {
          const v = live.get(id)!;
          return {
            id,
            snippet: {
              channelId: v.channelId,
              title: v.title,
              description: v.description,
              categoryId: "20",
              tags: v.tags,
              publishedAt: "2026-10-13T19:00:00Z",
            },
            status: { privacyStatus: v.privacyStatus },
            statistics: {},
            contentDetails: { duration: v.duration },
          };
        }),
    });
  }
  if (u.pathname === "/youtube/v3/videos" && method === "PUT") {
    const b = body as { id: string; snippet: { title: string; description: string; tags?: string[] } };
    const v = live.get(b.id);
    if (!v) return json({ error: { message: "not found", errors: [{ reason: "videoNotFound" }] } }, 404);
    Object.assign(v, {
      title: b.snippet.title,
      description: b.snippet.description,
      tags: b.snippet.tags ?? [],
    });
    return json({ id: b.id });
  }
  if (u.pathname === "/youtube/v3/commentThreads" && method === "GET") {
    const authors = commentAuthors.get(u.searchParams.get("videoId") ?? "") ?? [];
    return json({
      items: authors.map((author, i) => ({
        id: `thread${i}`,
        snippet: {
          topLevelComment: {
            snippet: {
              authorDisplayName: "",
              textDisplay: "",
              publishedAt: "2026-10-13T19:05:00Z",
              likeCount: 0,
              authorChannelId: { value: author },
            },
          },
        },
      })),
    });
  }
  if (u.pathname === "/youtube/v3/commentThreads" && method === "POST") {
    const videoId = (body as { snippet: { videoId: string } }).snippet.videoId;
    commentAuthors.set(videoId, [...(commentAuthors.get(videoId) ?? []), MINE]);
    return json({ id: "posted" });
  }
  if (u.pathname === "/youtube/v3/playlists")
    return json(method === "GET" ? { items: [] } : { id: `PL${calls.length}` });
  if (u.pathname === "/youtube/v3/playlistItems")
    return json(method === "GET" ? { items: [] } : { id: "item" });
  if (u.pathname === "/upload/youtube/v3/thumbnails/set") return json({});
  throw new Error(`no network in this test: ${method} ${url}`);
}) as typeof fetch;

/* --- Helpers ----------------------------------------------------------------------------------- */

const isYouTube = (c: { url: string }) => /^https:\/\/www\.googleapis\.com\/(upload\/)?youtube\//.test(c.url);
const since = (from: number) => calls.slice(from);
const ytWrites = (from: number) => since(from).filter((c) => isYouTube(c) && c.method !== "GET");
const ytCalls = (from: number) => since(from).filter(isYouTube);
const hit = (from: number, method: string, pathPart: string, videoId?: string) =>
  since(from).filter(
    (c) =>
      c.method === method &&
      c.url.includes(pathPart) &&
      (videoId === undefined || c.url.includes(videoId) || JSON.stringify(c.body ?? "").includes(videoId)),
  );

type Answer = { status: number; body: Record<string, unknown> };
async function call(action: string, matchId: number, payload: unknown): Promise<Answer> {
  const answers: Answer[] = [];
  const handled = await handleYoutubeRoute(
    { method: "POST", headers: {} } as unknown as IncomingMessage,
    {} as ServerResponse,
    ["", "youtube", action, String(matchId)],
    {
      json: (_res, status, body) => void answers.push({ status, body: body as Record<string, unknown> }),
      readBody: async () => JSON.stringify(payload),
      matchDir,
      parseId: (raw) => (raw && /^\d+$/.test(raw) ? Number(raw) : null),
    },
  );
  assert.ok(handled, "the youtube route group owns /api/youtube/*");
  assert.equal(answers.length, 1, "one answer per request");
  return answers[0]!;
}
const adopt = (matchId: number, videoId: unknown) => call("adopt", matchId, { videoId });
const errorOf = (a: Answer) => String(a.body.error ?? "");

const fixture = (matchId: number) =>
  JSON.parse(readFileSync(path.join(FIXTURES, `match-${matchId}.json`), "utf8")) as {
    players: Array<{ nickname: string }>;
  };
const VARIANT = { key: "walking-crossed", file: "thumbnail.walking-crossed.png" };

/** Everything the docs say an adoptable match has on disk: a hooked title, a pairing description,
 *  tags, and a thumbnail variant the operator confirmed. Hooks are about the match, never a label
 *  or a result. */
async function prepare(
  matchId: number,
  o: { title?: string; description?: string; chosenBy?: "operator" | "auto" | null } = {},
) {
  const dir = matchDir(matchId);
  await mkdir(dir, { recursive: true });
  const [left, right] = existsSync(path.join(FIXTURES, `match-${matchId}.json`))
    ? fixture(matchId).players.map((p) => p.nickname)
    : ["runnerA", "runnerB"];
  await writeFile(
    path.join(dir, `match-${matchId}.title.txt`),
    `${o.title ?? `Down to the last pearl | ${left} vs ${right} | MCSR Ranked 1v1 | Minecraft Speedrun`}\n`,
  );
  await writeFile(
    path.join(dir, `match-${matchId}.description.txt`),
    o.description ??
      `${left} vs ${right}, mcsr ranked 1v1 on the same seed.\n\nmatch page: https://mcsrranked.com/matches/${matchId}\n\n#MCSRRanked #MCSR`,
  );
  await writeFile(path.join(dir, `match-${matchId}.tags.txt`), `${left}\n${right}\nmcsr ranked\n`);
  if (o.chosenBy !== null) {
    await writeFile(path.join(dir, VARIANT.file), "png bytes");
    await writeFile(
      manifestPath(dir),
      JSON.stringify({
        chosen: VARIANT.key,
        chosenBy: o.chosenBy ?? "operator",
        hookText: null,
        variants: [VARIANT],
      }),
    );
  }
}
/** A bare Studio draft: every box left empty, the file name as its title. */
const draft = (videoId: string, o: Partial<Live> = {}) =>
  live.set(videoId, {
    channelId: MINE,
    title: "final.mp4",
    description: "",
    tags: [],
    privacyStatus: "public",
    duration: "PT10M12S",
    ...o,
  });
const asChannelVideo = (videoId: string): ChannelVideo => {
  const v = live.get(videoId)!;
  return {
    videoId,
    title: v.title,
    publishedAt: "2026-10-13T19:00:00Z",
    description: v.description,
    privacyStatus: v.privacyStatus,
    durationSec: 612,
  };
};

/** A refusal: the expected status and words, no YouTube write, no record, the draft untouched. */
async function assertRefused(matchId: number, videoId: unknown, status: number, words: RegExp, why: string) {
  const before = typeof videoId === "string" ? JSON.stringify(live.get(videoId) ?? null) : "null";
  const hadRecord = existsSync(path.join(matchDir(matchId), "youtube.json"));
  const from = calls.length;
  const a = await adopt(matchId, videoId);
  assert.equal(a.status, status, `${why}: ${JSON.stringify(a.body)}`);
  assert.match(errorOf(a), words, why);
  assert.deepEqual(ytWrites(from), [], `${why}: nothing written to YouTube`);
  assert.equal(
    existsSync(path.join(matchDir(matchId), "youtube.json")),
    hadRecord,
    `${why}: no record written`,
  );
  if (typeof videoId === "string")
    assert.equal(JSON.stringify(live.get(videoId) ?? null), before, `${why}: the draft is as it was`);
  return from;
}

try {
  /* --- 1-4, 11: the happy path, with uploads switched off -------------------------------------- */
  {
    // youtubeUploadEnabled gates videos.insert only (the 15 Sept 2026 audit); Adopt is not behind it.
    config.youtubeUploadEnabled = false;
    const M = 13446429;
    await prepare(M);
    draft("DraftVideo1");
    // The reason Adopt exists: a blank draft has no /matches/<id> link, so nothing pairs it.
    assert.equal(
      channelVideoFor(M, [asChannelVideo("DraftVideo1")]),
      null,
      "a blank draft pairs with no match",
    );
    const expected = await uploadTextFor(M, "video");
    const from = calls.length;
    const a = await adopt(M, "DraftVideo1");
    assert.equal(a.status, 200, JSON.stringify(a.body));

    // 1. One videos.update carrying exactly the text the dashboard holds (the same text the kit pastes).
    const puts = hit(from, "PUT", "/youtube/v3/videos?part=snippet", "DraftVideo1");
    assert.ok(puts.length >= 1, "the metadata goes on through videos.update");
    const sent = (puts[0]!.body as { snippet: { title: string; description: string; tags?: string[] } })
      .snippet;
    assert.equal(sent.title, expected.title, "the title is replaced with the dashboard's");
    assert.equal(sent.description, expected.description, "the description is replaced with the dashboard's");
    for (const tag of expected.tags) assert.ok(sent.tags?.includes(tag), `tag "${tag}" goes on with it`);
    assert.equal(a.body.replacedTitle, "final.mp4", "and the route says which title it replaced");
    assert.equal(live.get("DraftVideo1")!.title, expected.title);

    // 3. Never videos.insert — the audited call — on an id that is already on the channel.
    assert.deepEqual(hit(from, "POST", "/upload/youtube/v3/videos"), [], "no videos.insert");

    // 4. Once written, the video pairs itself to this match (and only this one).
    assert.equal(
      channelVideoFor(M, [asChannelVideo("DraftVideo1")])?.videoId,
      "DraftVideo1",
      "the adopted video pairs",
    );

    // 2 + 11. The finish steps run, and the operator's confirmed image goes on (not YouTube's frame).
    assert.deepEqual(
      a.body.finished,
      { playlists: null, thumbnail: null, comment: null, tags: null },
      "every finish step succeeded",
    );
    assert.equal(
      hit(from, "POST", "/thumbnails/set", "DraftVideo1").length,
      1,
      "thumbnails.set with the chosen variant",
    );
    assert.ok(hit(from, "POST", "/playlistItems?", "DraftVideo1").length > 0, "joined its playlists");
    assert.equal(hit(from, "POST", "/commentThreads?", "DraftVideo1").length, 1, "its first comment went up");
    const record = await readUpload(M);
    assert.equal(record?.videoId, "DraftVideo1", "the match now records the adopted video");
    assert.deepEqual(record?.finished, { playlists: null, thumbnail: null, comment: null, tags: null });
    assert.equal(config.youtubeUploadEnabled, false, "and all of it with uploads switched off");
    console.log("OK: adopt writes the dashboard's text via videos.update, then finishes — uploads off");
  }

  /* --- 15: re-adopting the same video redoes no step -------------------------------------------- */
  {
    const M = 13446429;
    const from = calls.length;
    const a = await adopt(M, "DraftVideo1");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    // A second press is the one that once put four pinned comments on one video (26 Sept 2026).
    assert.deepEqual(hit(from, "POST", "/commentThreads?"), [], "no second comment");
    assert.deepEqual(hit(from, "POST", "/playlistItems?"), [], "no playlist join again");
    assert.deepEqual(hit(from, "POST", "/playlists?"), [], "no playlist created");
    assert.deepEqual(hit(from, "POST", "/thumbnails/set"), [], "no second thumbnails.set");
    assert.deepEqual(commentAuthors.get("DraftVideo1"), [MINE], "still exactly one channel comment");
    assert.deepEqual((await readUpload(M))?.finished, {
      playlists: null,
      thumbnail: null,
      comment: null,
      tags: null,
    });
    console.log("OK: re-adopting the same video carries the finish ledger forward");
  }

  /* --- 16: a different video for the same match starts afresh ----------------------------------- */
  {
    const M = 13446429;
    draft("DraftVideo2");
    const from = calls.length;
    const a = await adopt(M, "DraftVideo2");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal((await readUpload(M))?.videoId, "DraftVideo2");
    // The old ledger belongs to the old video: this one gets its own comment and image.
    assert.equal(
      hit(from, "POST", "/commentThreads?", "DraftVideo2").length,
      1,
      "the new video gets its comment",
    );
    assert.equal(hit(from, "POST", "/thumbnails/set", "DraftVideo2").length, 1, "and its thumbnail");
    console.log("OK: another video for the same match starts a fresh ledger");
  }

  /* --- 17: the channel's comment is already there ------------------------------------------------ */
  {
    const M = 13782182;
    await prepare(M);
    draft("HasComment1");
    commentAuthors.set("HasComment1", [MINE]);
    const from = calls.length;
    const a = await adopt(M, "HasComment1");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.ok(hit(from, "GET", "/commentThreads?", "HasComment1").length > 0, "the threads were read first");
    assert.deepEqual(
      hit(from, "POST", "/commentThreads?"),
      [],
      "and nothing was posted over the channel's own comment",
    );
    assert.equal((a.body.finished as { comment?: unknown }).comment, null, "the step still counts as done");
    console.log("OK: the comment step reads the threads and posts nothing when the channel's is up");
  }

  /* --- 5: malformed ids --------------------------------------------------------------------------- */
  // youtube.test.ts pins "", "not-an-id", a youtu.be link, 19 chars, a number and null; these are the
  // other shapes a paste from Studio takes.
  {
    const M = 13448958;
    await prepare(M);
    for (const bad of [
      "DraftVideo",
      "DraftVideo12",
      "Draft Vid01",
      "https://www.youtube.com/watch?v=DraftVideo1",
      "studio.youtube.com/video/DraftVideo1/edit",
      "DraftVidéo1",
      "Draft.Vid01",
      { videoId: "DraftVideo1" },
      ["DraftVideo1"],
    ]) {
      const from = calls.length;
      const a = await adopt(M, bad);
      assert.equal(a.status, 400, `${JSON.stringify(bad)} is not an 11-character id`);
      assert.match(errorOf(a), /not a YouTube video id/);
      assert.deepEqual(ytCalls(from), [], "no YouTube call for a malformed id");
    }
    console.log("OK: a malformed id is refused before any call");
  }

  /* --- 6, 7: an id recorded for another match, long-form or Short ------------------------------- */
  {
    const M = 13448958;
    const record = {
      uploadedAt: "2026-10-01T19:00:00Z",
      publishAt: null,
      privacyStatus: "public",
      thumbnailVariant: null,
      title: "t",
    };
    await mkdir(matchDir(990001), { recursive: true });
    await writeUpload(990001, { ...record, videoId: "OtherMatch1" });
    await mkdir(matchDir(990002), { recursive: true });
    await writeUpload(990002, { ...record, videoId: "OtherShort1" }, "short");
    draft("OtherMatch1");
    draft("OtherShort1", { duration: "PT40S" });
    const a = await assertRefused(M, "OtherMatch1", 409, /990001/, "another match's long-form");
    assert.deepEqual(ytCalls(a), [], "refused off the disk alone");
    const b = await assertRefused(M, "OtherShort1", 409, /Short.*990002/, "another match's Short");
    assert.deepEqual(ytCalls(b), [], "refused off the disk alone");
    console.log("OK: an id another match records, long-form or Short, is refused");
  }

  /* --- 8: three minutes or shorter -------------------------------------------------------------- */
  {
    const M = 13448958;
    // YouTube's line (SHORT_MAX_SEC): exactly three minutes is still a Short.
    draft("ShortLen180", { duration: "PT3M" });
    await assertRefused(M, "ShortLen180", 409, /180s/, "a 3:00 video");
    draft("ShortLen045", { duration: "PT45S" });
    await assertRefused(M, "ShortLen045", 409, /Short/, "a 0:45 video");
    // One second over is the match video, and goes through.
    const M2 = 12929221;
    await prepare(M2);
    draft("LongLen181s", { duration: "PT3M1S" });
    const ok = await adopt(M2, "LongLen181s");
    assert.equal(ok.status, 200, `3:01 is not a Short: ${JSON.stringify(ok.body)}`);
    console.log("OK: a video of three minutes or less is refused, 3:01 is not");
  }

  /* --- 9: a title still reading <HOOK> ----------------------------------------------------------- */
  {
    const M = 13448958;
    draft("DraftVideo3");
    await prepare(M, {
      title: `${HOOK_PLACEHOLDER} | Infume vs bbiddd | MCSR Ranked 1v1 | Minecraft Speedrun`,
    });
    await assertRefused(M, "DraftVideo3", 409, /HOOK/, "a generated title with the placeholder");
    // The edited title is the one that goes up (the publish kit's `.edited.txt` wins), so a hooked
    // generated title does not excuse an edited one still carrying the placeholder.
    await prepare(M);
    await writeFile(
      path.join(matchDir(M), `match-${M}.title.edited.txt`),
      `${HOOK_PLACEHOLDER} | Infume vs bbiddd | MCSR Ranked 1v1\n`,
    );
    await assertRefused(M, "DraftVideo3", 409, /HOOK/, "an edited title with the placeholder");
    await rm(path.join(matchDir(M), `match-${M}.title.edited.txt`));
    console.log("OK: a title still reading <HOOK> is refused, the edited one included");
  }

  /* --- 10: a description that would not pair ---------------------------------------------------- */
  {
    const M = 13448958;
    await prepare(M, { description: "Infume vs bbiddd, mcsr ranked 1v1 on the same seed.\n\n#MCSRRanked" });
    await assertRefused(M, "DraftVideo3", 409, /would not pair/, "no match link at all");
    // An edited description replaces the generated one, link and all.
    await prepare(M);
    await writeFile(path.join(matchDir(M), `match-${M}.description.edited.txt`), "hand-written, no link\n");
    await assertRefused(M, "DraftVideo3", 409, /would not pair/, "an edited description without the link");
    await rm(path.join(matchDir(M), `match-${M}.description.edited.txt`));

    // A link to a different match whose id merely starts with this one's. Pairing reads the
    // `/matches/<id>` segment to its end (`describesMatch`), so this description pairs the video
    // with nothing, or with match 135600371 — Adopt refuses it as "would not pair".
    const P = 13560037;
    await prepare(P, {
      description:
        "v_strid vs doogile, mcsr ranked 1v1 on the same seed.\n\nmatch page: https://mcsrranked.com/matches/135600371\n",
    });
    draft("PrefixLink1");
    await assertRefused(P, "PrefixLink1", 409, /would not pair/, "a link to /matches/135600371");
    assert.equal(channelVideoFor(P, [asChannelVideo("PrefixLink1")]), null, "and it would not have paired");
    console.log("OK: a description that would not pair is refused, a longer id's link included");
  }

  /* --- 11: no operator-confirmed thumbnail ------------------------------------------------------ */
  {
    const M = 13448958;
    await prepare(M, { chosenBy: "auto" });
    await assertRefused(M, "DraftVideo3", 409, /Keep this/, "the renderer's default pick");
    await rm(manifestPath(matchDir(M)));
    await assertRefused(M, "DraftVideo3", 409, /Keep this/, "no manifest at all");
    console.log("OK: no operator-confirmed variant, no adopt");
  }

  /* --- 12: a video on someone else's channel ---------------------------------------------------- */
  {
    const M = 13448958;
    await prepare(M);
    // videos.list reads anyone's public video, and the id is typed by a human.
    draft("ForeignVid1", {
      channelId: "UCsomeoneElsesChannel0001",
      title: "their video",
      description: "theirs",
    });
    // 502: applyMetadata throws on the owner check, and the route reports every YouTube error so.
    await assertRefused(M, "ForeignVid1", 502, /UCsomeoneElsesChannel0001/, "another channel's video");
    assert.equal(await readUpload(M), null, "and this match records nothing");
    console.log("OK: a video on another channel is refused, nothing written");
  }

  /* --- 13: a blocked player's POV clip on disk -------------------------------------------------- */
  {
    const B = 990003;
    await prepare(B, { title: "Down to the last pearl | runnerA vs runnerB | MCSR Ranked 1v1" });
    await writeFile(path.join(matchDir(B), "TestBlockedRunner.mp4"), "clip");
    draft("BlockedVid1");
    const from = await assertRefused(
      B,
      "BlockedVid1",
      403,
      /blocked player/,
      "a blocked runner's clip on disk",
    );
    assert.deepEqual(ytCalls(from), [], "refused before any YouTube call, videos.update included");
    console.log("OK: a blocked runner's match is refused before videos.update");
  }

  /* --- 14: stale export — pinned in youtubeRoutes.contract.test.ts ------------------------------ */

  /* --- 18: the Finish button never retitles ----------------------------------------------------- */
  {
    const M = 12730175;
    await prepare(M);
    draft("StudioUp001", {
      title: "typed in Studio by hand",
      description: `typed in Studio too — https://mcsrranked.com/matches/${M}`,
    });
    await writeUpload(M, {
      videoId: "StudioUp001",
      uploadedAt: "2026-10-12T19:00:00Z",
      publishAt: null,
      privacyStatus: "public",
      thumbnailVariant: null,
      title: "typed in Studio by hand",
      source: "studio",
      finished: {},
    });
    const from = calls.length;
    const a = await call("finish", M, {});
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const puts = hit(from, "PUT", "/youtube/v3/videos");
    // The tags step does write (the draft had none), so the loop below is not vacuous.
    assert.ok(puts.length > 0, "Finish did reach videos.update, for the tags");
    for (const put of puts) {
      const s = (put.body as { snippet: { title: string; description: string } }).snippet;
      assert.equal(s.title, "typed in Studio by hand", "Finish sends the live title back as it was");
      assert.equal(s.description, `typed in Studio too — https://mcsrranked.com/matches/${M}`);
    }
    assert.equal(
      live.get("StudioUp001")!.title,
      "typed in Studio by hand",
      "only an Adopt press replaces it",
    );
    console.log("OK: Finish on YouTube adds what is missing and never replaces the title or description");
  }

  console.log("youtubeRoutes.adopt.contract: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = saved.mediaDir;
  config.blockedPlayers = saved.blocked;
  config.youtubeUploadEnabled = saved.uploadEnabled;
  config.studioAutomation = saved.studioAutomation;
  config.youtubeAutoFinish = saved.autoFinish;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  await rm(tmp, { recursive: true, force: true });
}
