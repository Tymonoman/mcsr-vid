/**
 * Twitch VOD chat replay, for the chat panel the active competitor runs and we do not (MCSR
 * Matches shows both players' chats beside the splits; watched 2026-09-08).
 *
 * Twitch has no public REST endpoint for replayed chat. What exists is the web player's own GQL
 * persisted query, `VideoCommentsByOffsetOrCursor`, which answers without a login when sent
 * with the web client id — the same call TwitchDownloader makes. Paging is by *offset*, not by
 * the cursor the response offers: a cursor request fails Twitch's integrity check without a
 * browser-issued token (measured 2026-09-08), while asking again from the last message's second
 * does not. The overlap that creates is deduplicated by comment id. If Twitch rotates the query
 * hash this throws with Twitch's own message, which is the failure to look for first.
 */

const GQL_URL = "https://gql.twitch.tv/gql";
const WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const COMMENTS_QUERY_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";

export interface ChatMessage {
  /** Seconds after the window start (i.e. after match start when the caller passes the match offset). */
  atSec: number;
  name: string;
  /** Twitch's per-user colour, or null when the user never picked one. */
  color: string | null;
  text: string;
}

interface CommentNode {
  id: string;
  contentOffsetSeconds: number;
  commenter: { displayName: string } | null;
  message: { fragments: Array<{ text: string }>; userColor: string | null };
}

interface CommentsPage {
  data?: {
    video?: {
      comments?: {
        edges: Array<{ node: CommentNode; cursor: string }>;
        pageInfo: { hasNextPage: boolean };
      } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

async function commentsPage(
  videoId: string,
  offsetSec: number,
  fetchImpl: typeof fetch,
): Promise<CommentsPage> {
  const body = [
    {
      operationName: "VideoCommentsByOffsetOrCursor",
      variables: { videoID: videoId, contentOffsetSeconds: offsetSec },
      extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_QUERY_HASH } },
    },
  ];
  const res = await fetchImpl(GQL_URL, {
    method: "POST",
    headers: { "Client-Id": WEB_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Twitch GQL ${res.status} for VOD ${videoId}`);
  const [page] = (await res.json()) as CommentsPage[];
  if (!page) throw new Error(`Twitch GQL returned no result for VOD ${videoId}`);
  if (page.errors?.length) throw new Error(`Twitch GQL: ${page.errors.map((e) => e.message).join("; ")}`);
  return page;
}

/**
 * Every chat message posted between `fromSec` and `toSec` of the VOD, oldest first, with times
 * relative to `fromSec`. A missing or chat-less VOD is an empty list, not a throw: a match with
 * one silent chat is still a match.
 */
export async function fetchVodChat(
  videoId: string,
  fromSec: number,
  toSec: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  const seen = new Set<string>();
  let offset = Math.max(0, Math.floor(fromSec));
  // A hard cap on pages: at ~60 comments a page a 20-minute window is a few hundred, and a
  // paging bug must not become an unbounded loop against Twitch.
  for (let pages = 0; pages < 2000; pages++) {
    const page = await commentsPage(videoId, offset, fetchImpl);
    const comments = page.data?.video?.comments;
    if (!comments) return out;
    let past = false;
    let fresh = 0;
    for (const { node } of comments.edges) {
      const at = node.contentOffsetSeconds;
      if (at > toSec) {
        past = true;
        break;
      }
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      fresh++;
      if (at < fromSec) continue;
      out.push({
        atSec: at - fromSec,
        name: node.commenter?.displayName ?? "?",
        color: node.message.userColor ?? null,
        text: node.message.fragments.map((f) => f.text).join(""),
      });
    }
    const last = comments.edges[comments.edges.length - 1];
    // No new comment on a page means the next offset would return the same page forever: a
    // second of chat busier than one page holds, which is the one shape this walk cannot read.
    if (past || !comments.pageInfo.hasNextPage || !last || fresh === 0) return out;
    offset = last.node.contentOffsetSeconds;
  }
  return out;
}

/**
 * The two POVs' VOD ids and match offsets, read back from the description the pipeline wrote —
 * `Watch <nick>'s POV: https://www.twitch.tv/videos/<id>?t=<n>s`. The pipeline holds these as
 * `VodWindow`s in memory and persists nothing else with them; until the chat download is a
 * pipeline stage, the description is the durable copy.
 */
export function chatWindowsFromDescription(
  text: string,
): Array<{ nickname: string; videoId: string; fromSec: number }> {
  const out: Array<{ nickname: string; videoId: string; fromSec: number }> = [];
  for (const m of text.matchAll(
    /^Watch (.+?)'s POV: https:\/\/www\.twitch\.tv\/videos\/(\d+)\?t=(\d+)s$/gm,
  )) {
    out.push({ nickname: m[1]!, videoId: m[2]!, fromSec: Number(m[3]) });
  }
  return out;
}
