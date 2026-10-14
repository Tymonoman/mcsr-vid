// Contract test for the two `videos.update` writes in src/youtube/youtube.ts, from the docs alone
// (CLAUDE.md "videos.insert is the only call the audit gated"; handbook "videos.update replaces the
// part it is given"). youtube.test.ts already pins reschedule's whole-status write and its
// channel/public/no-time refusals, and youtubeUpload.test.ts addTags' merge through Finish; this
// pins what neither does, against addTags and reschedule directly.
//
// The promises:
//  1. addTags reads the snippet and sends it back whole — title, description, category and the
//     languages — since a part=snippet write that omits the description blanks it.
//  2. addTags only ever adds: a tag typed in Studio survives, a tag it already has (in any case) is
//     not added twice, and when there is nothing to add nothing is written.
//  3. addTags refuses to write at all if the read returns no video — an empty list, or none.
//  4. reschedule refuses, writing nothing, when the read returns no video — an empty list, or none.
//
// Hermetic: a temp token file; the token refresh is stubbed on global fetch, every API call goes
// through the `fetchImpl` seam. Run: npx tsx src/youtube/youtube.contract.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addTags, reschedule } from "./youtube.js";

const dir = await mkdtemp(path.join(tmpdir(), "mcsr-yt-contract-"));
const realFetch = globalThis.fetch;
const realToken = process.env.YOUTUBE_TOKEN_FILE;
process.env.YOUTUBE_TOKEN_FILE = path.join(dir, "token.json");
await writeFile(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);
// Only the token refresh may use global fetch; anything else here is a call that slipped the seam.
globalThis.fetch = (async (input: string | URL | Request) => {
  assert.match(
    String(input),
    /^https:\/\/oauth2\.googleapis\.com\//,
    "only the token refresh uses global fetch",
  );
  return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }));
}) as typeof fetch;

/** A fake videos endpoint: what a read answers, and every write it was sent. */
function fakeVideos(readAnswer: unknown) {
  const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if ((init.method ?? "GET") !== "GET") {
      writes.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "vid", status: {} }));
    }
    return new Response(JSON.stringify(readAnswer));
  }) as typeof fetch;
  return { writes, fetchImpl };
}

try {
  /* --- 1, 2. addTags sends the whole snippet back and only adds ------------------------------- */
  {
    const snippet = {
      channelId: "UCmine",
      title: "Does the lead ever settle? | Infume vs Feinberg | MCSR Ranked 1v1",
      description: "Both POVs, synced on the countdown.\nmatch page: https://mcsrranked.com/",
      categoryId: "20",
      tags: ["typed in studio", "Infume"],
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
    };
    const yt = fakeVideos({ items: [{ id: "vid", snippet }] });
    const result = await addTags("vid", ["infume", "Feinberg", "minecraft speedrun"], yt.fetchImpl);
    assert.deepEqual(result.added, ["Feinberg", "minecraft speedrun"], "what was missing, and only that");
    assert.equal(yt.writes.length, 1);
    const sent = (yt.writes[0]!.body as { snippet: Record<string, unknown> }).snippet;
    // The whole part goes back: leave the description out and YouTube blanks it on a live video.
    assert.equal(sent.title, snippet.title, "title survives");
    assert.equal(sent.description, snippet.description, "description survives");
    assert.equal(sent.categoryId, "20", "category survives");
    assert.equal(sent.defaultLanguage, "en", "language survives");
    assert.equal(sent.defaultAudioLanguage, "en", "audio language survives");
    // Only ever adds: Studio's own tag stays, "infume" is Infume already (YouTube's tags are caseless).
    assert.deepEqual(sent.tags, ["typed in studio", "Infume", "Feinberg", "minecraft speedrun"]);

    // Nothing new to add: no write at all (50 units, and a needless replace of a live snippet).
    const same = fakeVideos({ items: [{ id: "vid", snippet }] });
    assert.deepEqual((await addTags("vid", ["INFUME", " typed in studio "], same.fetchImpl)).added, []);
    assert.equal(same.writes.length, 0, "nothing to add writes nothing");
    console.log("OK: addTags sends the whole snippet back and only ever adds");
  }

  /* --- 3. addTags: no video read, no write ---------------------------------------------------- */
  // A videos.list for an id that is gone answers 200 — with an empty list, or with no `items` at all.
  for (const answer of [{ items: [] }, {}]) {
    const yt = fakeVideos(answer);
    await assert.rejects(
      addTags("gone", ["Infume"], yt.fetchImpl),
      `read ${JSON.stringify(answer)}: refused`,
    );
    assert.equal(yt.writes.length, 0, `read ${JSON.stringify(answer)}: never a write of an empty snippet`);
  }
  console.log("OK: addTags refuses to write when the read returns no video");

  /* --- 4. reschedule: no video read, nothing moved ------------------------------------------- */
  const NOW = Date.parse("2026-10-14T12:00:00Z");
  for (const answer of [{ items: [] }, {}, { items: [{ id: "vid", snippet: { channelId: "UCmine" } }] }]) {
    const yt = fakeVideos(answer);
    const moved = await reschedule("vid", "2026-10-20T19:00:00Z", "UCmine", NOW, yt.fetchImpl);
    assert.ok("refused" in moved, `read ${JSON.stringify(answer)}: refused, got ${JSON.stringify(moved)}`);
    assert.match(moved.refused, /nothing moved/);
    assert.equal(yt.writes.length, 0, `read ${JSON.stringify(answer)}: no status write`);
  }
  console.log("OK: reschedule refuses, writing nothing, when the read returns no video");

  console.log("youtube.contract: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = realToken;
  await rm(dir, { recursive: true, force: true });
}
