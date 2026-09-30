/**
 * The pairs this channel has put out lately, for the suggestion order's soft demotion.
 *
 * A pair the audience has just watched is a repeat, and a pair that brings a new runner's audience
 * converts better (Feinberg vs Infume went up on 24, 27 and 29 Sept 2026). So a candidate whose two
 * players already have a long-form video public — or scheduled — within `pairRepeatDays` of now
 * counts for half when the cards are ordered (`presentSuggestions`), and the nightly takes the same
 * order. A demotion, not a skip: a marquee rematch still renders when nothing else qualifies.
 *
 * Two facts, both this machine's own: when each match's video goes or went public (`youtube.json`)
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
import { config } from "../config.js";
import { describeError } from "../errorText.js";
import { allUploads, type UploadRecord } from "../youtube/youtubeStore.js";
import { matchStatusFor } from "./matchStatus.js";

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
  /** The match's two nicknames, or null when they cannot be known. */
  namesOf: (matchId: number) => Promise<[string, string] | null>;
}

/** Who played a match never changes, so each is asked for once per process. */
const names = new Map<number, [string, string]>();

const liveDeps: PairPostDeps = {
  uploads: allUploads,
  async namesOf(matchId) {
    const known = names.get(matchId);
    if (known) return known;
    const { leftNickname, rightNickname } = await matchStatusFor(matchId);
    // "?" is a match whose players could not be read at all: not an answer, asked again next time.
    if (leftNickname === "?" || rightNickname === "?") return null;
    const pair: [string, string] = [leftNickname, rightNickname];
    names.set(matchId, pair);
    return pair;
  },
};

/**
 * Every long-form video within `HORIZON_DAYS` of `nowMs`, either side, with who played it. A video
 * counts at its scheduled time, else at its upload when it is not private; a private one with no
 * time has no day (the rule `pairGapTimes` in src/youtube/publishSlot.ts uses). A match whose
 * players cannot be read is left out: no constraint, never an error.
 */
export async function recentPairPosts(nowMs: number, deps: PairPostDeps = liveDeps): Promise<PairPost[]> {
  const near = (await deps.uploads()).flatMap(({ matchId, record }) => {
    const atMs = Date.parse(
      record.publishAt ?? (record.privacyStatus !== "private" ? record.uploadedAt : ""),
    );
    // NaN (no time, or an unparseable one) fails the comparison.
    return Math.abs(nowMs - atMs) < HORIZON_DAYS * DAY_MS ? [{ matchId, atMs }] : [];
  });
  const posts = await Promise.all(
    near.map(async ({ matchId, atMs }): Promise<PairPost | null> => {
      const players = await deps.namesOf(matchId).catch(() => null);
      return players ? { players, atMs } : null;
    }),
  );
  return posts.filter((post): post is PairPost => post !== null);
}

let cached: { atMs: number; posts: PairPost[] } = { atMs: 0, posts: [] };
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
 * Rereads the records when the snapshot is older than five minutes, once at a time, and never
 * rejects. The routes that show suggestions fire and forget it, so the first request after boot
 * answers without the demotion and the next has it; the nightly awaits it.
 */
export function refreshPairPosts(nowMs: number = Date.now(), deps?: PairPostDeps): Promise<void> {
  if (inflight) return inflight;
  if (nowMs - cached.atMs < REFRESH_MS) return Promise.resolve();
  inflight = recentPairPosts(nowMs, deps)
    .then((posts) => {
      cached = { atMs: nowMs, posts };
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
