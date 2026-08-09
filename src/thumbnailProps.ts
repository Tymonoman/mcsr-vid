import type { MatchInfo, UserDetails } from "./types.js";

export interface ThumbnailPlayer {
  nickname: string;
  eloRate: number;
  avatarUrl: string;
}

export interface ThumbnailProps {
  left: ThumbnailPlayer;
  right: ThumbnailPlayer;
  headerLabel: string;
}

/** One energetic, one calm — mirrors the reference thumbnail layout. Override per-video if needed. */
const LEFT_POSE = "walking";
const RIGHT_POSE = "crossed";

const REACHABILITY_TIMEOUT_MS = 4000;

/**
 * Starlight Skins renders any named pose but is a small free service that's occasionally down;
 * NMSR has no pose support but is reliably up. Probe the pose render and fall back so the
 * pipeline never blocks a whole video on a flaky third-party image host.
 */
export async function resolveAvatarUrl(uuid: string, pose: string): Promise<string> {
  const poseUrl = `https://starlightskins.lunareclipse.studio/render/${pose}/${uuid}/full`;
  try {
    const res = await fetch(poseUrl, { signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS) });
    if (res.ok) return poseUrl;
  } catch {
    // fall through to the static fallback below
  }
  console.error(`  Starlight Skins unavailable for ${uuid}, falling back to a static pose.`);
  return `https://nmsr.nickac.dev/fullbody/${uuid}`;
}

/** Builds Thumbnail composition props from real API data for one match. */
export async function computeThumbnailProps(
  match: MatchInfo,
  userLeft: UserDetails,
  userRight: UserDetails,
): Promise<ThumbnailProps> {
  const [leftAvatarUrl, rightAvatarUrl] = await Promise.all([
    resolveAvatarUrl(userLeft.uuid, LEFT_POSE),
    resolveAvatarUrl(userRight.uuid, RIGHT_POSE),
  ]);

  return {
    left: { nickname: userLeft.nickname, eloRate: userLeft.eloRate ?? 0, avatarUrl: leftAvatarUrl },
    right: { nickname: userRight.nickname, eloRate: userRight.eloRate ?? 0, avatarUrl: rightAvatarUrl },
    headerLabel: match.tag ?? "Minecraft · Speedrunning · Ranked",
  };
}
