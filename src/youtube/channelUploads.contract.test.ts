// Contract test for the pairing half of "Adopt a Studio draft", written from the docs alone and
// driven through channelUploads' public functions with a stubbed fetch (no network, temp media).
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/youtube/channelUploads.contract.test.ts
//
// What the docs promise (handbook/claude-md-reference.md "Adopt a Studio draft"; CLAUDE.md
// "Adopt a Studio draft"):
//   1. The pairing everything relies on is the `/matches/<id>` link in the description, which a
//      blank draft has not got — a blank draft pairs with no match.
//   2. The match-page line the description builder writes pairs the video to its match, and only
//      that match (another match's id with this one as a prefix does not).
//   3. Adopt refuses a video three minutes or shorter as a Short; the pairing draws the Short line
//      in the same place (3:00 is the Short, 3:01 is the match video).
//   4. Adopt is "one explicit press on a video named by id: never something a scan can reach":
//      a channel scan only reads YouTube, and never touches a record a press already wrote.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { matchPageUrl } from "../api/mcsrApi.js";
import { config, matchDir } from "../config.js";
import {
  channelShortFor,
  channelUploadsSnapshot,
  channelVideoFor,
  describesMatch,
  refreshChannelUploadsNow,
  SHORT_MAX_SEC,
  type ChannelVideo,
} from "./channelUploads.js";
import { writeUpload } from "./youtubeStore.js";

const tmp = await mkdtemp(path.join(tmpdir(), "mcsr-pairing-contract-"));
const saved = {
  mediaDir: config.mediaDir,
  autoFinish: config.youtubeAutoFinish,
  token: process.env.YOUTUBE_TOKEN_FILE,
};
config.mediaDir = path.join(tmp, "media");
config.youtubeAutoFinish = false;
process.env.YOUTUBE_TOKEN_FILE = path.join(tmp, "token.json");
await writeFile(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);
const realFetch = globalThis.fetch;

const A = 13446429; // a real match (src/fixtures), already adopted below
const B = 13448958; // a real match with a folder and nothing on the channel naming it
const video = (videoId: string, description: string, durationSec = 612): ChannelVideo => ({
  videoId,
  title: "t",
  publishedAt: "2026-10-13T19:00:00Z",
  description,
  privacyStatus: "public",
  durationSec,
});

try {
  /* --- 1, 2: the description is the pairing --------------------------------------------------- */
  {
    // Studio leaves the description empty and titles the draft after the file.
    const blank = video("BlankDraft1", "");
    for (const id of [A, B]) {
      assert.equal(describesMatch(id, blank), false, "a blank draft names no match");
      assert.equal(channelVideoFor(id, [blank]), null, "so it pairs with nothing until Adopt writes one");
    }
    // The line the builder writes (src/pipeline/description.ts, `match page: …`), for this season's match.
    const adopted = video(
      "DraftVideo1",
      `Infume vs Feinberg, mcsr ranked 1v1.\n\nmatch page: ${matchPageUrl(A, "Infume", 12)}\n`,
    );
    assert.equal(channelVideoFor(A, [blank, adopted])?.videoId, "DraftVideo1", "the written link pairs it");
    assert.equal(channelVideoFor(B, [blank, adopted]), null, "and to that match only");
    // The doc's own trap: a different match whose id starts with A's is not A.
    const longer = video("PrefixLink1", `match page: https://mcsrranked.com/matches/${A}1`);
    assert.equal(channelVideoFor(A, [longer]), null, `/matches/${A}1 is another match`);
    console.log("OK: a blank draft pairs with nothing; the written match link pairs it to its match only");
  }

  /* --- 3: the Short line is the same line Adopt refuses at ------------------------------------- */
  {
    assert.equal(SHORT_MAX_SEC, 180, "YouTube's line: at most three minutes is a Short");
    const link = `match page: https://mcsrranked.com/matches/${A}`;
    const at180 = video("ShortLen180", link, 180);
    const at181 = video("LongLen181s", link, 181);
    assert.equal(channelVideoFor(A, [at180]), null, "3:00 is never the match video");
    assert.equal(channelShortFor(A, [at180])?.videoId, "ShortLen180", "it is the Short");
    assert.equal(channelVideoFor(A, [at181])?.videoId, "LongLen181s", "3:01 is the match video");
    assert.equal(channelShortFor(A, [at181]), null, "and never the Short");
    console.log("OK: pairing draws the Short line at three minutes, where Adopt refuses");
  }

  /* --- 4: a scan only reads, and leaves an adopted record alone -------------------------------- */
  {
    await mkdir(matchDir(A), { recursive: true });
    await mkdir(matchDir(B), { recursive: true });
    // What an Adopt press recorded: the adopted video, finished.
    await writeUpload(A, {
      videoId: "DraftVideo1",
      uploadedAt: "2026-10-13T19:00:00Z",
      publishAt: null,
      privacyStatus: "public",
      thumbnailVariant: "walking-crossed",
      title: "Down to the last pearl | Infume vs Feinberg | MCSR Ranked 1v1",
      source: "studio",
      finished: { playlists: null, thumbnail: null, comment: null, tags: null },
    });
    const recordBefore = readFileSync(path.join(matchDir(A), "youtube.json"), "utf8");
    const onChannel = [
      // An older upload whose description also names A, listed before the adopted one.
      video("OldUpload01", `match page: https://mcsrranked.com/matches/${A}`),
      video("DraftVideo1", `match page: ${matchPageUrl(A, "Infume", 12)}`),
      video("BlankDraft1", ""),
    ];
    const requests: Array<{ method: string; url: string }> = [];
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    const stub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      requests.push({ method, url });
      if (url.startsWith("https://oauth2.googleapis.com/"))
        return json({ access_token: "t", expires_in: 3600 });
      if (url.includes("/youtube/v3/channels?"))
        return json({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UUmine" } } }] });
      if (url.includes("/youtube/v3/playlistItems?"))
        return json({
          items: url.includes("playlistId=UUmine")
            ? onChannel.map((v) => ({ contentDetails: { videoId: v.videoId } }))
            : [],
        });
      if (url.includes("/youtube/v3/videos?"))
        return json({
          items: onChannel.map((v) => ({
            id: v.videoId,
            snippet: { title: v.title, publishedAt: v.publishedAt, description: v.description },
            status: { privacyStatus: v.privacyStatus },
            contentDetails: { duration: "PT10M12S" },
          })),
        });
      throw new Error(`no network in this test: ${method} ${url}`);
    }) as typeof fetch;
    // The token refresh goes through the global fetch, so the stub stands there too.
    globalThis.fetch = stub;
    await refreshChannelUploadsNow(stub);

    assert.equal(channelUploadsSnapshot().length, 3, "the scan did list the channel");
    const writes = requests.filter(
      (r) => r.method !== "GET" && !r.url.startsWith("https://oauth2.googleapis.com/"),
    );
    assert.deepEqual(writes, [], "a scan makes no YouTube write — no videos.update, no comment, no playlist");
    assert.equal(
      readFileSync(path.join(matchDir(A), "youtube.json"), "utf8"),
      recordBefore,
      "the adopted record is left exactly as the press wrote it, though another video names the match too",
    );
    assert.equal(
      existsSync(path.join(matchDir(B), "youtube.json")),
      false,
      "a blank draft is recorded for no match",
    );
    console.log("OK: a channel scan only reads, and never touches what an Adopt press recorded");
  }

  console.log("channelUploads.contract: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = saved.mediaDir;
  config.youtubeAutoFinish = saved.autoFinish;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  await rm(tmp, { recursive: true, force: true });
}
