// Self-check for addToPlaylist/findOrCreatePlaylist. Stubs global fetch so nothing hits the
// network — including the token refresh, which goes through the same fetch.
// Run: npx tsx src/playlist.test.ts
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "mcsr-playlist-test-"));
process.env.YOUTUBE_TOKEN_FILE = path.join(dir, "token.json");
await writeFile(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);

const { addToPlaylist, matchupPlaylistTitle } = await import("./youtube.js");

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Answers the token endpoint and whatever playlist pages the case supplies. `pages` is consumed
 * one entry per `playlists.list` call, so a test can hand back a nextPageToken and prove the
 * paging loop actually follows it.
 */
function stubFetch(pages: unknown[], createdId = "PL_NEW"): Call[] {
  const calls: Call[] = [];
  let page = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string" && init.body.startsWith("{")) body = JSON.parse(init.body);
    calls.push({ url, method, body });

    const ok = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("oauth2.googleapis.com/token")) return ok({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/playlists?") && method === "GET") return ok(pages[page++] ?? { items: [] });
    if (url.includes("/playlists?") && method === "POST") return ok({ id: createdId });
    if (url.includes("/playlistItems?")) return ok({ id: "PLI_1" });
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
  return calls;
}

try {
  // --- 1. Existing playlist on a later page ------------------------------------------------
  // The paging loop is the only non-obvious part: stopping after page one would silently create
  // a duplicate playlist on every upload, and the operator would not notice until Studio was
  // full of them.
  let calls = stubFetch([
    { items: [{ id: "PL_A", snippet: { title: "Other" } }], nextPageToken: "p2" },
    { items: [{ id: "PL_B", snippet: { title: "MCSR Ranked matches" } }] },
  ]);
  await addToPlaylist("VID1", "MCSR Ranked matches");

  const lists = calls.filter((c) => c.url.includes("/playlists?") && c.method === "GET");
  assert.equal(lists.length, 2, "should have followed nextPageToken to a second page");
  assert.ok(lists[1].url.includes("pageToken=p2"), `second page must pass the token: ${lists[1].url}`);
  assert.ok(lists[0].url.includes("mine=true"), "must scope the search to the operator's own playlists");
  assert.ok(
    !calls.some((c) => c.url.includes("/playlists?") && c.method === "POST"),
    "must NOT create a playlist when one with that title already exists",
  );
  const insert = calls.find((c) => c.url.includes("/playlistItems?"));
  assert.ok(insert, "should have inserted the video");
  assert.deepEqual(insert.body, {
    snippet: { playlistId: "PL_B", resourceId: { kind: "youtube#video", videoId: "VID1" } },
  });
  console.log("OK: found an existing playlist on page 2, reused it, inserted the video");

  // --- 2. No playlist of that title yet ----------------------------------------------------
  // A title the first case did not resolve: ids are remembered per process (case 5), so reusing
  // "MCSR Ranked matches" here would never reach the create path it is meant to test.
  calls = stubFetch([{ items: [{ id: "PL_A", snippet: { title: "Other" } }] }], "PL_CREATED");
  await addToPlaylist("VID2", "Season one");

  const created = calls.find((c) => c.url.includes("/playlists?") && c.method === "POST");
  assert.ok(created, "should have created the playlist");
  assert.deepEqual(created.body, {
    snippet: { title: "Season one" },
    status: { privacyStatus: "public" },
  });
  const insert2 = calls.find((c) => c.url.includes("/playlistItems?"));
  assert.equal(
    (insert2?.body as { snippet: { playlistId: string } }).snippet.playlistId,
    "PL_CREATED",
    "must insert into the playlist it just created, not a stale id",
  );
  console.log("OK: created the playlist when absent, inserted into the new id");

  // --- 3. A failure surfaces rather than being swallowed ------------------------------------
  // The upload route treats a throw here as "uploaded, but not added". Returning quietly would
  // report a clean upload with the video missing from the playlist.
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ error: { message: "Playlist not found", errors: [{ reason: "playlistNotFound" }] } }),
      { status: 404 },
    );
  }) as typeof fetch;
  await assert.rejects(() => addToPlaylist("VID3", "MCSR Ranked matches"), /playlistNotFound/);
  console.log("OK: an API failure throws, with the actionable reason in the message");

  // --- 4. One matchup, one playlist, whichever seat each player got -------------------------
  // Purely local: the title is the whole guard against a rematch creating a second playlist,
  // since `findOrCreatePlaylist` matches on the exact string.
  assert.equal(matchupPlaylistTitle("doogile", "Feinberg"), "doogile vs Feinberg · MCSR Ranked");
  assert.equal(
    matchupPlaylistTitle("Feinberg", "doogile"),
    matchupPlaylistTitle("doogile", "Feinberg"),
    "swapping the seats must not produce a second playlist",
  );
  // Case-insensitively, because a plain sort puts every capitalised nickname first and the same
  // pair would then split in two the moment the API seated them the other way round.
  assert.equal(matchupPlaylistTitle("apple", "Banana"), "apple vs Banana · MCSR Ranked");
  console.log("OK: the per-matchup title is seat- and case-independent");

  // --- 5. A created playlist is remembered, because listing does not show it yet ---------------
  // Measured on the real channel: create, then list one second later, and the new playlist is
  // absent — the next insert created a duplicate. The second call must not list at all.
  calls = stubFetch([{ items: [] }, { items: [] }], "PL_ONCE");
  await addToPlaylist("VID5", "Season two");
  await addToPlaylist("VID6", "Season two");
  const creates = calls.filter((c) => c.url.includes("/playlists?") && c.method === "POST").length;
  const lists2 = calls.filter((c) => c.url.includes("/playlists?") && c.method === "GET").length;
  assert.equal(creates, 1, "the same title must be created once per process, not per upload");
  assert.equal(lists2, 1, "after creating, the id is remembered rather than listed again");
  console.log("OK: a freshly created playlist is reused without re-listing");

  console.log("playlist: all checks passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
