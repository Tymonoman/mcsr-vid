// Self-check for channelUploads.ts. The pairing rule decides whether a match counts as
// published, so a false positive hides a video that was never uploaded; the fetch half is
// pinned because paging and batching are the two places a silent truncation would hide.
// Run: npx tsx src/channelUploads.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "mcsr-channel-"));
process.env.YOUTUBE_TOKEN_FILE = path.join(dir, "token.json");
await writeFile(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);

// A refresh now records the Studio uploads it pairs, which walks every match directory and can
// write into one and start an rsync. Pointed at an empty temp directory so this test cannot
// reach the lab's `/media`: the fixture ids only happen not to exist there.
const { config } = await import("../config.js");
const mediaDir = config.mediaDir;
config.mediaDir = path.join(dir, "media");

const { channelShortFor, channelVideoFor, fetchChannelUploads, parseIsoDuration } =
  await import("./channelUploads.js");

try {
  /* --- Which video is which match ---------------------------------------------------------- */

  const video = (videoId: string, matchId: number) => ({
    videoId,
    title: `hook | a vs b`,
    publishedAt: "2026-09-01T19:00:00Z",
    description: `Chapters:\n0:00 Intro\n\nMatch data: https://mcsrranked.com/matches/${matchId}\n\nMCSR Replayoffs is an independent fan project.`,
    privacyStatus: "public",
    durationSec: 612,
  });
  const videos = [video("aAX_ML4rHdo", 12296170), video("gRjV1jG4-Ng", 12396259)];

  assert.equal(channelVideoFor(12296170, videos)?.videoId, "aAX_ML4rHdo");
  assert.equal(channelVideoFor(12396259, videos)?.videoId, "gRjV1jG4-Ng");
  assert.equal(channelVideoFor(13048744, videos), null, "a match nothing on the channel names");
  assert.equal(channelVideoFor(12296170, []), null, "nothing known yet is not a match");

  // The trap a plain substring test falls into: 1229617 is a real, different match id, and it is
  // a prefix of the one in the link above.
  assert.equal(channelVideoFor(1229617, videos), null, "a prefix of the linked id is another match");
  assert.equal(channelVideoFor(122961700, videos), null, "and so is a longer id");

  // The link is the last thing in the description often enough to matter.
  assert.equal(
    channelVideoFor(42, [
      { ...video("tail", 1), description: "Match data: https://mcsrranked.com/matches/42" },
    ])?.videoId,
    "tail",
    "the id may end the description",
  );
  // The three shapes actually live on the channel: the generated line, the same hand-stripped of
  // its scheme, and a magmamcsr deep link with a query string after the id.
  const shapes = [
    { ...video("scheme", 1), description: "Match data: https://mcsrranked.com/matches/13048744" },
    { ...video("bare", 1), description: "Match data: mcsrranked.com/matches/12396259" },
    {
      ...video("magma", 1),
      description: "Match data: https://magmamcsr.com/ranked/player/lowk3y_/matches/12296170?season=11",
    },
  ];
  assert.equal(channelVideoFor(13048744, shapes)?.videoId, "scheme");
  assert.equal(channelVideoFor(12396259, shapes)?.videoId, "bare", "no scheme is still the link");
  assert.equal(channelVideoFor(12296170, shapes)?.videoId, "magma", "another host, a query after it");
  // Twitch's POV links sit in the same description and carry ids of their own.
  assert.equal(
    channelVideoFor(2841732406, [
      {
        ...video("twitch", 1),
        description: "Watch lowk3y_: https://www.twitch.tv/videos/2841732406?t=3594s",
      },
    ]),
    null,
    "a VOD id is /videos/, not /matches/",
  );
  // The Short carries the same match link (src/shorts/shortHook.ts) and is told apart by length alone:
  // a match video paired to its own Short would tick "uploaded" on a match with no long-form up.
  const short = { ...video("shortId", 12296170), durationSec: 22 };
  assert.equal(channelVideoFor(12296170, [short]), null, "a 22 s video is not the match video");
  assert.equal(channelShortFor(12296170, [short])?.videoId, "shortId");
  assert.equal(channelShortFor(12296170, videos), null, "and a 10-minute one is not the Short");
  assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
  assert.equal(parseIsoDuration("PT22S"), 22);
  assert.equal(parseIsoDuration(undefined), 0);
  // YouTube answers `P0D` while a video is still processing, which is exactly when "check the
  // channel" is pressed. 0 is unknown, not zero seconds: read as a Short it would tick "the Short
  // is up" on a match whose Short has never been uploaded, and leave the panel offering an upload
  // form for the video that had just been uploaded.
  assert.equal(parseIsoDuration("P0D"), 0);
  const processing = { ...video("fresh", 12296170), durationSec: 0 };
  assert.equal(channelVideoFor(12296170, [processing])?.videoId, "fresh", "unknown is the match video");
  assert.equal(channelShortFor(12296170, [processing]), null, "and never the Short");

  // The hand-made uploads from before the pipeline name no match; those stay on the manual tick.
  assert.equal(
    channelVideoFor(12296170, [{ ...video("old", 1), description: "MCSR Ranked highlights" }]),
    null,
    "a description with no match link matches nothing",
  );

  /* --- Three endpoints, one page token, fifty ids a batch ------------------------------------ */

  const calls: string[] = [];
  const body = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  // Sixty, so the uploads playlist needs two pages and videos.list needs two batches.
  const ids = Array.from({ length: 60 }, (_, i) => `vid${i}`);
  const matchOf = (videoId: string) => 12290000 + Number(videoId.slice(3));

  const stub: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    // getAccessToken uses the global fetch, not fetchImpl, so the stub is installed there too;
    // without it this test would spend a real refresh token against Google.
    if (url.startsWith("https://oauth2.googleapis.com/")) {
      return body({ access_token: "t", expires_in: 3600 });
    }
    if (url.includes("/channels?")) {
      return body({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UUtest" } } }] });
    }
    if (url.includes("/playlistItems?")) {
      const second = url.includes("pageToken=next");
      return body({
        items: (second ? ids.slice(50) : ids.slice(0, 50)).map((videoId) => ({
          contentDetails: { videoId },
        })),
        ...(second ? {} : { nextPageToken: "next" }),
      });
    }
    if (url.includes("/videos?")) {
      const requested = new URL(url).searchParams.get("id")!.split(",");
      return body({
        items: requested.map((id) => ({
          id,
          snippet: {
            title: `t ${id}`,
            publishedAt: "2026-09-01T19:00:00Z",
            description: `Match data: https://mcsrranked.com/matches/${matchOf(id)}`,
          },
          status: { privacyStatus: "public" },
          contentDetails: { duration: "PT10M12S" },
        })),
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  globalThis.fetch = stub;

  const got = await fetchChannelUploads(stub);
  assert.equal(got.length, 60, "every video, across both playlist pages");

  // The uploads playlist only: the season-playlist read is a separate list id and is asserted
  // below, so counting every playlistItems call would conflate the two.
  const uploadsCalls = calls.filter((u) => u.includes("/playlistItems?") && u.includes("playlistId=UU"));
  assert.equal(uploadsCalls.length, 2, "followed nextPageToken");
  assert.ok(uploadsCalls[1]!.includes("pageToken=next"), "and sent it back");

  const videoCalls = calls.filter((u) => u.includes("/videos?"));
  assert.equal(videoCalls.length, 2, "videos.list takes at most fifty ids");
  assert.deepEqual(
    videoCalls.map((u) => new URL(u).searchParams.get("id")!.split(",").length),
    [50, 10],
    "batched fifty then the remainder",
  );

  assert.equal(got[0]!.videoId, "vid0");
  assert.equal(got[0]!.privacyStatus, "public");
  assert.equal(got[0]!.durationSec, 612, "contentDetails.duration is kept");
  assert.ok(videoCalls[0]!.includes("contentDetails"), "videos.list asks for the duration");
  assert.equal(channelVideoFor(matchOf("vid59"), got)?.videoId, "vid59", "the last batch is kept");

  // "Check the channel" after a Studio upload: a forced refresh fills the snapshot whatever the
  // cache's age, and the ordinary stale check right after it does nothing (it is fresh now).
  const {
    _setChannelUploadsForTest,
    channelUploadsSnapshot,
    refreshChannelUploadsIfStale,
    refreshChannelUploadsNow,
  } = await import("./channelUploads.js");
  _setChannelUploadsForTest([]);
  const before = calls.length;
  await refreshChannelUploadsNow(stub);
  assert.equal(channelUploadsSnapshot().length, 60, "a forced refresh lists the channel now");
  assert.ok(calls.length > before, "and actually called the API");
  const after = calls.length;
  refreshChannelUploadsIfStale();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, after, "a fresh cache is not refreshed again by the stale check");
  console.log("channelUploads: all checks passed");
} finally {
  config.mediaDir = mediaDir;
  await rm(dir, { recursive: true, force: true });
}
