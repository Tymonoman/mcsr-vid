// Contract tests for the chat replay fetch, from the docs (CLAUDE.md "Chat replay (prototype)";
// handbook "Chat replay" and "Known pitfalls"; README "What it needs"). The promise list with
// shared P-numbers is at the top of src/api/mcsrApi.contract.test.ts; this file pins:
//
//  P11 Chat comes from Twitch's web GQL persisted query without a login, paging by offset —
//      never the cursor, which fails Twitch's integrity check without a browser token.
//  P12 Best effort: a missing or chat-less VOD is an empty list, and a Twitch failure (a rotated
//      hash, a 5xx, a dead connection) never costs a render — `saveChats` logs and moves on.
//  P13 Twitch chat needs nothing: no credentials are sent, not even the app's own Helix ones.
//
// What twitchChat.test.ts already pins (two-page offset walk, the busy-second stop, the
// description windows, saveChats' skip/tolerate/write, readChats' clock shift) is not repeated.
// Messages here are synthetic ("m1", "m2"…), never real viewer text. Stubbed fetch, no network.
// Run: npx tsx src/api/twitchChat.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chatPath, fetchVodChat, saveChats } from "./twitchChat.js";

// Sentinels: if any of these reach a request, a credential leaked into the public chat call.
process.env.TWITCH_CLIENT_ID = "sentinel-helix-client-id";
process.env.TWITCH_CLIENT_SECRET = "sentinel-helix-secret";

type Edge = { node: unknown; cursor: string };
const edge = (id: string, at: number, extra: Record<string, unknown> = {}): Edge => ({
  node: {
    id,
    contentOffsetSeconds: at,
    commenter: { displayName: `viewer${id}` },
    message: { fragments: [{ text: `m${id}` }], userColor: null },
    ...extra,
  },
  cursor: `cursor-${id}`,
});
const page = (edges: Edge[], hasNextPage = true) => [
  { data: { video: { comments: { edges, pageInfo: { hasNextPage } } } } },
];

interface Asked {
  url: string;
  method: string;
  headers: Headers;
  body: { operationName: string; variables: Record<string, unknown>; extensions: unknown }[];
}
/** A Twitch that answers each request from `answer(offset, n)`, recording what was asked. */
function twitch(answer: (offset: number, n: number) => unknown | Response) {
  const asked: Asked[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    asked.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body,
    });
    const out = answer(body[0].variables.contentOffsetSeconds as number, asked.length);
    return out instanceof Response ? out : new Response(JSON.stringify(out));
  }) as typeof fetch;
  return { fetchImpl, asked };
}

/* --- P11 + P13: a four-page walk, by offset, with no login ------------------------------------ */
{
  // Each page overlaps the next by its last second, as asking again from that second does.
  const pages: Record<number, Edge[]> = {
    100: [edge("1", 100), edge("2", 101), edge("3", 104)],
    104: [edge("3", 104), edge("4", 104), edge("5", 110)],
    110: [edge("5", 110), edge("6", 115), edge("7", 120)],
    120: [edge("7", 120), edge("8", 125), edge("9", 400)],
  };
  const t = twitch((offset) => page(pages[offset] ?? [], true));
  const chat = await fetchVodChat("2880399328", 100, 300, t.fetchImpl);

  assert.deepEqual(
    chat.map((m) => m.text),
    ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"],
    "every message once, oldest first, the overlap deduplicated and the one past the window dropped",
  );
  assert.deepEqual(
    t.asked.map((a) => a.body[0]!.variables.contentOffsetSeconds),
    [100, 104, 110, 120],
    "each page is asked from the previous page's last second",
  );
  for (const a of t.asked) {
    // The cursor the response carries fails Twitch's integrity check without a browser token.
    assert.equal("cursor" in a.body[0]!.variables, false, "never a cursor, on any page");
    assert.deepEqual(Object.keys(a.body[0]!.variables).sort(), ["contentOffsetSeconds", "videoID"]);
    assert.equal(
      a.body[0]!.operationName,
      "VideoCommentsByOffsetOrCursor",
      "the web player's persisted query",
    );
    assert.ok(
      (a.body[0]!.extensions as { persistedQuery?: unknown }).persistedQuery,
      "sent as a persisted query",
    );
    assert.equal(a.url, "https://gql.twitch.tv/gql");
    assert.equal(a.method, "POST");
    // No login: the web client id only, and never an Authorization header or the app's own
    // Helix credentials (those exist for the follower count, nothing else).
    assert.equal(a.headers.has("authorization"), false, "no login");
    assert.ok(a.headers.get("client-id"), "the web client id");
    for (const [, value] of a.headers) {
      assert.ok(!value.includes("sentinel"), `no Helix credential in a chat request: ${value}`);
    }
    assert.ok(!JSON.stringify(a.body).includes("sentinel"), "nor in its body");
  }
}

/* --- The window's edges ------------------------------------------------------------------------- */
{
  // A fractional match start: the first page is asked from the whole second below it, a message
  // in that second but before the start is dropped, and times count from the exact start.
  const t = twitch(() => page([edge("a", 4970), edge("b", 4971), edge("c", 5000.5)], false));
  const chat = await fetchVodChat("1", 4970.4, 5000.5, t.fetchImpl);
  assert.equal(
    t.asked[0]!.body[0]!.variables.contentOffsetSeconds,
    4970,
    "offset is a whole second, floored",
  );
  assert.deepEqual(
    chat.map((m) => [m.text, Number(m.atSec.toFixed(3))]),
    [
      ["mb", 0.6],
      ["mc", 30.1],
    ],
    "before the start is out; exactly at the end is in; times relative to the exact start",
  );
}
{
  // The stream began after the API's estimated match start (a late start): the window opens before
  // second 0 of the VOD. The request must still ask from 0 — Twitch has no negative offset.
  const t = twitch(() => page([edge("a", 0), edge("b", 12)], false));
  const chat = await fetchVodChat("1", -30, 60, t.fetchImpl);
  assert.equal(t.asked[0]!.body[0]!.variables.contentOffsetSeconds, 0, "never a negative offset");
  assert.deepEqual(
    chat.map((m) => m.atSec),
    [30, 42],
    "times still count from the window's start",
  );
}

/* --- Message shape: deleted account, no colour, emote fragments --------------------------------- */
{
  const t = twitch(() =>
    page(
      [
        edge("x", 10, {
          commenter: null,
          message: { fragments: [{ text: "m" }, { text: " " }, { text: "Emote" }], userColor: "#00FF7F" },
        }),
      ],
      false,
    ),
  );
  assert.deepEqual(await fetchVodChat("1", 0, 60, t.fetchImpl), [
    { atSec: 10, name: "?", color: "#00FF7F", text: "m Emote" },
  ]);
}

/* --- Never an unbounded loop against Twitch ------------------------------------------------------ */
{
  // A Twitch that always says "more" and always has a fresh comment at the same second: each page
  // looks like progress, so only the page cap ends the walk.
  let n = 0;
  const t = twitch(() => page([edge(String(++n), 50)], true));
  const chat = await fetchVodChat("1", 0, 100, t.fetchImpl);
  assert.ok(t.asked.length <= 2000, `the walk is capped (asked ${t.asked.length} pages)`);
  assert.equal(chat.length, t.asked.length, "and keeps what it read");
}

/* --- P12: chat-less is empty; failures throw from the fetch and are swallowed by saveChats -------- */
{
  const empty = twitch(() => [{ data: { video: { comments: null } } }]);
  assert.deepEqual(await fetchVodChat("1", 0, 60, empty.fetchImpl), [], "comments: null is an empty chat");
  const noEdges = twitch(() => page([], false));
  assert.deepEqual(await fetchVodChat("1", 0, 60, noEdges.fetchImpl), [], "no edges is an empty chat");

  const down = twitch(() => new Response("upstream", { status: 503 }));
  await assert.rejects(fetchVodChat("2880399328", 0, 60, down.fetchImpl), /503.*2880399328/);
  const blank = twitch(() => []);
  await assert.rejects(fetchVodChat("7", 0, 60, blank.fetchImpl), /no result/);
}
{
  const dir = mkdtempSync(path.join(tmpdir(), "twitchChat-contract-"));
  try {
    const lines: string[] = [];
    let calls = 0;
    // Three kinds of failure, then a working VOD: none of them may throw out of saveChats.
    const fetchImpl = (async (_: string | URL | Request, init?: RequestInit) => {
      calls++;
      const id = JSON.parse(String(init?.body))[0].variables.videoID as string;
      if (id === "net") throw new TypeError("fetch failed");
      if (id === "slow") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (id === "5xx") return new Response("", { status: 500 });
      return new Response(JSON.stringify(page([edge("1", 20)], false)));
    }) as typeof fetch;
    const windows = [
      { nickname: "NetDown", videoId: "net", fromSec: 0 },
      { nickname: "TimedOut", videoId: "slow", fromSec: 0 },
      { nickname: "ServerErr", videoId: "5xx", fromSec: 0 },
      { nickname: "Fine", videoId: "2", fromSec: 10 },
    ];
    const counts = await saveChats(dir, windows, 60, (l) => lines.push(l), fetchImpl);
    assert.deepEqual(counts, { Fine: 1 }, "the failures are not counted, the working one is");
    assert.equal(
      lines.filter((l) => /continuing without it/.test(l)).length,
      3,
      `each failure logged: ${lines}`,
    );
    for (const w of windows.slice(0, 3)) {
      // Nothing written for a failure, so the next run (while the VOD lives) tries again rather
      // than skipping an empty file for ever.
      assert.equal(existsSync(chatPath(dir, w.nickname)), false, `no file for ${w.nickname}`);
    }
    assert.equal(JSON.parse(readFileSync(chatPath(dir, "Fine"), "utf8")).messages[0].atSec, 10);

    // The retry: Twitch is back, the three are fetched, the saved one is not asked again.
    let retried = 0;
    const ok = (async () => {
      retried++;
      return new Response(JSON.stringify(page([], false)));
    }) as unknown as typeof fetch;
    const retry = await saveChats(dir, windows, 60, () => {}, ok);
    assert.deepEqual(Object.keys(retry).sort(), ["NetDown", "ServerErr", "TimedOut"]);
    assert.equal(retried, 3, "one request each for the three; the saved chat is not asked again");
    assert.equal(calls, 4, "(the first run asked once per window)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("twitchChat.contract: all checks passed");
