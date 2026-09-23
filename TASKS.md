# TASKS — cleanup: delete obsolete code

Branch `worktree-wf_f1d590fa-8eb-2` off main `4d1b717`. Stopped 23 Sept 2026 21:35 UTC (usage limit);
the coordinator committed the uncommitted work as WIP. `npx tsc --noEmit` passed at that moment; the
unit suite was NOT run after the last edits.

## The job (the operator's words)
"clean up our codebase. delete obsolete code." Prove each deletion dead first (reference search
across src/, remotion/, scripts/, public/, package.json scripts); never touch files the other
worktrees own (public/*, browser checks, videoPick/watchPov/generateShort/shortRender,
shortFlow/shortsRoutes/nightly, youtubeUpload, README, .github).

## DONE
- Commit `e316d32`:
```
chore: delete dead exports and the unread nightlyRenderShort key

 mcsr-vid.config.example.json   |  1 -
 remotion/Root.tsx              |  2 +-
 src/config.ts                  | 23 ++++++++---------------
 src/dashboard/server.ts        |  3 +--
 src/dashboard/syncRoutes.ts    |  2 +-
 src/playoffs/series.ts         |  1 -
 src/shorts/reasoner.test.ts    | 37 ++++++++++++++++---------------------
 src/shorts/reasoner.ts         | 26 +++-----------------------
 src/shorts/shortMoment.test.ts | 28 +++++++++++-----------------
 src/shorts/shortMoment.ts      | 12 ++++--------
 10 files changed, 45 insertions(+), 90 deletions(-)
```
- This WIP commit (thumbnail machinery deletions in progress):
```
 remotion/Thumbnail.tsx                   | 107 +++------------------------
 remotion/overlay.source.css              |  12 +--
 remotion/types.ts                        |   6 --
 src/dashboard/server.ts                  |  75 ++-----------------
 src/pipeline/pipeline.ts                 |  25 +++----
 src/thumbnails/thumbnailProps.test.ts    |  23 ------
 src/thumbnails/thumbnailProps.ts         |  13 +---
 src/thumbnails/thumbnailVariants.test.ts |  77 ++++++-------------
 src/thumbnails/thumbnailVariants.ts      | 123 +++++++------------------------
 9 files changed, 82 insertions(+), 379 deletions(-)
```

## TODO (in order)
1. `ln -s /app/node_modules node_modules`; `npx tsc --noEmit`; `npm run test:unit`; fix anything the
   half-finished thumbnail edits broke (thumbnailProps/thumbnailVariants + their tests, pipeline.ts,
   server.ts were mid-edit).
2. Continue the list: config keys nothing reads (+ settings fields, then `npm run config:example`);
   package.json deps nothing imports and scripts pointing at deleted files; browser checks/fixtures
   for retired UI (coordinate with the UI worktree); committed junk (`git ls-files` by size);
   duplicated helpers; stale lines in CLAUDE.md / handbook/ (CLAUDE.md's Shorts section is current).
3. Keep a table of every removal + the search that proved it dead (for the commit message).
4. Rebase onto main (it moved: 72075b2, 90ad8a7, 4d1b717, 3ae5afa, 07d3931), merge.
