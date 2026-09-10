import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { parseImpressionsCsv, REQUIRED_SCOPES, uploadVideo } from "./youtube.js";
import { findExportedVideo } from "./youtubeStore.js";

// --- Reporting CSV: the only source of per-video CTR, so a misread here silently corrupts
// every A/B conclusion drawn from it.

const csv = [
  "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr",
  "20260901,UCm2mAyONTHlmIxZzNmi388w,vid_aaa,1200,0.043",
  "20260902,UCm2mAyONTHlmIxZzNmi388w,vid_aaa,900,0.051",
  "20260902,UCm2mAyONTHlmIxZzNmi388w,vid_bbb,400,0.028",
].join("\n");

const rows = parseImpressionsCsv(csv);
assert.equal(rows.length, 3);
assert.deepEqual(rows[0], { date: "20260901", videoId: "vid_aaa", impressions: 1200, ctr: 0.043 });
assert.equal(rows[2]!.videoId, "vid_bbb");

// Columns are located by name, not position. A column added upstream must not shift the CTR
// into the impressions slot — which is exactly the kind of bug nobody notices for a month.
const reordered = [
  "video_thumbnail_impressions_ctr,video_id,date,channel_id,video_thumbnail_impressions",
  "0.043,vid_aaa,20260901,UCxxx,1200",
].join("\n");
assert.deepEqual(parseImpressionsCsv(reordered)[0], {
  date: "20260901",
  videoId: "vid_aaa",
  impressions: 1200,
  ctr: 0.043,
});

// A report with only a header is "no data yet", which is the normal case for the first ~48h.
assert.deepEqual(
  parseImpressionsCsv("date,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr"),
  [],
);
assert.deepEqual(parseImpressionsCsv(""), []);

// A CSV missing the metrics is reported loudly rather than quietly yielding zeroes, because
// zero impressions and "we could not find the column" look identical downstream.
assert.throws(() => parseImpressionsCsv("date,video_id\n20260901,vid_aaa"), /missing expected columns/);

// force-ssl is what allows replying to a comment; without it the dashboard can read threads but
// not answer them, which is half the feature.
assert.ok(REQUIRED_SCOPES.includes("https://www.googleapis.com/auth/youtube.force-ssl"));
assert.ok(REQUIRED_SCOPES.includes("https://www.googleapis.com/auth/youtube.upload"));
assert.ok(REQUIRED_SCOPES.includes("https://www.googleapis.com/auth/yt-analytics.readonly"));

// --- Finding the exported video. The pipeline produces a Kdenlive project, not a finished
// file, so this picks which file to upload — and picking wrong means a multi-GB POV clip on a
// public channel.

const matchId = 999000111;
const dir = path.join(config.mediaDir, String(matchId));
await mkdir(dir, { recursive: true });

// Nothing exported yet: say what to do, not just "not found".
const none = findExportedVideo(matchId, ["nahhann", "Aquacorde"]);
assert.ok("error" in none && /Export the finished render/.test(none.error));

// The POV clips and render intermediates are never candidates, however many there are.
await writeFile(path.join(dir, "nahhann.mp4"), "pov", "utf8");
await writeFile(path.join(dir, "Aquacorde.mp4"), "pov", "utf8");
await writeFile(path.join(dir, "overlay.mov"), "intermediate", "utf8");
await writeFile(path.join(dir, "overlay-intro.mov"), "intermediate", "utf8");
// The current artifact names, which are ordinary .mp4/.webm and would otherwise look exactly
// like a finished export sitting in the folder.
await writeFile(path.join(dir, "overlay-timer.mp4"), "intermediate", "utf8");
await writeFile(path.join(dir, "overlay-intro.webm"), "intermediate", "utf8");
await writeFile(path.join(dir, "sync-preview.mp4"), "preview", "utf8");
// A rendered Short lives in the same folder and is a real .mp4. It is a separate deliverable,
// so it must never be offered as the finished match export — when it was, every match with a
// Short became "several possible videos" and the upload panel stopped working.
await writeFile(path.join(dir, "short-12345.mp4"), "a short", "utf8");
const stillNone = findExportedVideo(matchId, ["nahhann", "Aquacorde"]);
assert.ok("error" in stillNone, "POV clips and intermediates must never be upload candidates");

// An export still in flight is not a candidate. exportFast.ts writes a .part.mp4 and renames on
// success, exactly as atomicOutput does, so offering it would publish half a video.
await writeFile(path.join(dir, "final.part.mp4"), "half a video", "utf8");
const midExport = findExportedVideo(matchId, ["nahhann", "Aquacorde"]);
assert.ok("error" in midExport, "a .part. file must never be offered for upload");

// One export: found — and the finished file wins over a leftover .part. beside it.
await writeFile(path.join(dir, "final-render.mp4"), "the actual video", "utf8");
const found = findExportedVideo(matchId, ["nahhann", "Aquacorde"]);
assert.ok("path" in found);
assert.equal(path.basename(found.path), "final-render.mp4");

// Two exports: refuse and name them. Guessing here is the expensive kind of wrong.
await writeFile(path.join(dir, "final-render-v2.mp4"), "another take", "utf8");
const ambiguous = findExportedVideo(matchId, ["nahhann", "Aquacorde"]);
assert.ok("error" in ambiguous && /Several possible videos/.test(ambiguous.error));
assert.match((ambiguous as { error: string }).error, /final-render\.mp4/);
assert.match((ambiguous as { error: string }).error, /final-render-v2\.mp4/);

await rm(dir, { recursive: true, force: true });

// --- Impressions-weighted CTR. This is the number the A/B table picks a pose from, so getting
// it wrong silently recommends the worse thumbnail.

const { totalReach } = await import("./youtubeRoutes.js");

// A quiet day must not outvote a busy one: the naive mean of 1% and 10% is 5.5%, but 1000
// impressions at 1% next to 10 at 10% is really 1.09%.
const mixed = totalReach([
  { date: "20260901", videoId: "v", impressions: 1000, ctr: 0.01 },
  { date: "20260902", videoId: "v", impressions: 10, ctr: 0.1 },
]);
assert.equal(mixed.impressions, 1010);
assert.ok(Math.abs(mixed.weightedCtr / mixed.impressions - 0.0109) < 0.0001);

// weightedCtr stays undivided so per-video totals can be summed again per variant.
const one = totalReach([{ date: "d", videoId: "v1", impressions: 100, ctr: 0.05 }]);
const two = totalReach([{ date: "d", videoId: "v2", impressions: 300, ctr: 0.01 }]);
const group = {
  impressions: one.impressions + two.impressions,
  weightedCtr: one.weightedCtr + two.weightedCtr,
};
assert.equal(group.weightedCtr / group.impressions, 0.02);

// No rows, and rows with no impressions, must not divide by zero.
assert.deepEqual(totalReach([]), { impressions: 0, weightedCtr: 0 });
assert.deepEqual(totalReach([{ date: "d", videoId: "v", impressions: 0, ctr: 0 }]), {
  impressions: 0,
  weightedCtr: 0,
});

console.log("youtube: all checks passed");

// --- the gate, then the placeholder ------------------------------------------------------------
// Two refusals the form cannot be trusted to make. `youtubeUploadEnabled` is the branch's whole
// point — an upload through the unaudited API project is locked private for good — and a title
// still carrying "<HOOK>" is the one string that must never reach YouTube.
{
  // `isConfigured()` looks for youtube-token.json in cwd, which is gitignored, so this case 503s
  // in a fresh worktree or CI unless a token file exists. A dummy one is enough: both refusals
  // happen before any credential is read.
  const tokenDir = await mkdtemp(path.join(tmpdir(), "mcsr-yt-route-test-"));
  process.env.YOUTUBE_TOKEN_FILE = path.join(tokenDir, "token.json");
  await writeFile(
    process.env.YOUTUBE_TOKEN_FILE,
    JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
  );
  const { handleYoutubeRoute } = await import("./youtubeRoutes.js");
  const { HOOK_PLACEHOLDER } = await import("./title.js");
  // Under the temp directory, not the configured mediaDir: on the lab that is the `/media` bind
  // mount, and a test has no business writing into it.
  const realMediaDir = config.mediaDir;
  config.mediaDir = path.join(tokenDir, "media");
  // The title comes off disk now, not out of the request body — the form has no title field.
  const routeMatch = 424242;
  const routeDir = path.join(config.mediaDir, String(routeMatch));
  await mkdir(routeDir, { recursive: true });
  await writeFile(
    path.join(routeDir, `match-${routeMatch}.title.txt`),
    `${HOOK_PLACEHOLDER} | a vs b | MCSR Ranked 1v1\n`,
    "utf8",
  );

  // Appended to rather than reassigned: a variable written inside a callback narrows to `never`
  // by the time the assert below reads it.
  const answers: Array<{ status: number; body: unknown }> = [];
  const ctx = {
    json: (_res: unknown, status: number, body: unknown) => {
      answers.push({ status, body });
    },
    readBody: async () => JSON.stringify({ kind: "video", privacyStatus: "private" }),
    matchDir: (id: number) => path.join(config.mediaDir, String(id)),
    parseId: (raw: string | undefined) => (raw && /^\d+$/.test(raw) ? Number(raw) : null),
  };
  const req = { method: "POST", headers: {} } as unknown as import("node:http").IncomingMessage;
  const res = {} as unknown as import("node:http").ServerResponse;
  const post = async () => {
    const handled = await handleYoutubeRoute(req, res, ["api", "youtube", "upload", String(routeMatch)], ctx);
    assert.equal(handled, true, "the upload route should claim the request");
    const answer = answers.at(-1);
    assert.ok(answer, "the route must answer");
    return { status: answer.status, error: String((answer.body as { error?: string }).error) };
  };

  config.youtubeUploadEnabled = false;
  const gated = await post();
  assert.equal(gated.status, 403, "uploads are off until the compliance audit clears");
  assert.match(gated.error, /Studio/);

  config.youtubeUploadEnabled = true;
  const placeholder = await post();
  assert.equal(placeholder.status, 400, "a placeholder title must be refused, not uploaded");
  assert.match(placeholder.error, /HOOK/);
  config.youtubeUploadEnabled = false;

  console.log("OK: upload is gated off, and refuses a title that still contains the hook placeholder");
  config.mediaDir = realMediaDir;
  await rm(tokenDir, { recursive: true, force: true });
}

// --- text vs no text: the grouping the hook change is judged by --------------------------------
// Pooling per-video rates by hand is where an A/B table quietly lies, so pin the two things that
// go wrong: CTR must be impression-weighted, and a video whose manifest is gone must not be
// counted as evidence for either side.
{
  const { groupByHook } = await import("./youtubeRoutes.js");
  const reach = (impressions: number, ctr: number) => ({ impressions, weightedCtr: ctr * impressions });
  const groups = groupByHook([
    { hook: true, reach: reach(1000, 0.05) },
    { hook: true, reach: reach(1000, 0.03) },
    { hook: false, reach: reach(500, 0.1) },
    { hook: null, reach: reach(300, 0.09) },
  ]);
  const bucket = (hook: boolean | null) => groups.find((g) => g.hook === hook);

  const withHook = bucket(true);
  assert.ok(withHook);
  assert.equal(withHook.videos, 2);
  assert.equal(withHook.impressions, 2000);
  // 0.04 exactly, up to the float error of summing 0.05*1000 + 0.03*1000.
  assert.ok(Math.abs(withHook.ctr! - 0.04) < 1e-9, `weighted CTR was ${withHook.ctr}`);

  const noHook = bucket(false);
  assert.ok(noHook);
  assert.deepEqual([noHook.videos, noHook.impressions, noHook.ctr], [1, 500, 0.1]);

  // No manifest is its own bucket, not a guess at either answer.
  assert.equal(bucket(null)?.videos, 1);

  // A bucket nobody uploaded into is absent, not a row of zeroes.
  assert.deepEqual(
    groupByHook([{ hook: true, reach: null }]).map((g) => g.hook),
    [true],
  );
  // And a video with no Reporting row yet counts as a video with no CTR, not 0% CTR.
  assert.equal(groupByHook([{ hook: true, reach: null }])[0]!.ctr, null);
  console.log("OK: A/B groups text vs no text with impression-weighted CTR");
}
// --- the resumable upload ----------------------------------------------------------------------
// The one loop that moves gigabytes. It goes wrong in two ways nobody sees until a real upload:
// resuming from our own byte counter rather than from the Range YouTube actually kept (which
// corrupts the video), and uploading a scheduled video as public (which publishes it at once).
{
  const dir = await mkdtemp(path.join(tmpdir(), "mcsr-yt-upload-test-"));
  process.env.YOUTUBE_TOKEN_FILE = path.join(dir, "token.json");
  await writeFile(
    process.env.YOUTUBE_TOKEN_FILE,
    JSON.stringify({
      client_id: "c",
      client_secret: "s",
      refresh_token: "r",
      token_uri: "https://token/",
    }),
  );
  const CHUNK = 256 * 1024;
  const file = path.join(dir, "clip.mp4");
  await writeFile(file, Buffer.alloc(3 * CHUNK, 7));

  // The token refresh deliberately keeps using global fetch, so stub that separately; anything
  // else arriving there means an upload call slipped past the `fetchImpl` seam.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    assert.equal(String(url), "https://token/", "only the token refresh may use global fetch");
    return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;

  const ranges: string[] = [];
  let metadata: {
    snippet: Record<string, unknown>;
    status: Record<string, unknown>;
  } | null = null;
  const scripted: typeof fetch = async (url, init) => {
    if (init?.method === "POST") {
      metadata = JSON.parse(String(init.body));
      return new Response("", {
        status: 200,
        headers: { location: "https://upload/session" },
      });
    }
    assert.equal(String(url), "https://upload/session");
    ranges.push(String((init?.headers as Record<string, string>)["content-range"]));
    // The first chunk is only half accepted — YouTube's Range, not our counter, says where to
    // carry on from. The third completes the file.
    if (ranges.length === 1)
      return new Response("", {
        status: 308,
        headers: { range: "bytes=0-131071" },
      });
    if (ranges.length === 2)
      return new Response("", {
        status: 308,
        headers: { range: "bytes=0-393215" },
      });
    return new Response(JSON.stringify({ id: "vidX", status: { privacyStatus: "private" } }), {
      status: 200,
    });
  };

  const result = await uploadVideo({
    filePath: file,
    title: "t",
    description: "d",
    // Asked for public with a publishAt: YouTube honours publishAt only while private, so a
    // public insert would publish it immediately — the opposite of scheduling it.
    privacyStatus: "public",
    publishAt: "2026-09-20T19:00:00.000Z",
    fetchImpl: scripted,
    chunkBytes: CHUNK,
  });
  globalThis.fetch = realFetch;

  assert.equal(result.videoId, "vidX");
  assert.deepEqual(ranges, [
    "bytes 0-262143/786432",
    // 131072, not 262144: resumed from what YouTube kept, not from what we sent.
    "bytes 131072-393215/786432",
    "bytes 393216-655359/786432",
  ]);
  assert.equal(metadata!.status.privacyStatus, "private", "publishAt forces private");
  assert.equal(metadata!.status.publishAt, "2026-09-20T19:00:00.000Z");
  assert.equal(metadata!.snippet.defaultLanguage, "en");
  // The session file is only useful to a retry; a finished upload leaves none behind. Named after
  // the file, so a match's long-form and its Short do not overwrite each other's resume.
  const session = path.join(dir, ".upload-session-clip.mp4.json");
  assert.equal(existsSync(session), false);

  console.log("OK: the resumable upload resumes from YouTube's Range and schedules privately");

  // --- the two ways a resume goes wrong -------------------------------------------------------
  // Both cost a second copy of the same match on the channel, which only Studio can undo.

  // 1. The process died after YouTube accepted the last chunk but before the session file was
  //    removed. The probe answers 200 with the video: that is done, not "start again".
  await writeFile(
    session,
    JSON.stringify({ filePath: file, total: 3 * CHUNK, sessionUrl: "https://upload/session" }),
  );
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }))) as typeof fetch;
  let sent = 0;
  const finishedProbe: typeof fetch = async (_url, init) => {
    sent += 1;
    assert.equal(String((init?.headers as Record<string, string>)["content-range"]), "bytes */786432");
    return new Response(JSON.stringify({ id: "vidDone", status: { privacyStatus: "private" } }), {
      status: 200,
    });
  };
  const resumed = await uploadVideo({
    filePath: file,
    title: "t",
    description: "d",
    privacyStatus: "private",
    fetchImpl: finishedProbe,
    chunkBytes: CHUNK,
  });
  assert.equal(resumed.videoId, "vidDone", "the video YouTube already has, not a second upload");
  assert.equal(sent, 1, "nothing was re-sent");
  assert.equal(existsSync(session), false, "and the session is forgotten");

  // 2. A 308 whose Range is in some other shape. Reading it as 0 re-sends the whole file, and
  //    nothing here caps the attempts — so an unreadable header means "the chunk we just sent".
  const odd: string[] = [];
  const oddRange: typeof fetch = async (url, init) => {
    if (init?.method === "POST")
      return new Response("", { status: 200, headers: { location: "https://upload/session" } });
    odd.push(String((init?.headers as Record<string, string>)["content-range"]));
    if (odd.length < 3) return new Response("", { status: 308, headers: { range: "0-something" } });
    return new Response(JSON.stringify({ id: "vidOdd" }), { status: 200 });
  };
  const oddResult = await uploadVideo({
    filePath: file,
    title: "t",
    description: "d",
    privacyStatus: "private",
    fetchImpl: oddRange,
    chunkBytes: CHUNK,
  });
  assert.equal(oddResult.videoId, "vidOdd");
  assert.deepEqual(odd, [
    "bytes 0-262143/786432",
    "bytes 262144-524287/786432",
    "bytes 524288-786431/786432",
  ]);

  globalThis.fetch = realFetch;
  console.log("OK: a finished session is not uploaded twice, and an odd Range does not restart it");
  await rm(dir, { recursive: true, force: true });
}

// --- applyMetadata: the write that replaces a title on a live video ----------------------------
// This is the only call in the project that overwrites what a viewer already sees, so what it
// sends is asserted field by field. `videos.update` REPLACES the part it is given: a snippet write
// that omits the description blanks it, and a video the read did not return must never be written.
{
  const dir = await mkdtemp(path.join(tmpdir(), "mcsr-meta-test-"));
  process.env.YOUTUBE_TOKEN_FILE = path.join(dir, "token.json");
  await writeFile(
    process.env.YOUTUBE_TOKEN_FILE,
    JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
  );

  let readItems: unknown[] = [];
  const sent: Array<{ method: string; url: string; body: unknown }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (typeof init?.body === "string" && url.includes("/videos?")) {
      sent.push({ method, url, body: JSON.parse(init.body) });
    }
    const ok = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/")) return ok({ access_token: "t", expires_in: 3600 });
    if (method === "GET" && url.includes("/videos?")) return ok({ items: readItems });
    return ok({ id: "ok" });
  }) as typeof fetch;

  const { applyMetadata } = await import("./youtube.js");
  const live = {
    id: "vidMeta",
    snippet: {
      channelId: "UCmine",
      title: "match-13223455.mp4",
      description: "",
      categoryId: "20",
      tags: ["mcsr"],
      defaultLanguage: "en",
    },
  };

  readItems = [live];
  sent.length = 0;
  const applied = await applyMetadata(
    "vidMeta",
    { title: "Down to the last heart | a vs b", description: "…/matches/13223455", tags: ["a", "MCSR", "b"] },
    "UCmine",
  );
  const put = sent.find((r) => r.method === "PUT");
  assert.ok(put, "videos.update was called");
  const snippet = (put!.body as { id: string; snippet: Record<string, unknown> }).snippet;
  assert.equal((put!.body as { id: string }).id, "vidMeta");
  assert.equal(snippet.title, "Down to the last heart | a vs b", "the title is replaced");
  assert.equal(snippet.description, "…/matches/13223455", "and so is the description");
  assert.equal(snippet.categoryId, "20", "the category survives the replace");
  assert.equal(snippet.defaultLanguage, "en", "and the language");
  assert.deepEqual(snippet.tags, ["mcsr", "a", "b"], "tags merge, case-insensitively, never replace");
  assert.equal(applied.replacedTitle, "match-13223455.mp4", "what it overwrote is reported back");

  // Somebody else's video: `videos.list` reads any public video, and the id is typed by a human.
  readItems = [{ ...live, snippet: { ...live.snippet, channelId: "UCsomeoneelse" } }];
  sent.length = 0;
  await assert.rejects(
    () => applyMetadata("vidMeta", { title: "t", description: "d" }, "UCmine"),
    /belongs to channel UCsomeoneelse/,
  );
  assert.ok(!sent.some((r) => r.method === "PUT"), "and nothing was written");

  // A read that returns nothing is a throw, never a write of an empty snippet.
  readItems = [];
  sent.length = 0;
  await assert.rejects(
    () => applyMetadata("vidGone", { title: "t", description: "d" }, "UCmine"),
    /refusing to write/,
  );
  assert.ok(!sent.some((r) => r.method === "PUT"), "no write against a video that is not there");

  // An empty title would leave the video untitled on the channel; refuse before reading anything.
  readItems = [live];
  sent.length = 0;
  await assert.rejects(
    () => applyMetadata("vidMeta", { title: "   ", description: "d" }, "UCmine"),
    /empty title/,
  );
  assert.equal(sent.length, 0, "and it does not even read");

  globalThis.fetch = realFetch;
  console.log("OK: applyMetadata replaces title and description, merges tags, refuses the rest");
  await rm(dir, { recursive: true, force: true });
}

// --- The adopt route refuses before it writes ---------------------------------------------------
// Adopt REPLACES a live video's title and description from an id a human typed, so every way of
// naming the wrong video has to be turned away before any request is made.
{
  const dir = await mkdtemp(path.join(tmpdir(), "mcsr-adopt-test-"));
  process.env.YOUTUBE_TOKEN_FILE = path.join(dir, "token.json");
  await writeFile(
    process.env.YOUTUBE_TOKEN_FILE,
    JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
  );
  const realMediaDir = config.mediaDir;
  config.mediaDir = path.join(dir, "media");
  const matchId = 13223455;
  const matchPath = path.join(config.mediaDir, String(matchId));
  await mkdir(matchPath, { recursive: true });

  const { handleYoutubeRoute } = await import("./youtubeRoutes.js");
  const { HOOK_PLACEHOLDER } = await import("./title.js");

  // Any network call is a failure of the guards, so there is no stub that answers one.
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("the guards should have refused before any request");
  }) as typeof fetch;

  const answers: Array<{ status: number; body: unknown }> = [];
  const adopt = async (videoId: unknown) => {
    answers.length = 0;
    await handleYoutubeRoute(
      { method: "POST", headers: {} } as unknown as import("node:http").IncomingMessage,
      {} as unknown as import("node:http").ServerResponse,
      ["", "youtube", "adopt", String(matchId)],
      {
        json: (_r: unknown, status: number, body: unknown) => answers.push({ status, body }),
        readBody: async () => JSON.stringify({ videoId }),
        matchDir: (id: number) => path.join(config.mediaDir, String(id)),
        parseId: (raw: string | undefined) => (raw && /^\d+$/.test(raw) ? Number(raw) : null),
      },
    );
    return answers[0]!;
  };

  for (const bad of ["", "not-an-id", "https://youtu.be/aAX_ML4rHdo", "aAX_ML4rHdo_toolong", 42, null]) {
    const a = await adopt(bad);
    assert.equal(a.status, 400, `rejected ${JSON.stringify(bad)}`);
    assert.match(String((a.body as { error: string }).error), /not a YouTube video id/);
  }

  // A title still carrying the placeholder would go on the channel verbatim.
  await writeFile(
    path.join(matchPath, `match-${matchId}.title.txt`),
    `${HOOK_PLACEHOLDER} | a vs b | MCSR Ranked 1v1\n`,
    "utf8",
  );
  await writeFile(
    path.join(matchPath, `match-${matchId}.description.txt`),
    `x /matches/${matchId} y\n`,
    "utf8",
  );
  {
    const a = await adopt("aAX_ML4rHdo");
    assert.equal(a.status, 409);
    assert.match(String((a.body as { error: string }).error), /pick a hook first/);
  }

  // A description with no match link pairs with nothing: every later lookup would call the match
  // unpublished, and the operator would have overwritten a live video for nothing.
  await writeFile(path.join(matchPath, `match-${matchId}.title.txt`), "A real title | a vs b\n", "utf8");
  await writeFile(path.join(matchPath, `match-${matchId}.description.txt`), "no link here\n", "utf8");
  {
    const a = await adopt("aAX_ML4rHdo");
    assert.equal(a.status, 409);
    assert.match(String((a.body as { error: string }).error), /would not pair/);
  }

  assert.equal(calls, 0, "not one of those refusals touched the network");

  globalThis.fetch = realFetch;
  config.mediaDir = realMediaDir;
  console.log("OK: adopt refuses a bad id, an unpicked hook and a description that would not pair");
  await rm(dir, { recursive: true, force: true });
}
