const REACHABILITY_TIMEOUT_MS = 4000;

/**
 * Starlight Skins renders a named pose but is a small free service that's occasionally down;
 * NMSR has no pose support but is reliably up. Probe the pose render and fall back so the
 * pipeline never blocks a render on a flaky third-party image host.
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
