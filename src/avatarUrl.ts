const REACHABILITY_TIMEOUT_MS = 4000;

/**
 * Which service actually rendered the avatar.
 *
 * This is load-bearing for thumbnail A/B testing, not bookkeeping. `resolveAvatarUrl` used to
 * return a bare URL, so a fallback was invisible to callers — and when Starlight Skins is down
 * (as it is at the time of writing: `/render/<pose>/<uuid>/full` returns 404 for every pose,
 * while `/skin-render/...` answers with "moved, please use /render/..." — their server pointing
 * at a route it has not mounted), *every* pose resolves to the same static NMSR render. Without
 * this field, three "different pose" variants would be three identical images, and a CTR table
 * grouped by pose would be comparing a variable that never varied.
 */
export type AvatarProvider = "starlight" | "nmsr";

export interface ResolvedAvatar {
  url: string;
  provider: AvatarProvider;
  /** The pose that was asked for. On the `nmsr` fallback it was not honoured. */
  pose: string;
}

/**
 * Starlight Skins renders a named pose but is a small free service that's occasionally down;
 * NMSR has no pose support but is reliably up. Probe the pose render and fall back so the
 * pipeline never blocks a render on a flaky third-party image host.
 */
export async function resolveAvatarUrl(uuid: string, pose: string): Promise<ResolvedAvatar> {
  const poseUrl = `https://starlightskins.lunareclipse.studio/render/${pose}/${uuid}/full`;
  try {
    const res = await fetch(poseUrl, { signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS) });
    if (res.ok) return { url: poseUrl, provider: "starlight", pose };
  } catch {
    // fall through to the static fallback below
  }
  console.error(`  Starlight Skins unavailable for ${uuid}, falling back to a static pose.`);
  return { url: `https://nmsr.nickac.dev/fullbody/${uuid}`, provider: "nmsr", pose };
}
