// Self-check for comments.ts's unanswered-comment filter.
// Run: npx tsx src/telegram/comments.test.ts
import assert from "node:assert/strict";
import { filterUnanswered } from "./comments.js";
import type { ChannelCommentThread } from "../youtube/youtube.js";

const thread = (over: Partial<ChannelCommentThread>): ChannelCommentThread => ({
  threadId: "t",
  videoId: "v",
  author: "someone",
  authorIsChannel: false,
  text: "nice video",
  publishedAt: "2026-09-28T00:00:00Z",
  totalReplyCount: 0,
  replyAuthorsAreChannel: [],
  replies: [],
  ...over,
});

// The channel's own top-level comment (the pinned one) is never "unanswered".
assert.deepEqual(filterUnanswered([thread({ threadId: "own", authorIsChannel: true })]), []);

// Replied to by the channel, fully returned: answered.
assert.deepEqual(
  filterUnanswered([thread({ threadId: "replied", totalReplyCount: 1, replyAuthorsAreChannel: [true] })]),
  [],
);

// Replied to by someone else, not the channel: still unanswered.
{
  const out = filterUnanswered([
    thread({ threadId: "other-reply", totalReplyCount: 1, replyAuthorsAreChannel: [false] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.threadId, "other-reply");
  assert.equal(out[0]!.repliesTruncated, false);
}

// No replies at all: unanswered, no truncation.
{
  const out = filterUnanswered([thread({ threadId: "no-replies" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.repliesTruncated, false);
}

// More replies exist than the API returned, and none of the returned ones are the channel's:
// unanswered, but flagged as uncertain — a reply outside the returned page could be the channel's.
{
  const out = filterUnanswered([
    thread({ threadId: "truncated", totalReplyCount: 5, replyAuthorsAreChannel: [false, false] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.repliesTruncated, true);
}

// More replies exist than were returned, but a RETURNED one is the channel's: counts as answered
// despite the truncation — a page that already shows an answer is certain, however much is cut off.
assert.deepEqual(
  filterUnanswered([
    thread({ threadId: "answered-and-truncated", totalReplyCount: 5, replyAuthorsAreChannel: [false, true] }),
  ]),
  [],
);

// A mixed batch keeps only the unanswered ones, in order.
{
  const out = filterUnanswered([
    thread({ threadId: "a" }),
    thread({ threadId: "b", authorIsChannel: true }),
    thread({ threadId: "c" }),
  ]);
  assert.deepEqual(
    out.map((t) => t.threadId),
    ["a", "c"],
  );
}

console.log("comments: all checks passed");
