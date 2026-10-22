/**
 * The pairs this channel has put out lately, for the suggestion order's soft demotion.
 *
 * A pair the audience has just watched is a repeat, and a pair that brings a new runner's audience
 * converts better (Feinberg vs Infume went up on 24, 27 and 29 Sept 2026). So a candidate whose two
 * players already have a long-form video public — or scheduled — within `pairRepeatDays` of now
 * counts for half when the cards are ordered (`presentSuggestions`), and the nightly takes the same
 * order. A demotion, not a skip: a marquee rematch still renders when nothing else qualifies.
 *
 * Two facts, both this machine's own: when each match's video goes or went public (`youtube.json`;
 * a match rendered and still waiting for its hooks has none yet, so its directory's mtime stands in)
 * and who played it (`matchStatusFor`: the API, the clip names on disk when it is down). They are
 * read in the background into a snapshot, as the rival's posts are (rivalPosts.ts): the suggestion
 * route is polled every two seconds during a scan and builds its payload synchronously. The snapshot
 * holds everything within `HORIZON_DAYS` and the setting windows it on every read, so changing
 * `pairRepeatDays` needs no refresh.
 *
 * ponytail: `youtube.json` records only. A Studio upload the channel scan found but nobody has
 * recorded is not seen; `pairGapTimes` (src/youtube/publishSlot.ts) also reads `channelUploadsSnapshot()`,
 * and so can this if that ever bites.
 */
import { statSync } from "node:fs";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { allUploads, publicPairCounts, type UploadRecord } from "../youtube/youtubeStore.js";
import { hiddenMatchIds } from "./matchShelf.js";
import { listProcessedMatchIds, matchStatusFor } from "./matchStatus.js";

export interface PairPost {
  players: readonly [string, string];
  /** When the long-form video goes or went public, epoch ms. */
  atMs: number;
}

/** What the loader lets `pairRepeatDays` be at most: the snapshot holds this much, the setting windows it. */
const HORIZON_DAYS = 30;
const DAY_MS = 86_400_000;
/** How old the snapshot may be before a refresh rereads the records; the uploads it reads change by the hour. */
const REFRESH_MS = 5 * 60_000;

/** The same two players in either order and any case, as one comparable key. A nickname has no "|". */
export const pairKey = (players: readonly [string, string]): string =>
  players
    .map((nickname) => nickname.toLowerCase())
    .sort()
    .join("|");

export interface PairPostDeps {
  uploads: () => Promise<
    ReadonlyArray<{
      matchId: number;
      record: Pick<UploadRecord, "publishAt" | "privacyStatus" | "uploadedAt">;
    }>
  >;
  /** Match directories still on the shelf, with when each was last touched; `recentPairPosts` drops the uploaded ones. */
  rendered: () => ReadonlyArray<{ matchId: number; atMs: number }>;
  /** The match's two nicknames, or null when they cannot be known. */
  namesOf: (matchId: number) => Promise<[string, string] | null>;
}

/** Who played a match never changes, so each is asked for once per process. */
const names = new Map<number, [string, string]>();

/**
 * A match's two nicknames (API spelling), cached forever once read — one `matchStatusFor` call
 * (so one MCSR request) the first time, free after. Exported for `src/dashboard/drawLearn.ts`,
 * which needs the same "who played this" lookup to attribute a video's views to its players.
 */
export async function cachedMatchPlayers(matchId: number): Promise<[string, string] | null> {
  const known = names.get(matchId);
  if (known) return known;
  const { leftNickname, rightNickname } = await matchStatusFor(matchId);
  // "?" is a match whose players could not be read at all: not an answer, asked again next time.
  if (leftNickname === "?" || rightNickname === "?") return null;
  const pair: [string, string] = [leftNickname, rightNickname];
  names.set(matchId, pair);
  return pair;
}

const liveDeps: PairPostDeps = {
  uploads: allUploads,
  rendered: () => {
    const hidden = hiddenMatchIds();
    return listProcessedMatchIds().flatMap((matchId) => {
      if (hidden.has(matchId)) return [];
      try {
        return [{ matchId, atMs: statSync(matchDir(matchId)).mtimeMs }];
      } catch {
        return []; // gone since the listing
      }
    });
  },
  namesOf: cachedMatchPlayers,
};

/**
 * Every long-form video within `HORIZON_DAYS` of `nowMs`, either side, with who played it. A video
 * counts at its scheduled time, else at its upload when it is not private; a private one with no
 * time has no day (the rule `pairGapTimes` in src/youtube/publishSlot.ts uses). A match with no
 * record that is still on the shelf — rendered last night, waiting for its hooks — counts at when
 * its directory was last touched, or it could render again tonight. A match whose players cannot be
 * read is left out: no constraint, never an error. The names are asked for one at a time: a boot
 * with a month of videos is thirty requests, and the scan beside it uses four at once.
 */
export async function recentPairPosts(nowMs: number, deps: PairPostDeps = liveDeps): Promise<PairPost[]> {
  const uploads = await deps.uploads();
  const recorded = new Set(uploads.map(({ matchId }) => matchId));
  const dated = [
    ...uploads.map(({ matchId, record }) => ({
      matchId,
      atMs: Date.parse(record.publishAt ?? (record.privacyStatus !== "private" ? record.uploadedAt : "")),
    })),
    ...deps.rendered().filter(({ matchId }) => !recorded.has(matchId)),
  ];
  const posts: PairPost[] = [];
  for (const { matchId, atMs } of dated) {
    // NaN (no time, or an unparseable one) fails the comparison.
    if (!(Math.abs(nowMs - atMs) < HORIZON_DAYS * DAY_MS)) continue;
    const players = await deps.namesOf(matchId).catch(() => null);
    if (players) posts.push({ players, atMs });
  }
  return posts;
}

let cached: { atMs: number; posts: PairPost[]; onChannel: ReadonlyMap<string, number> } = {
  atMs: 0,
  posts: [],
  onChannel: new Map(),
};
let inflight: Promise<void> | null = null;

/**
 * What is known right now that falls within `days` of `nowMs` (either side: a video scheduled for
 * tomorrow is as much a repeat as one from yesterday) — possibly nothing yet, and nothing at all
 * when `days` is 0. Synchronous, for the payload builder.
 */
export function recentPairPostsSnapshot(
  nowMs: number = Date.now(),
  days: number = config.pairRepeatDays,
): PairPost[] {
  return cached.posts.filter((post) => Math.abs(nowMs - post.atMs) < days * DAY_MS);
}

/**
 * Public long-forms per pair on the channel, all time (`publicPairCounts`), as of the last refresh:
 * the rivalry boost's history (src/dashboard/suggest.ts `rivalryCountFor`). Empty until the first.
 */
export const pairsOnChannelSnapshot = (): ReadonlyMap<string, number> => cached.onChannel;

/**
 * Rereads the records when the snapshot is older than five minutes, once at a time, and never
 * rejects. The routes that show suggestions fire and forget it, so the first request after boot
 * answers without the demotion and the next has it; the nightly awaits it.
 */
export function refreshPairPosts(nowMs: number = Date.now(), deps?: PairPostDeps): Promise<void> {
  if (inflight) return inflight;
  if (nowMs - cached.atMs < REFRESH_MS) return Promise.resolve();
  inflight = Promise.all([recentPairPosts(nowMs, deps), publicPairCounts(nowMs)])
    .then(([posts, onChannel]) => {
      cached = { atMs: nowMs, posts, onChannel };
    })
    .catch((err: unknown) => {
      // The last answer stands, and the next try is in a minute rather than on every poll.
      cached = { ...cached, atMs: nowMs - REFRESH_MS + 60_000 };
      console.error(`pairs: ${describeError(err)} (the repeat demotion keeps its last answer)`);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
