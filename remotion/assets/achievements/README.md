# Achievement badges

PNG badges for MCSR Ranked achievements, rendered small next to a player's
Elo/rank line when their profile highlights that achievement
(`user.achievements.display`, see `remotion/achievementBadges.ts`).

Vendored, not hotlinked: downloaded from `github.com/MCSR-Ranked/Wiki`
(`docs/gameplay/img/achievement/*.png`). **That repo has no LICENSE file**
(default all-rights-reserved) — vendoring was a deliberate choice over
hotlinking, on the condition that the channel credits the source whenever a
badge appears on screen. Every video description that shows a badge **must**
include the line:

```
Badge art: MCSR Ranked Wiki (github.com/MCSR-Ranked/Wiki)
```

To regenerate after the Wiki adds/renames badges:

```
node scripts/fetch-achievement-badges.mjs
```

That script re-lists the Wiki repo's achievement image directory via the
GitHub API and overwrites this folder. `remotion/achievementBadges.ts` maps
API achievement `id`/`level` pairs to filenames here; if the Wiki renames a
file, update that mapping too.
