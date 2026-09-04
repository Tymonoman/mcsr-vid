import { config } from "./config.js";
// Same rationale as overlayProps.ts: ThumbnailPlayer/ThumbnailProps are Remotion's prop contract
// (remotion/types.ts), reused here rather than hand-duplicated, since this crosses into Remotion
// via an untyped `inputProps` JSON boundary.
import type { ThumbnailPlayer, ThumbnailProps } from "../remotion/types.js";
import { resolveAvatarUrl } from "./avatarUrl.js";
import { eloAtMatchStart } from "./overlayProps.js";
import type { MatchInfo, UserDetails } from "./types.js";

export type { ThumbnailPlayer, ThumbnailProps };
// Re-exported for thumbnailProps.test.ts, which tests this behavior in the thumbnail context.
export { resolveAvatarUrl };

/** One energetic, one calm — mirrors the reference thumbnail layout. Override via config. */
const LEFT_POSE = config.leftPose;
const RIGHT_POSE = config.rightPose;

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

  // `user.eloRate` is the rating *now*, which drifts from the rating carried into the match
  // within days at the top — see eloAtMatchStart's note in overlayProps.ts. The overlay and the
  // description already use it; the thumbnail showing a different number for the same match was
  // the same bug left unfixed here.
  return {
    left: {
      nickname: userLeft.nickname,
      eloRate: eloAtMatchStart(match, userLeft.uuid, userLeft.eloRate),
      avatarUrl: leftAvatarUrl,
    },
    right: {
      nickname: userRight.nickname,
      eloRate: eloAtMatchStart(match, userRight.uuid, userRight.eloRate),
      avatarUrl: rightAvatarUrl,
    },
    headerLabel: match.tag ?? "Minecraft · Speedrunning · Ranked",
  };
}
