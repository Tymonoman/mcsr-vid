/**
 * The three lines a suggestion card shows, assembled here rather than in public/app.js.
 *
 * The operator decides "will this get clicked" in about twenty seconds on a phone, and that
 * decision is who is playing, what is at stake, and how long the VODs have left — not a score.
 * The wording lives server-side because it is the part with rules (omit what is unknown, say
 * "won by" not "Δ", float an expiring match to the top) and rules want a test.
 */
import { formatShortTime } from "../../remotion/format.js";
import { config } from "../config.js";
import { pairKey, recentPairPostsSnapshot, type PairPost } from "./pairPosts.js";
import { rivalMatchFor, rivalPostsSnapshot, type RivalPost } from "./rivalPosts.js";
import type { SplitGap } from "../pipeline/matchScore.js";
import {
  POOL_MAX_AGE_DAYS,
  type Bucket,
  type HeadToHead,
  type Suggestion,
  type SuggestionPlayer,
} from "./suggest.js";

/** A VOD this close to aging out is the one thing that reorders the list. */
const EXPIRY_WARN_DAYS = 2;

export interface SuggestionCard {
  matchId: number;
  bucket: Bucket;
  players: [string, string];
  /** Who these two are. Null when nothing at all is known about them. */
  story: string | null;
  /** What happened, in words. */
  facts: string;
  /** Whole days of Twitch VOD life left, floored at 0. */
  expiresInDays: number;
  expiring: boolean;
  expiryLabel: string;
  /** Ranking signal, kept for the caller's own ordering; not shown on the card. */
  popularity: number;
  splits: SplitGap[];
  vodUrls: string[];
  /** The rival channel's post of this matchup, when it has one (src/dashboard/rivalPosts.ts). */
  rivalPosted: { daysAgo: number; title: string } | null;
}

/** Follower counts are read at a glance, so they round: 8143 -> 8.1k, 84_312 -> 84k. */
const followerLabel = (n: number): string =>
  n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1_000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/**
 * `#4 vs #11 · 2130 v 1980 elo · rematch 2-1 · 8.1k + 2.3k followers`, minus any part whose
 * data is missing. Pairwise parts need both sides: "#4 vs #null" is worse than silence.
 */
export function storyLine(
  profiles: readonly [SuggestionPlayer, SuggestionPlayer],
  h2h: HeadToHead | null,
): string | null {
  const [a, b] = profiles;
  const parts: string[] = [];

  if (a.eloRank !== null && b.eloRank !== null) parts.push(`#${a.eloRank} vs #${b.eloRank}`);
  if (a.elo !== null && b.elo !== null) parts.push(`${a.elo} v ${b.elo} elo`);
  // 0-0 means they have never met in ranked, which is not a rivalry worth a line.
  if (h2h && h2h.leftWins + h2h.rightWins > 0) parts.push(`rematch ${h2h.leftWins}–${h2h.rightWins}`);

  const known = [a, b].filter((p) => p.followers !== null);
  if (known.length === 2) {
    parts.push(`${followerLabel(a.followers!)} + ${followerLabel(b.followers!)} followers`);
  } else if (known.length === 1) {
    // Naming whose it is, because one bare number next to two names is ambiguous.
    parts.push(`${known[0]!.nickname} ${followerLabel(known[0]!.followers!)} followers`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

/** `8:16 · won by 0.2s · 4 lead changes · 3 deaths`. Words, not glyphs. */
export function factsLine(s: Suggestion): string {
  const m = s.metrics;
  // DNF: the loser usually stops once the winner is done, so there is no gap to report.
  // A tilde marks a margin derived from `end.kill_dragon` rather than the death animation.
  const margin =
    m.finishMarginMs === null
      ? "DNF"
      : // A photo finish is the one number a CLOSE card most needs, and "0.0s" reads as a tie or
        // a data error; under a tenth of a second the margin is said in milliseconds.
        `won by ${m.finishEstimated ? "~" : ""}${m.finishMarginMs < 100 ? `${Math.round(m.finishMarginMs)}ms` : `${(m.finishMarginMs / 1000).toFixed(1)}s`}`;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [
    formatShortTime(m.resultMs),
    margin,
    plural(m.leadChanges, "lead change"),
    plural(m.deaths, "death"),
  ].join(" · ");
}

function toCard(s: Suggestion, nowMs: number, rival: readonly RivalPost[]): SuggestionCard {
  const ageDays = (nowMs / 1000 - s.dateSec) / 86_400;
  const expiresInDays = Math.max(0, Math.floor(POOL_MAX_AGE_DAYS - ageDays));
  const expiring = expiresInDays <= EXPIRY_WARN_DAYS;
  const posted = rivalMatchFor(rival, s.metrics.players, s.dateSec, s.metrics.resultMs / 1000);
  return {
    rivalPosted: posted
      ? { daysAgo: Math.max(0, Math.floor((nowMs - posted.publishedAtMs) / 86_400_000)), title: posted.title }
      : null,
    matchId: s.metrics.matchId,
    bucket: s.bucket,
    players: s.metrics.players,
    story: storyLine(s.profiles, s.h2h),
    facts: factsLine(s),
    expiresInDays,
    expiring,
    expiryLabel: expiresInDays === 0 ? "VODs expire today" : `VODs expire in ${expiresInDays}d`,
    popularity: s.popularity,
    splits: s.metrics.splits,
    vodUrls: s.vodUrls,
  };
}

/**
 * What one favourite player in a match adds to its popularity when the cards are ordered: half
 * again for one, twice for two. A multiple, not a number of points, because popularity is a sum
 * of appearance counts that keeps growing (and of `suggestFollowerWeight`·log10 followers): a
 * favourite's match passes one up to 1.5x (2x) as popular and never one clearly ahead of it, and
 * the bonus does not shrink as the counts accumulate. ponytail: a constant — make it a setting if
 * the operator wants to tune it.
 */
const FAVOURITE_BONUS = 0.5;

/**
 * What a pair the channel has just put out counts for: half (`pairRepeatDays`, src/dashboard/pairPosts.ts).
 * A multiple for the same reason as the bonus, and soft for the same one: a repeat more than twice as
 * popular as the next card still goes first. ponytail: a constant, like `FAVOURITE_BONUS`.
 */
const REPEAT_FACTOR = 0.5;

/**
 * Cards in display order: buckets stay in the order they arrive (close, then chaos), and inside
 * a bucket the biggest audience wins — popularity, counted up by `FAVOURITE_BONUS` for each of
 * `favourites` (nicknames, compared whole and ignoring case) playing — except a match whose VODs
 * are about to die, which goes to the top of its bucket because it is the only candidate that
 * stops being renderable, and except a matchup the rival channel has already posted, which goes
 * after the fresh ones: it would compete with the rival's own video for the same browse session.
 * A pair the channel itself put out lately (`posted`: within `pairRepeatDays`, either side of now)
 * counts for `REPEAT_FACTOR` of that audience — a demotion, never a skip. Both live here and not in
 * the scan's score, so a change to either setting is the next read.
 */
export function presentSuggestions(
  suggestions: readonly Suggestion[],
  nowMs: number = Date.now(),
  rival: readonly RivalPost[] = rivalPostsSnapshot(),
  favourites: readonly string[] = config.favouritePlayers,
  posted: readonly PairPost[] = recentPairPostsSnapshot(nowMs),
): SuggestionCard[] {
  const cards = suggestions.map((s) => toCard(s, nowMs, rival));
  const liked = new Set(favourites.map((name) => name.toLowerCase()));
  const repeats = new Set(posted.map((post) => pairKey(post.players)));
  const audience = (c: SuggestionCard): number =>
    c.popularity *
    (1 + FAVOURITE_BONUS * c.players.filter((p) => liked.has(p.toLowerCase())).length) *
    (repeats.has(pairKey(c.players)) ? REPEAT_FACTOR : 1);
  const buckets = [...new Set(cards.map((c) => c.bucket))];
  return buckets.flatMap((bucket) =>
    cards
      .filter((c) => c.bucket === bucket)
      .sort(
        (x, y) =>
          Number(y.expiring) - Number(x.expiring) ||
          Number(x.rivalPosted !== null) - Number(y.rivalPosted !== null) ||
          audience(y) - audience(x),
      ),
  );
}

/**
 * The suggestions themselves in the order the dashboard shows them. The nightly render picks the
 * first eligible one, so it must be the card the operator sees at the top.
 */
export function orderForDisplay(
  suggestions: readonly Suggestion[],
  nowMs: number = Date.now(),
  rival: readonly RivalPost[] = rivalPostsSnapshot(),
  favourites: readonly string[] = config.favouritePlayers,
  posted: readonly PairPost[] = recentPairPostsSnapshot(nowMs),
): Suggestion[] {
  const rank = new Map(
    presentSuggestions(suggestions, nowMs, rival, favourites, posted).map((card, i) => [card.matchId, i]),
  );
  return [...suggestions].sort(
    (a, b) => (rank.get(a.metrics.matchId) ?? Infinity) - (rank.get(b.metrics.matchId) ?? Infinity),
  );
}
