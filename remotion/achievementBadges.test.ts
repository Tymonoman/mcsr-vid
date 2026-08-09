import assert from "node:assert/strict";
import { resolveAchievementIcon } from "./achievementBadges.js";

// Known leveled id resolves to the expected filename (via staticFile, so check the suffix).
assert.ok(resolveAchievementIcon("wins", 10)!.endsWith("/achievements/w_collector_level_10.png"));

// Known flat (non-leveled) id ignores level.
assert.ok(resolveAchievementIcon("classicRun", 1)!.endsWith("/achievements/classic.png"));
assert.equal(resolveAchievementIcon("classicRun", 1), resolveAchievementIcon("classicRun", 99));

// Out-of-range level on a leveled id is unmapped, not clamped.
assert.equal(resolveAchievementIcon("wins", 0), null);
assert.equal(resolveAchievementIcon("wins", 13), null);

// Unknown id is unmapped.
assert.equal(resolveAchievementIcon("notARealAchievement", 1), null);

// Deliberately-unmapped best-effort ids (see achievementBadges.ts comment) stay null.
assert.equal(resolveAchievementIcon("playoffsResult", 1), null);
assert.equal(resolveAchievementIcon("liveResult", 1), null);

console.log("achievementBadges: all checks passed");
