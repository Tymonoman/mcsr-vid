import { config } from "./config.js";
// Same rationale as overlayProps.ts: ThumbnailProps is Remotion's prop contract
// (remotion/types.ts), reused here rather than hand-duplicated, since this crosses into Remotion
// via an untyped `inputProps` JSON boundary.
import type { ThumbnailProps } from "../remotion/types.js";
import { resolveAvatarUrl, type ResolvedAvatar } from "./avatarUrl.js";
import { eloAtMatchStart } from "./overlayProps.js";
import type { MatchInfo, UserDetails } from "./types.js";

/** One energetic, one calm — mirrors the reference thumbnail layout. Override via config. */
export interface PosePair {
  left: string;
  right: string;
  /**
   * `false` renders this variant without the headline — the text-free control in the A/B set.
   * Optional and defaulting to "with hook" because every pair predating it carried one.
   */
  hook?: boolean;
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
 *
 * `hookText` is the headline the thumbnail is sold on — the same rivalry line the title carries.
 * Optional because the pipeline renders thumbnails before anyone has picked one, and because
 * every already-published match must keep rendering the header strip it was published with.
 */
export async function computeThumbnailProps(
  match: MatchInfo,
  userLeft: UserDetails,
  userRight: UserDetails,
  poses: PosePair = DEFAULT_POSES,
  hookText?: string,
): Promise<ComputedThumbnail> {
  const [leftAvatar, rightAvatar] = await Promise.all([
    resolveAvatarUrl(userLeft.uuid, poses.left),
    resolveAvatarUrl(userRight.uuid, poses.right),
  ]);

  // `user.eloRate` is the rating *now*, which drifts from the rating carried into the match
  // within days at the top — see eloAtMatchStart's note in overlayProps.ts. The overlay and the
  // description already use it; the thumbnail showing a different number for the same match was
  // the same bug left unfixed here.
  return {
    props: {
      left: {
        nickname: userLeft.nickname,
        eloRate: eloAtMatchStart(match, userLeft.uuid, userLeft.eloRate),
        avatarUrl: leftAvatar.url,
      },
      right: {
        nickname: userRight.nickname,
        eloRate: eloAtMatchStart(match, userRight.uuid, userRight.eloRate),
        avatarUrl: rightAvatar.url,
      },
      headerLabel: match.tag ?? "Minecraft · Speedrunning · Ranked",
      // Omitted rather than set to undefined when there is no hook: the props go through a JSON
      // boundary into Remotion, and a thumbnail rendered without one has to be the same image it
      // was before hooks existed.
      ...(hookText?.trim() ? { hookText } : {}),
    },
    leftAvatar,
    rightAvatar,
  };
}
