// Paging and windowing against a stubbed Twitch GQL. Run: npx tsx src/twitchChat.test.ts
import assert from "node:assert/strict";
import { chatWindowsFromDescription, fetchVodChat } from "./twitchChat.js";

const node = (at: number, name: string, text: string, color: string | null = "#FF0000") => ({
  node: {
    id: `${at}-${name}`,
    contentOffsetSeconds: at,
    commenter: { displayName: name },
    message: { fragments: [{ text }], userColor: color },
  },
  cursor: `c${at}`,
});
const page = (edges: ReturnType<typeof node>[], hasNextPage: boolean) => ({
  data: { video: { comments: { edges, pageInfo: { hasNextPage } } } },
});

/** Answers each call with the next page and records what was asked. */
function stub(pages: unknown[]) {
  const asked: unknown[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    asked.push(JSON.parse(init!.body as string)[0].variables);
    return new Response(JSON.stringify([pages[i++] ?? page([], false)]), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

{
  // Two pages, a message before the window, one after it, and relative times out.
  const { fetchImpl, asked } = stub([
    page([node(4965, "early", "gl"), node(4970, "a", "gl", "#FF7F50"), node(5000, "b", "sob", null)], true),
    page([node(5000, "b", "sob", null), node(5100, "c", "gg"), node(5700, "late", "bye")], true),
  ]);
  const chat = await fetchVodChat("2868185091", 4970, 5600, fetchImpl);
  assert.deepEqual(chat, [
    { atSec: 0, name: "a", color: "#FF7F50", text: "gl" },
    { atSec: 30, name: "b", color: null, text: "sob" },
    { atSec: 130, name: "c", color: "#FF0000", text: "gg" },
  ]);
  assert.deepEqual(
    asked[0],
    { videoID: "2868185091", contentOffsetSeconds: 4970 },
    "first page starts at the offset",
  );
  assert.deepEqual(
    asked[1],
    { videoID: "2868185091", contentOffsetSeconds: 5000 },
    "next page is asked from the last message's second — a cursor fails Twitch's integrity check",
  );
  assert.equal(asked.length, 2, "stops at the first message past the window without another request");
  console.log("OK: pages by offset, overlap deduplicated, window kept, times relative to its start");

  // A second busier than a page: the same page would come back forever, so the walk stops.
  const same = [node(7, "p", "a"), node(7, "q", "b")];
  const busy = stub([page(same, true), page(same, true)]);
  assert.equal((await fetchVodChat("9", 0, 100, busy.fetchImpl)).length, 2);
  assert.equal(busy.asked.length, 2, "one repeat, then stop");
}

{
  // hasNextPage false ends it; a VOD with no chat is an empty list.
  const { fetchImpl, asked } = stub([page([node(10, "x", "hi")], false)]);
  assert.equal((await fetchVodChat("1", 0, 100, fetchImpl)).length, 1);
  assert.equal(asked.length, 1);
  const none = stub([{ data: { video: null } }]);
  assert.deepEqual(await fetchVodChat("2", 0, 100, none.fetchImpl), []);
  console.log("OK: the last page ends the walk; a chat-less VOD is empty, not an error");
}

{
  // Twitch's own error (a rotated query hash is the likely one) surfaces with its message.
  const bad = stub([{ errors: [{ message: "PersistedQueryNotFound" }] }]);
  await assert.rejects(() => fetchVodChat("3", 0, 10, bad.fetchImpl), /PersistedQueryNotFound/);
  console.log("OK: a GQL error names itself");
}

{
  const text = [
    "Chapters:",
    "Watch Aquacorde's POV: https://www.twitch.tv/videos/2868185091?t=4990s",
    "Watch Infume's POV: https://www.twitch.tv/videos/2868235527?t=1176s",
    "Match data: https://mcsrranked.com/matches/13171737",
  ].join("\n");
  assert.deepEqual(chatWindowsFromDescription(text), [
    { nickname: "Aquacorde", videoId: "2868185091", fromSec: 4990 },
    { nickname: "Infume", videoId: "2868235527", fromSec: 1176 },
  ]);
  console.log("OK: both POV windows read back from the description");
}
console.log("twitchChat: all checks passed");
