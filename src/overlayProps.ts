import type { MatchInfo, UserDetails, VersusStats } from "./types.js";

export interface PlayerIdentity {
  nickname: string;
  countryFlag: string;
  eloRate: number;
  eloRank: number;
  pbMs: number;
  avgMs: number;
  gamesPlayed: number;
  winRatePct: number;
}

export interface SplitRow {
  label: string;
  leftMs: number | null;
  rightMs: number | null;
}

export interface OverlayProps {
  left: PlayerIdentity;
  right: PlayerIdentity;
  matchPlayedLabel: string;
  h2hLeftWins: number;
  h2hRightWins: number;
  splits: SplitRow[];
  timerStartFrame: number;
  runResultMs: number | null;
}

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

function playerIdentity(user: UserDetails): PlayerIdentity {
  const stats = user.statistics.total;
  const completions = stats.completions.ranked ?? 0;
  const completionTime = stats.completionTime.ranked ?? 0;
  const wins = stats.wins.ranked ?? 0;
  const loses = stats.loses.ranked ?? 0;

  return {
    nickname: user.nickname,
    countryFlag: countryFlag(user.country),
    eloRate: user.eloRate ?? 0,
    eloRank: user.eloRank ?? 0,
    pbMs: stats.bestTime.ranked ?? 0,
    avgMs: completions > 0 ? completionTime / completions : 0,
    gamesPlayed: stats.playedMatches.ranked ?? 0,
    winRatePct: wins + loses > 0 ? (wins / (wins + loses)) * 100 : 0,
  };
}

/** Builds the Remotion overlay props from real API data for one match. */
export function computeOverlayProps(
  match: MatchInfo,
  userLeft: UserDetails,
  userRight: UserDetails,
  versus: VersusStats,
): OverlayProps {
  const eventsByPlayer = new Map<string, Map<string, number>>();
  for (const t of match.timelines) {
    if (!eventsByPlayer.has(t.uuid)) eventsByPlayer.set(t.uuid, new Map());
    eventsByPlayer.get(t.uuid)!.set(t.type, t.time);
  }

  const leftUuid = userLeft.uuid;
  const rightUuid = userRight.uuid;
  const leftEvents = eventsByPlayer.get(leftUuid) ?? new Map();
  const rightEvents = eventsByPlayer.get(rightUuid) ?? new Map();

  const splits: SplitRow[] = SPLIT_EVENTS.map(({ label, type }) => ({
    label,
    leftMs: leftEvents.get(type) ?? null,
    rightMs: rightEvents.get(type) ?? null,
  }));

  const matchPlayedLabel = new Date(match.date * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return {
    left: playerIdentity(userLeft),
    right: playerIdentity(userRight),
    matchPlayedLabel,
    h2hLeftWins: versus.results.ranked[leftUuid] ?? 0,
    h2hRightWins: versus.results.ranked[rightUuid] ?? 0,
    splits,
    timerStartFrame: 0,
    runResultMs: match.result.time > 0 ? match.result.time : null,
  };
}
