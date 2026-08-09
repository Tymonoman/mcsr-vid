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
  avatarUrl: string;
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

const AVATAR_REACHABILITY_TIMEOUT_MS = 4000;

/**
 * Starlight Skins renders a named action pose but is a small free service that's occasionally
 * down; NMSR has no pose support but is reliably up. Probe the pose render and fall back so the
 * pipeline never blocks a render on a flaky third-party image host.
 */
export async function resolveAvatarUrl(uuid: string, pose: string): Promise<string> {
  const poseUrl = `https://starlightskins.lunareclipse.studio/render/${pose}/${uuid}/full`;
  try {
    const res = await fetch(poseUrl, { signal: AbortSignal.timeout(AVATAR_REACHABILITY_TIMEOUT_MS) });
    if (res.ok) return poseUrl;
  } catch {
    // fall through to the static fallback below
  }
  console.error(`  Starlight Skins unavailable for ${uuid}, falling back to a static pose.`);
  return `https://nmsr.nickac.dev/fullbody/${uuid}`;
}

function countryFlag(countryCode: string | null): string {
  if (!countryCode || countryCode.length !== 2) return "🏳️";
  const codePoints = [...countryCode.toUpperCase()].map((c) => 0x1f1e6 - 65 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

/** One energetic, one calm — mirrors the thumbnail generator's pose convention. */
const LEFT_POSE = "walking";
const RIGHT_POSE = "crossed";

function playerIdentity(user: UserDetails, avatarUrl: string): PlayerIdentity {
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
    avatarUrl,
  };
}

/**
 * Pure, network-free split computation, factored out of `computeOverlayProps` so callers that
 * only need split timings (e.g. placing Kdenlive markers) don't have to pay for that function's
 * avatar-resolution network probes.
 */
export function computeSplits(match: MatchInfo, leftUuid: string, rightUuid: string): SplitRow[] {
  const eventsByPlayer = new Map<string, Map<string, number>>();
  for (const t of match.timelines) {
    if (!eventsByPlayer.has(t.uuid)) eventsByPlayer.set(t.uuid, new Map());
    eventsByPlayer.get(t.uuid)!.set(t.type, t.time);
  }

  const leftEvents = eventsByPlayer.get(leftUuid) ?? new Map();
  const rightEvents = eventsByPlayer.get(rightUuid) ?? new Map();

  return SPLIT_EVENTS.map(({ label, type }) => ({
    label,
    leftMs: leftEvents.get(type) ?? null,
    rightMs: rightEvents.get(type) ?? null,
  }));
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

  const matchPlayedLabel = new Date(match.date * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  const [leftAvatarUrl, rightAvatarUrl] = await Promise.all([
    resolveAvatarUrl(userLeft.uuid, LEFT_POSE),
    resolveAvatarUrl(userRight.uuid, RIGHT_POSE),
  ]);

  return {
    left: playerIdentity(userLeft, leftAvatarUrl),
    right: playerIdentity(userRight, rightAvatarUrl),
    matchPlayedLabel,
    h2hLeftWins: versus.results.ranked[leftUuid] ?? 0,
    h2hRightWins: versus.results.ranked[rightUuid] ?? 0,
    splits,
    timerStartFrame: 0,
    runResultMs: match.result.time > 0 ? match.result.time : null,
  };
}
