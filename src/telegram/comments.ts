/**
 * Which comment threads still need the operator — pure filtering over what
 * `channelCommentThreads` (src/youtube/youtube.ts) fetched, so it can be pinned without an API.
 */
import type { ChannelCommentThread } from "../youtube/youtube.js";

export interface UnansweredComment extends ChannelCommentThread {
  /** `totalReplyCount` is more than the API returned, and none of the returned ones were the
   *  channel's — it may already be answered by a reply this page does not show. */
  repliesTruncated: boolean;
}

/**
 * Unanswered = the top-level comment is not the channel's own, and none of the replies the API
 * returned are either. When more replies exist than were returned, "unanswered" is a maybe — the
 * flag says so rather than the report claiming certainty it does not have.
 */
export function filterUnanswered(threads: readonly ChannelCommentThread[]): UnansweredComment[] {
  return threads
    .filter((t) => !t.authorIsChannel && !t.replyAuthorsAreChannel.some(Boolean))
    .map((t) => ({ ...t, repliesTruncated: t.totalReplyCount > t.replyAuthorsAreChannel.length }));
}
