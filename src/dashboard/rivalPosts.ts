/**
 * What the competitors have already published, matched against our candidates.
 *
 * A rival posts the same matches a day later to a far larger audience, so a match it has already
 * covered competes with its own video for the same browse session. The suggestion cards and the
 * match list say which of two things a rival did: posted *this match*, or only *this pair* in
 * another match. Only the first puts the card after the fresh ones in the display order (which is
 * also the nightly's); the second is information.
 *
 * "This match" is decided by the strongest signal the rival's public feed carries, and the feeds
 * differ (read 16 Oct 2026, `feeds/videos.xml`, title + published + media:description):
 *  - MCSR Replays (@mcsrreplay): the description links the match page
 *    (`mcsrranked.com/stats/<nick>/<id>`), so the id decides, exactly. Dormant since 18 Apr 2026,
 *    so not in the default list; it is read correctly if someone adds it back.
 *  - MCSR Matches (@mcsrmatches) and MCSR Vault (@mcsr-vault): the description is boilerplate
 *    (a PayPal link and hashtags; Vault's names the players' Twitch channels), no id, no date, no
 *    seed. The pair and a window after the match date are all there is (`rivalMatchFor`).
 *
 * Read from the channel's public upload feed with no token: the API audit told Google the
 * channel's OAuth token reads its own channel only, so another channel's uploads are read the way
 * any visitor reads them. Every six hours, and never a reason for the suggestions page to fail: no
 * network, no rival channel configured — both read as "nothing known", not an error.
 */
import { config } from "../config.js";
import { describeError } from "../errorText.js";

export interface RivalPost {
  /** The handle whose feed it came from, without the @. */
  channel: string;
  title: string;
  publishedAtMs: number;
  /** Normalised nicknames from the title, or null when the title names no matchup. */
  players: [string, string] | null;
  /** Match ids the description links (mcsrranked.com); absent or empty when it links none. */
  matchIds?: number[];
  /**
   * The video's length. What tells two matches of one pair apart — the public feed carries none,
   * so it is absent since 14 Oct 2026 and matching is by pair and date alone.
   */
  durationSec?: number;
}

/**
 * The rival's video is the run plus a few seconds either side (measured: 8:59 for an 8:48 run,
 * 7:07 for a sub-7). A post whose length is outside this band of a match's run time is a
 * different match of the same pair — Aquacorde and nahhann played three times in one night.
 */
const DURATION_SLACK_SEC = { before: 5, after: 30 };

function durationFits(post: RivalPost, runSec: number | undefined): boolean | null {
  if (runSec === undefined || post.durationSec === undefined) return null;
  const gap = post.durationSec - runSec;
  return gap >= -DURATION_SLACK_SEC.before && gap <= DURATION_SLACK_SEC.after;
}

export interface RivalMatch {
  title: string;
  publishedAtMs: number;
}

/**
 * Nicknames as the rival types them ("Nahhann", "Darvy  x1") against ours ("nahhann", "DARVY__X1"):
 * case and punctuation only. A different spelling ("Lowkey" for lowk3y_) does not match.
 */
export const normaliseNick = (nick: string): string => nick.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The title grammars the rival has used: `HOOK | A vs B | MCSR Ranked | ...` since August, the same
 * without a hook (`A vs B | MCSR Ranked | ...`, 10 of its newest 15 uploads on 30 Sept 2026), and
 * `A vs B MCSR Ranked Minecraft Speedrun` before it, still posted now and then. The pair is what
 * stands right before the MCSR tag, so an "X vs Y" inside a hook is never taken for it. A nickname may
 * hold spaces — the rival types an underscore as one ("Darvy  x1" is DARVY__X1) — which
 * `normaliseNick` drops.
 */
export function playersFromTitle(title: string): [string, string] | null {
  const piped = /(?:^|\|)\s*([^|]+?)\s+vs\.?\s+([^|]+?)\s*\|\s*MCSR/i.exec(title);
  // Unpiped, a hook in front would read as part of the first nickname, so that one is a single word.
  const plain = /^\s*(\S+)\s+vs\.?\s+([^|]+?)\s+MCSR/i.exec(title);
  const m = piped ?? plain;
  if (!m) return null;
  // MCSR Vault adds the broadcast name in brackets ("Pinne (Skycrab) VS ANJOUU"): the API's comes first.
  const a = normaliseNick(m[1]!.replace(/\(.*?\)/g, ""));
  const b = normaliseNick(m[2]!.replace(/\(.*?\)/g, ""));
  return a && b ? [a, b] : null;
}

/** How long after a match the rival's post still counts as "this match": its cadence is daily. */
const POST_WINDOW_DAYS = 10;

/** The rival's post of this matchup, if it has one within the window after the match. */
export function rivalMatchFor(
  posts: readonly RivalPost[],
  players: readonly [string, string],
  matchDateSec: number,
  runSec?: number,
): RivalMatch | null {
  const ours = [normaliseNick(players[0]), normaliseNick(players[1])].sort().join("|");
  const from = matchDateSec * 1000;
  const to = from + POST_WINDOW_DAYS * 86_400_000;
  const hits = posts.filter(
    (p) =>
      p.players &&
      [...p.players].sort().join("|") === ours &&
      p.publishedAtMs >= from &&
      p.publishedAtMs <= to,
  );
  // With lengths to compare, only a post the right length counts; one that is not is the rival
  // posting another match of the pair, which must not demote this one. Without lengths (the
  // public feed has none), the pair and the window are all there is.
  const judged = hits.map((p) => ({ p, fits: durationFits(p, runSec) }));
  const hit =
    judged.find((j) => j.fits === true)?.p ?? (judged.every((j) => j.fits === null) ? hits[0] : undefined);
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

export interface RivalSighting {
  channel: string;
  /** "match": this very match. "pair": the same two players in another match — information only. */
  kind: "match" | "pair";
  title: string;
  publishedAtMs: number;
}

/**
 * What each rival did with this match, one line per channel that posted the pair at all: "match"
 * when a post links this match's id, else (a post that names no match) when `rivalMatchFor`'s pair
 * and window say so — or, with no date to hand (`dateSec` null: the API was down for the shelf),
 * `rivalRecentPostFor`'s last two weeks; otherwise "pair", the channel's latest post of the two.
 * A post linking another id is another match whatever its date.
 */
export function rivalSightingsFor(
  posts: readonly RivalPost[],
  match: { matchId: number; players: readonly [string, string]; dateSec: number | null; runSec?: number },
  nowMs: number,
): RivalSighting[] {
  const ours = [normaliseNick(match.players[0]), normaliseNick(match.players[1])].sort().join("|");
  return [...new Set(posts.map((p) => p.channel))].flatMap((channel): RivalSighting[] => {
    const own = posts.filter((p) => p.channel === channel);
    const unlinked = own.filter((p) => !p.matchIds?.length);
    const same =
      own.find((p) => p.matchIds?.includes(match.matchId)) ??
      (match.dateSec === null
        ? rivalRecentPostFor(unlinked, match.players, nowMs)
        : rivalMatchFor(unlinked, match.players, match.dateSec, match.runSec));
    if (same) return [{ channel, kind: "match", title: same.title, publishedAtMs: same.publishedAtMs }];
    const pair = own
      .filter((p) => p.players && [...p.players].sort().join("|") === ours)
      .sort((a, b) => b.publishedAtMs - a.publishedAtMs)[0];
    return pair ? [{ channel, kind: "pair", title: pair.title, publishedAtMs: pair.publishedAtMs }] : [];
  });
}

/**
 * A sighting as the page renders it: the line, and the rival's own title for its tooltip. The
 * date is the operator's (Europe/Warsaw).
 */
export function rivalLine(s: RivalSighting): { kind: RivalSighting["kind"]; label: string; title: string } {
  const date = new Date(s.publishedAtMs).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Warsaw",
  });
  const label =
    s.kind === "match"
      ? `@${s.channel} posted this match (${date})`
      : `@${s.channel} posted this pair: a different match (${date})`;
  return { kind: s.kind, label, title: s.title };
}

/** The configured rivals' handles, without the @. */
export const rivalHandles = (): string[] =>
  config.rivalChannelHandle.map((h) => h.trim().replace(/^@/, "")).filter(Boolean);

/** `@handle` → `UC…`, read once per boot off the public channel page. */
const channelIds = new Map<string, string>();

async function channelIdFor(handle: string, fetchImpl: typeof fetch): Promise<string> {
  handle = handle.replace(/^@/, "");
  const known = channelIds.get(handle);
  if (known) return known;
  // SOCS=CAI is the "reject all" answer to the EU consent page that otherwise stands in front of it.
  const res = await fetchImpl(`https://www.youtube.com/@${encodeURIComponent(handle)}`, {
    headers: { cookie: "SOCS=CAI" },
  });
  if (!res.ok) throw new Error(`channel page for @${handle}: HTTP ${res.status}`);
  const html = await res.text();
  // The canonical link first: a "channelId" further down may be a featured channel's.
  const id = (
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html) ??
    /"(?:externalId|channelId)":"(UC[\w-]{22})"/.exec(html)
  )?.[1];
  if (!id) throw new Error(`no channel id on the page for @${handle}`);
  channelIds.set(handle, id);
  return id;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string): string =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (_, dec, hex, name) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : XML_ENTITIES[name]!,
  );

/**
 * The public feed's entries, newest first. An entry with no title or date is skipped. A match page
 * linked from the description is either form: ours and the API's `/matches/<id>`, MCSR Replays'
 * `/stats/<nick>/<id>`.
 */
export function parseRivalFeed(xml: string, channel: string): RivalPost[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap(([, entry]) => {
    const title = unescapeXml(/<title>([^<]*)<\/title>/.exec(entry!)?.[1] ?? "");
    const publishedAtMs = Date.parse(/<published>([^<]*)<\/published>/.exec(entry!)?.[1] ?? "");
    if (!title || Number.isNaN(publishedAtMs)) return [];
    const description = /<media:description>([^<]*)<\/media:description>/.exec(entry!)?.[1] ?? "";
    const matchIds = [...description.matchAll(/mcsrranked\.com\/(?:matches|stats\/[^/\s]+)\/(\d+)/g)].map(
      (m) => Number(m[1]),
    );
    return [{ channel, title, publishedAtMs, players: playersFromTitle(title), matchIds }];
  });
}

/**
 * A rival's last fifteen uploads (all the feed holds — two weeks at MCSR Matches' daily cadence,
 * the matching window), newest first, with no token on any request. Throws on failure; the cache
 * below catches.
 */
export async function fetchRivalPosts(handle: string, fetchImpl: typeof fetch = fetch): Promise<RivalPost[]> {
  const id = await channelIdFor(handle, fetchImpl);
  const res = await fetchImpl(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
  if (!res.ok) throw new Error(`feed for @${handle}: HTTP ${res.status}`);
  return parseRivalFeed(await res.text(), handle.replace(/^@/, ""));
}

const REFRESH_MS = 6 * 60 * 60 * 1000;
/** Each handle's last good read: one feed failing keeps its last answer and never blanks another's. */
const cached = new Map<string, RivalPost[]>();
/** When the feeds were last asked, and for which handles: a Settings change to the list is stale at once. */
let checked = { atMs: 0, handles: "" };
let inflight: Promise<void> | null = null;

/** What is known right now about the configured rivals — possibly nothing yet. Synchronous, for the payload builder. */
export function rivalPostsSnapshot(): RivalPost[] {
  return rivalHandles().flatMap((h) => cached.get(h) ?? []);
}

/**
 * Refreshes the cache when it is older than six hours, in the background, once at a time.
 * Fire-and-forget from the routes that show suggestions; the first request after boot returns
 * without the badges and the next has them.
 */
export function refreshRivalPostsIfStale(nowMs: number = Date.now()): void {
  const handles = rivalHandles();
  if (handles.length === 0) return;
  if (inflight || (nowMs - checked.atMs < REFRESH_MS && checked.handles === handles.join())) return;
  inflight = Promise.all(
    handles.map((handle) =>
      fetchRivalPosts(handle).then(
        (posts) => {
          cached.set(handle, posts);
          console.error(`rival: ${posts.length} posts from @${handle}`);
          return true;
        },
        (err: unknown) => {
          console.error(`rival: ${describeError(err)} (@${handle} keeps its last answer until the next try)`);
          return false;
        },
      ),
    ),
  )
    .then((ok) => {
      // A failure tries again in five minutes rather than in six hours — a transient 5xx should
      // not blank the badges for a quarter of a day — but not on every request either: the
      // suggestions route is polled every two seconds during a scan, and a dead feed would be
      // fetched per poll.
      checked = { atMs: ok.every(Boolean) ? nowMs : nowMs - REFRESH_MS + 5 * 60_000, handles: handles.join() };
    })
    .finally(() => {
      inflight = null;
    });
}
