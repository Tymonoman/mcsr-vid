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
  drawFactorFor,
  favouriteFactorFor,
  tierFor,
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
 * What a pair the channel has just put out counts for: half (`pairRepeatDays`, src/dashboard/pairPosts.ts).
 * A multiple like the favourites' bonus, and as soft: inside its tier a repeat more than twice as
 * popular as the next card still goes first, and it never drops a favourite pair below a no-name one.
 * ponytail: a constant, like `FAVOURITE_BONUS`.
 */
const REPEAT_FACTOR = 0.5;

/** Which bucket breaks a tie: the close races, then the chaos. */
const BUCKET_RANK: Record<Bucket, number> = { close: 0, chaos: 1 };

/**
 * Cards in display order, one list across both buckets: a match whose VODs are about to die first,
 * because it is the only candidate that stops being renderable; a matchup the rival channel has
 * already posted after the fresh ones, because it would compete with the rival's own video for the
 * same browse session; and inside each of those `tierFor`: a match with a favourite (`favourites`:
 * nicknames, compared whole and ignoring case) above every match without one, then a match with a
 * known player (a measured draw or a Twitch following that clears the gate) above the no-names — no-name
 * players are not what gets clicked, and a bonus alone lost to their popularity. Inside a tier the
 * biggest audience: `popularity × favouriteFactor × drawFactor × repeatFactor` — counted up by
 * `FAVOURITE_BONUS` for each favourite playing, by the players' draw (`drawFactorFor`: the measured one,
 * else a prior from their following; 1 Oct 2026: match quality does not predict views once players
 * are controlled for, so there is no chaos/closeness term here), and down by `REPEAT_FACTOR` for a
 * pair the channel itself put out lately (`posted`: within
 * `pairRepeatDays`, either side of now). The bucket only breaks a tie (`BUCKET_RANK`: close, then
 * chaos), and popularity the one after that. The audience decides, not the bucket: the one close race
 * of no names must not stay above a famous pair's chaos, or the nightly renders the first. Everything
 * here is read on every call and kept out of the scan's cache, so a change to either setting re-orders
 * the next read. (The tier also counts when a scan chooses the slots, `take` in suggest.ts: which
 * matches are in the list follows at the next scan.)
 */
export function presentSuggestions(
  suggestions: readonly Suggestion[],
  nowMs: number = Date.now(),
  rival: readonly RivalPost[] = rivalPostsSnapshot(),
  favourites: readonly string[] = config.favouritePlayers,
  posted: readonly PairPost[] = recentPairPostsSnapshot(nowMs),
  knownFollowerThreshold: number = config.knownFollowerThreshold,
): SuggestionCard[] {
  const cards = suggestions.map((s) => toCard(s, nowMs, rival));
  const favoured = favouriteFactorFor(favourites);
  // Follower counts are already on the suggestions themselves (`profiles`, resolved at scan time);
  // no second Twitch lookup here.
  const followersByName = new Map<string, number | null>();
  for (const s of suggestions)
    for (const p of s.profiles) followersByName.set(p.nickname.toLowerCase(), p.followers);
  const followersOf = (name: string) => followersByName.get(name.toLowerCase()) ?? null;
  const tier = tierFor(favourites, followersOf, knownFollowerThreshold);
  const repeats = new Set(posted.map((post) => pairKey(post.players)));
  const audience = (c: SuggestionCard): number =>
    c.popularity *
    favoured(c.players) *
    drawFactorFor(c.players, followersOf) *
    (repeats.has(pairKey(c.players)) ? REPEAT_FACTOR : 1);
  return cards.sort(
    (x, y) =>
      Number(y.expiring) - Number(x.expiring) ||
      Number(x.rivalPosted !== null) - Number(y.rivalPosted !== null) ||
      tier(y.players) - tier(x.players) ||
      audience(y) - audience(x) ||
      BUCKET_RANK[x.bucket] - BUCKET_RANK[y.bucket] ||
      y.popularity - x.popularity,
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
  knownFollowerThreshold: number = config.knownFollowerThreshold,
): Suggestion[] {
  const rank = new Map(
    presentSuggestions(suggestions, nowMs, rival, favourites, posted, knownFollowerThreshold).map(
      (card, i) => [card.matchId, i],
    ),
  );
  return [...suggestions].sort(
    (a, b) => (rank.get(a.metrics.matchId) ?? Infinity) - (rank.get(b.metrics.matchId) ?? Infinity),
  );
}
