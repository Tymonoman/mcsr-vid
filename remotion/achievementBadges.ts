import { staticFile } from "remotion";

// Achievement id -> Wiki badge filename, worked out against a live pull of
// api.mcsrranked.com data cross-checked with github.com/MCSR-Ranked/Wiki's
// achievements.md. Files live in remotion/assets/achievements/ (vendored by
// scripts/fetch-achievement-badges.mjs); served via Config.setPublicDir in
// remotion.config.ts + staticFile() below, since these are runtime-computed
// paths (not static imports webpack could bundle at build time).

type LeveledBadge = { maxLevel: number; file: (level: number) => string };

const LEVELED: Record<string, LeveledBadge> = {
  wins: { maxLevel: 12, file: (l) => `w_collector_level_${l}.png` },
  playtime: { maxLevel: 12, file: (l) => `practice_makes_perfect_level_${l}.png` },
  highestWinStreak: { maxLevel: 8, file: (l) => `consistent_wins_level_${l}.png` },
  bestTime: { maxLevel: 12, file: (l) => `break_the_barrier_level_${l}.png` },
  playedMatches: { maxLevel: 12, file: (l) => `match_master_level_${l}.png` },
};

const FLAT: Record<string, string> = {
  oneshot: "you_only_get_one_shot.png",
  foodless: "a_limited_diet.png",
  classicRun: "classic.png",
  ironHoe: "farming_time.png",
  armorless: "gigachad.png",
  ironPickless: "it_isnt_iron_pick.png",
  netherite: "smithing_time.png",
  highLevel: "too_many_levels.png",
  egapHolder: "valuable_artifact.png",
};

// playoffsResult/seasonResult/liveResult/wcResult: matching badges exist on
// the Wiki (playoffs_1st/2nd/3rd/participant, season_placement_top_N) but no
// real API response with these ids was seen during research, so the
// level->file mapping isn't confirmed. A wrong guess ships a wrong badge on
// screen; unmapped just omits the icon. Left out on purpose.

/** Path (via staticFile) to an achievement's badge PNG, or null if id/level is unmapped —
 * callers must skip the icon on null, never render a placeholder. */
export function resolveAchievementIcon(id: string, level: number): string | null {
  const leveled = LEVELED[id];
  if (leveled) {
    if (level < 1 || level > leveled.maxLevel) return null;
    return staticFile(`achievements/${leveled.file(level)}`);
  }
  const flat = FLAT[id];
  return flat ? staticFile(`achievements/${flat}`) : null;
}
