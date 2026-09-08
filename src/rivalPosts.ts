/**
 * What the active competitor has already published, matched against our candidates.
 *
 * MCSR Matches (@mcsrmatches) posts the same matches this channel picks — it put Aquacorde vs
 * Nahhann up the day after we did — with 37x our subscribers behind it. A matchup it has
 * already covered competes with its own video for the same browse session; a fresh one is
 * first. So the suggestion cards say when the rival has posted a candidate, and the display
 * order (which is also the nightly's order) puts those after the fresh ones.
 *
 * Two quota units per refresh (channels.list + playlistItems.list), refreshed every six hours,
 * and never a reason for the suggestions page to fail: no token, no network, no rival channel
 * configured — all read as "nothing known", not an error.
 */
import { config } from "./config.js";
import { describeError } from "./errorText.js";
import { getAccessToken, isConfigured } from "./youtube.js";

export interface RivalPost {
  title: string;
  publishedAtMs: number;
  /** Normalised nicknames from the title, or null when the title names no matchup. */
  players: [string, string] | null;
}

export interface RivalMatch {
  title: string;
  publishedAtMs: number;
}

/** Nicknames as the rival types them ("Nahhann", "Lowk3y") against ours ("nahhann", "lowk3y_"). */
export const normaliseNick = (nick: string): string => nick.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Both title grammars the rival has used: `HOOK | A vs B | MCSR Ranked | ...` since August, and
 * `A vs B MCSR Ranked Minecraft Speedrun` before it.
 */
export function playersFromTitle(title: string): [string, string] | null {
  const piped = /\|\s*([^|]+?)\s+vs\.?\s+([^|]+?)\s*\|/i.exec(title);
  const plain = /^\s*(\S+)\s+vs\.?\s+(\S+)\s+MCSR/i.exec(title);
  const m = piped ?? plain;
  if (!m) return null;
  const a = normaliseNick(m[1]!);
  const b = normaliseNick(m[2]!);
  return a && b ? [a, b] : null;
}

/** How long after a match the rival's post still counts as "this match": its cadence is daily. */
const POST_WINDOW_DAYS = 10;

/** The rival's post of this matchup, if it has one within the window after the match. */
export function rivalMatchFor(
  posts: readonly RivalPost[],
  players: readonly [string, string],
  matchDateSec: number,
): RivalMatch | null {
  const ours = [normaliseNick(players[0]), normaliseNick(players[1])].sort().join("|");
  const from = matchDateSec * 1000;
  const to = from + POST_WINDOW_DAYS * 86_400_000;
  const hit = posts.find(
    (p) =>
      p.players &&
      [...p.players].sort().join("|") === ours &&
      p.publishedAtMs >= from &&
      p.publishedAtMs <= to,
  );
  return hit ? { title: hit.title, publishedAtMs: hit.publishedAtMs } : null;
}

/**
 * The rival's most recent post of this matchup within `days`, for a match whose date is not to
 * hand — the shelf, whose entries carry nicknames but not the match itself. Every match on the
 * shelf is recent (VODs live ~10 days), so "posted in the last two weeks" is the same question.
 */
export function rivalRecentPostFor(
  posts: readonly RivalPost[],
  players: readonly [string, string],
  nowMs: number,
  days = 14,
): RivalMatch | null {
  const ours = [normaliseNick(players[0]), normaliseNick(players[1])].sort().join("|");
  const since = nowMs - days * 86_400_000;
  const hit = posts
    .filter(
      (p) =>
        p.players &&
        [...p.players].sort().join("|") === ours &&
        p.publishedAtMs >= since &&
        p.publishedAtMs <= nowMs,
    )
    .sort((a, b) => b.publishedAtMs - a.publishedAtMs)[0];
  return hit ? { title: hit.title, publishedAtMs: hit.publishedAtMs } : null;
}

/** The rival's last fifty uploads, newest first. Throws on API failure; the cache below catches. */
export async function fetchRivalPosts(handle: string, fetchImpl: typeof fetch = fetch): Promise<RivalPost[]> {
  const token = await getAccessToken();
  const yt = async (path: string): Promise<any> => {
    const res = await fetchImpl(`https://www.googleapis.com/youtube/v3/${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`YouTube ${res.status} for ${path.split("?")[0]}`);
    return res.json();
  };
  const channel = await yt(`channels?part=contentDetails&forHandle=${encodeURIComponent(handle)}`);
  const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error(`no channel for handle ${handle}`);
  const items = await yt(`playlistItems?part=snippet&playlistId=${uploads}&maxResults=50`);
  return (items.items ?? []).map((i: any) => ({
    title: String(i.snippet.title),
    publishedAtMs: Date.parse(i.snippet.publishedAt),
    players: playersFromTitle(String(i.snippet.title)),
  }));
}

const REFRESH_MS = 6 * 60 * 60 * 1000;
let cached: { atMs: number; posts: RivalPost[] } = { atMs: 0, posts: [] };
let inflight: Promise<void> | null = null;

/** What is known right now — possibly nothing yet. Synchronous, for the payload builder. */
export function rivalPostsSnapshot(): RivalPost[] {
  return cached.posts;
}

/**
 * Refreshes the cache when it is older than six hours, in the background, once at a time.
 * Fire-and-forget from the routes that show suggestions; the first request after boot returns
 * without the badges and the next has them.
 */
export function refreshRivalPostsIfStale(nowMs: number = Date.now()): void {
  if (!config.rivalChannelHandle || !isConfigured()) return;
  if (inflight || nowMs - cached.atMs < REFRESH_MS) return;
  inflight = fetchRivalPosts(config.rivalChannelHandle)
    .then((posts) => {
      cached = { atMs: nowMs, posts };
      console.error(`rival: ${posts.length} posts from @${config.rivalChannelHandle}`);
    })
    .catch((err: unknown) => {
      // Try again in five minutes rather than in six hours — a transient 5xx should not blank
      // the badges for a quarter of a day — but not on every request either: the suggestions
      // route is polled every two seconds during a scan, and a dead token would spend a call
      // per poll.
      cached = { ...cached, atMs: nowMs - REFRESH_MS + 5 * 60_000 };
      console.error(`rival: ${describeError(err)} (badges off until the next try)`);
    })
    .finally(() => {
      inflight = null;
    });
}

/** Test seam. */
export function _setRivalPostsForTest(posts: RivalPost[]): void {
  cached = { atMs: Date.now(), posts };
}
