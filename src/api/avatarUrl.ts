const NMSR = "https://nmsr.nickac.dev/fullbody";

/** Which half of the frame a player stands in. */
export type AvatarSide = "left" | "right";

/**
 * How far every figure turns toward the other player, in degrees of NMSR `yaw`: positive turns
 * the render to face the right of its PNG. 25 over 20, 15 and 30 at 320 px wide (the operator's
 * ask, 24 Sept 2026: "make the players on the thumbnails slightly face towards eachother"; sheet
 * in research/thumbs-2026-09-24/avatars.md): 15 barely reads on a phone, 30 shows as much side as
 * front. Before this the default pair faced the same way — walking at -20, crossed at +20 and
 * then mirrored by the thumbnail's CSS — so both looked left.
 */
export const FACING_YAW = 25;

/**
 * The arms per pose name. NMSR has no poses, but it does take `arms` (0-180, how far the arms are
 * raised), and a distinct silhouette per variant is all the thumbnail A/B test needs. The poses
 * no longer set the yaw: every figure turns toward the other player by `FACING_YAW`, so a
 * variant differs by its arms and never by which way it faces.
 *
 * `pitch` is deliberately unused: it tilts the camera enough to crop the legs out of frame, so
 * variants stop being comparable at a glance.
 */
const POSE_CAMERAS: Record<string, number> = {
  /** Arms down: the skin as its owner sees it in the launcher. */
  default: 0,
  walking: 25,
  crossed: 10,
  cheering: 150,
  relaxing: 15,
  marching: 45,
  crouching: 5,
};

/**
 * Which render a caller got. `nmsr` means the pose was NOT honoured — the name had no camera —
 * so the A/B table must not treat it as a distinct pose. This is load-bearing for thumbnail A/B
 * testing, not bookkeeping: it is what stops a CTR comparison grouping by a variable that never
 * varied. `nmsr-facing` is a pose turned toward the other player (24 Sept 2026 on); `nmsr-posed`
 * is the same pose name from before, when the pose set the yaw and both players faced the same
 * way — a different image under the same key, which is why the A/B table keeps them apart
 * (`abTestKey`). `starlight` no longer occurs but still appears in manifests written before the
 * switch; its render route answered 404 on 24 Sept 2026, so it is not a fallback either.
 */
export type AvatarProvider = "nmsr-facing" | "nmsr-posed" | "nmsr" | "starlight";

export interface ResolvedAvatar {
  url: string;
  provider: AvatarProvider;
  /** The pose that was asked for. On the bare `nmsr` provider it was not honoured. */
  pose: string;
}

/** Poses the config may name. Exported so a bad pose can be caught before a render, not after. */
export const KNOWN_POSES = Object.keys(POSE_CAMERAS);

/**
 * The render for a player standing on `side`, turned toward the other side of the frame.
 *
 * The skin model (slim/Alex or classic/Steve arms) is NMSR's own reading of the Mojang profile's
 * `metadata.model`: on 24 Sept 2026 its render of 6 players matched the `?alex`/`?steve` render the
 * profile names, 3 slim and 3 classic, so nothing here forces either.
 *
 * Async for its callers' sake; nothing is fetched here.
 */
export async function resolveAvatarUrl(
  uuid: string,
  pose: string,
  side: AvatarSide,
): Promise<ResolvedAvatar> {
  const arms = POSE_CAMERAS[pose];
  if (arms === undefined) {
    console.error(
      `  Unknown pose "${pose}" — rendering NMSR's default view. Known: ${KNOWN_POSES.join(", ")}`,
    );
    return { url: `${NMSR}/${uuid}`, provider: "nmsr", pose };
  }
  const yaw = side === "left" ? FACING_YAW : -FACING_YAW;
  return { url: `${NMSR}/${uuid}?yaw=${yaw}&arms=${arms}`, provider: "nmsr-facing", pose };
}
