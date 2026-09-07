const NMSR = "https://nmsr.nickac.dev/fullbody";

/**
 * Camera per pose name.
 *
 * Starlight Skins used to render genuinely different poses, but it has been down long enough
 * that every variant fell back to one static NMSR render — three "poses" that were three
 * identical images. NMSR has no poses, but it does take `yaw` (turn) and `arms` (0-180, how far
 * the arms are raised), and a distinct silhouette per variant is the only thing the thumbnail
 * A/B test actually needs from a pose.
 *
 * `pitch` is deliberately unused: measured, it tilts the camera enough to crop the legs out of
 * frame, so variants stop being comparable at a glance.
 */
const POSE_CAMERAS: Record<string, string> = {
  walking: "yaw=-20&arms=25",
  crossed: "yaw=20&arms=0",
  cheering: "yaw=0&arms=150",
  relaxing: "yaw=35&arms=15",
  marching: "yaw=-35&arms=45",
  crouching: "yaw=15&arms=5",
};

/**
 * Which render a caller got. `nmsr` means the pose was NOT honoured — the name had no camera —
 * so the A/B table must not treat it as a distinct pose. This is load-bearing for thumbnail A/B
 * testing, not bookkeeping: it is what stops a CTR comparison grouping by a variable that never
 * varied. `starlight` no longer occurs but still appears in manifests written before the switch.
 */
export type AvatarProvider = "nmsr-posed" | "nmsr" | "starlight";

export interface ResolvedAvatar {
  url: string;
  provider: AvatarProvider;
  /** The pose that was asked for. On the bare `nmsr` provider it was not honoured. */
  pose: string;
}

/** Poses the config may name. Exported so a bad pose can be caught before a render, not after. */
export const KNOWN_POSES = Object.keys(POSE_CAMERAS);

/**
 * Async only so the call sites that already await it do not have to change; there is no probe
 * any more, because there is nothing left to probe for.
 */
export async function resolveAvatarUrl(uuid: string, pose: string): Promise<ResolvedAvatar> {
  const camera = POSE_CAMERAS[pose];
  if (!camera) {
    console.error(
      `  Unknown pose "${pose}" — rendering NMSR's default view. Known: ${KNOWN_POSES.join(", ")}`,
    );
    return { url: `${NMSR}/${uuid}`, provider: "nmsr", pose };
  }
  return { url: `${NMSR}/${uuid}?${camera}`, provider: "nmsr-posed", pose };
}
