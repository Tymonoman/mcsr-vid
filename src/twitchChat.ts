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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describeError } from "./errorText.js";

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

export interface ChatWindow {
  nickname: string;
  videoId: string;
  /** Seconds into the VOD where the match starts. */
  fromSec: number;
}

/** The file beside the media: `chat-<nick>.json`. */
export const chatPath = (dir: string, nickname: string): string => path.join(dir, `chat-${nickname}.json`);

/**
 * Fetches and writes one chat file per window, skipping files that exist. Best effort by
 * design: chat dies with the VOD, so the pipeline saves it while the VODs are known to exist,
 * but Twitch rotating its query must never cost a render — a failure is logged and the next
 * window is tried. Returns the message count per nickname for the log line.
 */
export async function saveChats(
  dir: string,
  windows: readonly ChatWindow[],
  spanSec: number,
  log: (line: string) => void = (line) => console.error(line),
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const w of windows) {
    const out = chatPath(dir, w.nickname);
    if (existsSync(out)) continue;
    try {
      const messages = await fetchVodChat(w.videoId, w.fromSec, w.fromSec + spanSec, fetchImpl);
      await writeFile(
        out,
        JSON.stringify(
          { nickname: w.nickname, videoId: w.videoId, fromSec: w.fromSec, spanSec, messages },
          null,
          1,
        ),
      );
      counts[w.nickname] = messages.length;
      log(`chat: ${w.nickname}: ${messages.length} messages over ${spanSec.toFixed(0)}s`);
    } catch (err) {
      log(`chat: ${w.nickname}: ${describeError(err)} (continuing without it)`);
    }
  }
  return counts;
}

/**
 * Every saved message's time for a match, both chats merged, in seconds after match start —
 * the shape `shortMoment.ts` scores with. No files, or unreadable ones, is an empty list: the
 * moment picker must behave exactly as before chat existed.
 */
export function readChatTimes(dir: string): number[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^chat-.+\.json$/.test(f));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as {
        messages?: Array<{ atSec: number }>;
      };
      return (parsed.messages ?? []).map((m) => m.atSec).filter((t) => Number.isFinite(t));
    } catch {
      return [];
    }
  });
}

/** The VOD id in a `https://www.twitch.tv/videos/<id>` URL, or null. */
export const vodIdFromUrl = (url: string): string | null => /videos\/(\d+)/.exec(url)?.[1] ?? null;

/**
 * The two POVs' VOD ids and match offsets, read back from the description the pipeline wrote —
 * `Watch <nick>'s POV: https://www.twitch.tv/videos/<id>?t=<n>s`. The pipeline holds these as
 * `VodWindow`s in memory and persists nothing else with them; until the chat download is a
 * pipeline stage, the description is the durable copy.
 */
export function chatWindowsFromDescription(text: string): ChatWindow[] {
  const out: ChatWindow[] = [];
  for (const m of text.matchAll(
    /^Watch (.+?)'s POV: https:\/\/www\.twitch\.tv\/videos\/(\d+)\?t=(\d+)s$/gm,
  )) {
    out.push({ nickname: m[1]!, videoId: m[2]!, fromSec: Number(m[3]) });
  }
  return out;
}
