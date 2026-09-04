import { config } from "./config.js";
// Same rationale as overlayProps.ts: ThumbnailPlayer/ThumbnailProps are Remotion's prop contract
// (remotion/types.ts), reused here rather than hand-duplicated, since this crosses into Remotion
// via an untyped `inputProps` JSON boundary.
import type { ThumbnailPlayer, ThumbnailProps } from "../remotion/types.js";
import { resolveAvatarUrl, type ResolvedAvatar } from "./avatarUrl.js";
import type { MatchInfo, UserDetails } from "./types.js";

export type { ThumbnailPlayer, ThumbnailProps };
// Re-exported for thumbnailProps.test.ts, which tests this behavior in the thumbnail context.
export { resolveAvatarUrl };

/** One energetic, one calm — mirrors the reference thumbnail layout. Override via config. */
export interface PosePair {
  left: string;
  right: string;
}

export const DEFAULT_POSES: PosePair = { left: config.leftPose, right: config.rightPose };

/**
 * Props plus what the avatar hosts actually served. A/B testing needs to know whether the pose
 * it asked for was honoured, so the caller can record `nmsr` (no pose support) rather than
 * filing an identical fallback render under three different pose names.
 */
export interface ComputedThumbnail {
  props: ThumbnailProps;
  leftAvatar: ResolvedAvatar;
  rightAvatar: ResolvedAvatar;
}

/**
 * Builds Thumbnail composition props from real API data for one match.
 *
 * The pose pair is an argument rather than the module-level constant it used to be: rendering
 * several variants of one match means varying it per call, and mutating `config` to do that
 * would leak across the concurrent overlay render that reads the same fields.
 */
export async function computeThumbnailProps(
  match: MatchInfo,
  userLeft: UserDetails,
  userRight: UserDetails,
  poses: PosePair = DEFAULT_POSES,
): Promise<ComputedThumbnail> {
  const [leftAvatar, rightAvatar] = await Promise.all([
    resolveAvatarUrl(userLeft.uuid, poses.left),
    resolveAvatarUrl(userRight.uuid, poses.right),
  ]);

  return {
    props: {
      left: { nickname: userLeft.nickname, eloRate: userLeft.eloRate ?? 0, avatarUrl: leftAvatar.url },
      right: { nickname: userRight.nickname, eloRate: userRight.eloRate ?? 0, avatarUrl: rightAvatar.url },
      headerLabel: match.tag ?? "Minecraft · Speedrunning · Ranked",
    },
    leftAvatar,
    rightAvatar,
  };
}
