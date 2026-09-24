import { config } from "../config.js";
import { resolveAvatarUrl } from "../api/avatarUrl.js";
import { playoffContextFor, playoffEloFor, playoffIntroLabel } from "../playoffs/playoffs.js";
import { chooseTeaser } from "./teaser.js";
import { chooseMoves } from "./explainMoves.js";
import type { MatchInfo, StatisticCategoryMap, UserDetails, VersusStats } from "../api/types.js";
// PlayerIdentity/SplitRow/OverlayProps are defined once in remotion/types.ts (the component's
// prop contract) and reused here, since computeOverlayProps's output crosses into Remotion via
// an untyped `inputProps` JSON boundary — a hand-kept-in-sync second copy could silently drift.
import type {
  PlayerIdentity,
  SplitRow,
  StatsScope,
  OverlayProps as RemotionOverlayProps,
} from "../../remotion/types.js";

export type { SplitRow };
export type OverlayProps = Omit<RemotionOverlayProps, "durationInFrames" | "fps">;

// What the overlay puts on screen: a deliberate subset of the milestones matchScore.ts scores.
// "Bastion" here is arrival (`nether.find_bastion`) and only arrival — the scorer additionally
// tracks `nether.loot_bastion`, under distinct labels so the two lists can't drift into meaning
// different things under the same word again.
const SPLIT_EVENTS: { label: string; type: string }[] = [
  { label: "Nether Enter", type: "story.enter_the_nether" },
  { label: "Bastion", type: "nether.find_bastion" },
  { label: "Fortress", type: "nether.find_fortress" },
  { label: "Blind", type: "projectelo.timeline.blind_travel" },
  { label: "End Enter", type: "story.enter_the_end" },
];

function countryFlag(countryCode: string | null): string {
  if (!countryCode || countryCode.length !== 2) return "🏳️";
  const codePoints = [...countryCode.toUpperCase()].map((c) => 0x1f1e6 - 65 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

/** One energetic, one calm — mirrors the thumbnail generator's pose convention. Override via config. */
const LEFT_POSE = config.leftPose;
const RIGHT_POSE = config.rightPose;

/**
 * Career totals average a top runner's whole climb and read as wrong next to current form. Use
 * the live season bucket, and fall back to career only right after a season rollover, when the
 * season bucket is still empty. Either way the overlay says which.
 */
export function pickStats(user: UserDetails): { stats: StatisticCategoryMap; scope: StatsScope } {
  const season = user.statistics.season;
  if (season && (season.playedMatches?.ranked ?? 0) > 0) return { stats: season, scope: "SEASON" };
  return { stats: user.statistics.total, scope: "CAREER" };
}

/**
 * `user.eloRate` is the player's rating *now*, which diverges from the match's within days at the
 * top and goes null outright at a season rollover. The match record carries each player's
 * post-match rating plus the delta that produced it, so the rating carried in is exact.
 *
 * A playoff game has no `changes` at all (a private room), and its live rating is the new
 * season's; the bracket's frozen season-end rating is what the broadcast shows, so it wins when
 * `playoffContextFor` has resolved the game (the pipeline does so first thing).
 */
export function eloAtMatchStart(match: MatchInfo, uuid: string, liveElo: number | null): number {
  const change = match.changes.find((c) => c.uuid === uuid);
  if (change?.eloRate == null) return playoffEloFor(match.id, uuid) ?? liveElo ?? 0;
  return change.eloRate - (change.change ?? 0);
}

function playerIdentity(
  user: UserDetails,
  eloRate: number,
  avatarUrl: string,
  headUrl: string,
): PlayerIdentity {
  const { stats, scope } = pickStats(user);
  const completions = stats.completions?.ranked ?? 0;
  const completionTime = stats.completionTime?.ranked ?? 0;
  const wins = stats.wins?.ranked ?? 0;
  const loses = stats.loses?.ranked ?? 0;
  const matches = stats.playedMatches?.ranked ?? 0;
  const forfeits = stats.forfeits?.ranked ?? 0;

  return {
    nickname: user.nickname,
    countryFlag: countryFlag(user.country),
    eloRate,
    // No historical rank exists in the API, so this one stays render-time. null renders as no
    // rank chip at all rather than a bogus "#0 WORLD" (which is what a season rollover yields).
    eloRank: user.eloRank,
    statsScope: scope,
    // PB stays lifetime even when the rest is season-scoped: in speedrunning "PB" means the
    // best you have ever done.
    pbMs: user.statistics.total.bestTime?.ranked ?? 0,
    avgMs: completions > 0 ? completionTime / completions : 0,
    gamesPlayed: matches,
    winRatePct: wins + loses > 0 ? (wins / (wins + loses)) * 100 : 0,
    forfeitRatePct: matches > 0 ? (forfeits / matches) * 100 : 0,
    avatarUrl,
    headUrl,
    // API already caps `display` at the player's chosen highlights (up to 3 by default);
    // slice defensively so a higher-tier supporter's 4-5 doesn't overflow the overlay.
    achievements: user.achievements.display.slice(0, 3).map((a) => ({ id: a.id, level: a.level })),
  };
}

/**
 * Pure, network-free split computation, factored out of `computeOverlayProps` for callers that
 * only need split timings (e.g. placing Kdenlive markers).
 */
export function computeSplits(match: MatchInfo, leftUuid: string, rightUuid: string): SplitRow[] {
  const eventsByPlayer = new Map<string, Map<string, number>>();
  for (const t of match.timelines) {
    if (!eventsByPlayer.has(t.uuid)) eventsByPlayer.set(t.uuid, new Map());
    const events = eventsByPlayer.get(t.uuid)!;
    // A type can repeat (a second blind travel, say); the first time the milestone was reached
    // is the split, matching matchScore.ts's earliestByType. The API happens to return entries
    // newest-first, so plain "last write wins" lands on the earliest by accident — don't rely
    // on that ordering.
    const seen = events.get(t.type);
    if (seen === undefined || t.time < seen) events.set(t.type, t.time);
  }

  const leftEvents = eventsByPlayer.get(leftUuid) ?? new Map();
  const rightEvents = eventsByPlayer.get(rightUuid) ?? new Map();

  return SPLIT_EVENTS.map(({ label, type }) => ({
    label,
    leftMs: leftEvents.get(type) ?? null,
    rightMs: rightEvents.get(type) ?? null,
  }));
}

/**
 * The first-minute "COMING UP" line, as an object to spread into the props: empty when it is
 * switched off (`teaserAtSec: null`) or nothing in this match qualifies. A series game is its own
 * match here, so its teaser never points past its own decision.
 */
export function teaserProp(match: MatchInfo): Pick<OverlayProps, "teaser"> {
  if (config.teaserAtSec === null) return {};
  const t = chooseTeaser(match);
  return t ? { teaser: { atSec: config.teaserAtSec, forSec: config.teaserSec, ...t } } : {};
}

/** The "explain the moves" cards, to spread into the props: empty while `explainMovesSec` is null. */
export function explainMovesProp(match: MatchInfo): Pick<OverlayProps, "explainMoves"> {
  return config.explainMovesSec === null
    ? {}
    : { explainMoves: { forSec: config.explainMovesSec, moves: chooseMoves(match) } };
}

/** Builds the Remotion overlay props from real API data for one match. */
export async function computeOverlayProps(
  match: MatchInfo,
  userLeft: UserDetails,
  userRight: UserDetails,
  versus: VersusStats,
): Promise<OverlayProps> {
  const leftUuid = userLeft.uuid;
  const rightUuid = userRight.uuid;
  const splits = computeSplits(match, leftUuid, rightUuid);
  // Before the elo reads below: they answer from the context this resolves.
  const playoff = await playoffContextFor(match);

  const matchPlayedLabel = new Date(match.date * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  // Only the URL matters here: the overlay renders one fixed pose pair, so unlike the thumbnail
  // it has no A/B reason to care which host actually served it.
  const [leftAvatar, rightAvatar] = await Promise.all([
    resolveAvatarUrl(userLeft.uuid, LEFT_POSE),
    resolveAvatarUrl(userRight.uuid, RIGHT_POSE),
  ]);
  const leftAvatarUrl = leftAvatar.url;
  const rightAvatarUrl = rightAvatar.url;

  // The band reads the bracket's order, not the ladder's: the seed in the rank's place, and the
  // series dots at the score this game started on (the after-the-run still fills the winner's,
  // see overlayRender.ts). `score` is in the slot's seed order, which need not be the room's.
  const seedOf = (uuid: string) => playoff?.seeds.find((s) => s.uuid === uuid);
  const series = playoff && {
    firstTo: playoff.firstTo,
    leftWins: playoff.score[playoff.seeds[0].uuid === leftUuid ? 0 : 1],
    rightWins: playoff.score[playoff.seeds[0].uuid === rightUuid ? 0 : 1],
  };
  const withSeed = (identity: PlayerIdentity, uuid: string): PlayerIdentity => {
    const seed = seedOf(uuid);
    return seed ? { ...identity, seed: seed.label } : identity;
  };

  return {
    left: withSeed(
      playerIdentity(
        userLeft,
        eloAtMatchStart(match, leftUuid, userLeft.eloRate),
        leftAvatarUrl,
        `https://nmsr.nickac.dev/head/${leftUuid}`,
      ),
      leftUuid,
    ),
    right: withSeed(
      playerIdentity(
        userRight,
        eloAtMatchStart(match, rightUuid, userRight.eloRate),
        rightAvatarUrl,
        `https://nmsr.nickac.dev/head/${rightUuid}`,
      ),
      rightUuid,
    ),
    matchPlayedLabel,
    ...(playoff ? { playoffLabel: playoffIntroLabel(playoff) } : {}),
    ...(series ? { series } : {}),
    h2hLeftWins: versus.results.ranked[leftUuid] ?? 0,
    h2hRightWins: versus.results.ranked[rightUuid] ?? 0,
    splits,
    timerStartFrame: 0,
    runResultMs: match.result.time > 0 ? match.result.time : null,
    postRollCta: config.postRollCta,
    ...(config.midRollCtaAtSec !== null
      ? { midRollCta: { atSec: config.midRollCtaAtSec, forSec: config.midRollCtaSec } }
      : {}),
    ...teaserProp(match),
    ...explainMovesProp(match),
    seedType: match.seedType,
    bastionType: match.bastionType,
  };
}
