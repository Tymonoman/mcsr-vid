# TASKS — status lines, per-match log, edge-case errors (server side)

Branch `worktree-wf_d5f53274-045-2` off main `ad30046`. Stopped 23 Sept 2026 21:35 UTC (usage limit),
uncommitted work committed as WIP by the coordinator. `npx tsc --noEmit` passed at that moment; the
unit suite was NOT run after the last edits.

## The job (the operator's words)
"add status lines and error messages to the dashboard for easier debugging" and "add error messages
for every edge case you can think of". Server half: fill `ShortPlanResponse.activity`/`.log` and
`NightlyShortSummary.activity` (contract: `src/shorts/shortPlan.ts`), a per-match
`short-<id>.log.jsonl` every stage writes to, and a clear actionable message for each failure along
the pick → render → upload chain.

## DONE (in this commit — files changed)
```
 src/dashboard/nightly.test.ts      |  10 ++
 src/dashboard/nightly.ts           |  13 +-
 src/dashboard/shortFlow.test.ts    | 237 ++++++++++++++++++++++++++++-
 src/dashboard/shortFlow.ts         | 301 +++++++++++++++++++++++++++++--------
 src/dashboard/shortsRoutes.test.ts |  92 +++++++++++-
 src/dashboard/shortsRoutes.ts      |  59 +++++++-
 src/shorts/generateShort.ts        |  64 ++++++--
 src/shorts/shortRender.ts          |  27 +++-
 src/shorts/videoPick.test.ts       | 134 +++++++++++++++--
 src/shorts/videoPick.ts            | 212 ++++++++++++++++++++------
 src/shorts/watchPov.test.ts        |  84 ++++++++++-
 src/shorts/watchPov.ts             | 139 ++++++++++++++---
 src/youtube/youtubeUpload.test.ts  | 116 +++++++++++++-
 src/youtube/youtubeUpload.ts       |  86 ++++++++++-
 14 files changed, 1392 insertions(+), 182 deletions(-)
?? src/shorts/shortLog.test.ts
?? src/shorts/shortLog.ts
```
- `src/shorts/shortLog.ts` (+test): the per-match JSONL log (append, trim, read last N).
- Activity registry + log wiring started across videoPick, watchPov, generateShort, shortRender
  (progress), shortFlow, shortsRoutes, nightly, youtubeUpload — see the diff.

## TODO (in order)
1. `ln -s /app/node_modules node_modules`; `npx tsc --noEmit`; `npm run test:unit` — fix what the
   last edits broke (the agent was mid-edit on shortFlow.ts / shortsRoutes.ts at 21:33).
2. Check every placeholder is replaced: `grep -n "activity: { running: \[\], queued: \[\] }\|log: \[\]" src/dashboard/shortFlow.ts`.
3. Edge cases still to cover (each = a message saying what happened + what to do, in status.json errors
   and the log, plus a test): agy not signed in / token expired / quota / timeout / empty answer;
   every pick validation reason; /watch missing python / script / Groq 401 / 429; ffmpeg missing;
   ENOSPC; export missing or stale; POV clip or sync.json missing; MCSR API down; series not
   joined; render OOM (exit 137); YouTube token expired / quota / upload rejected / slot in the past;
   Short already uploaded; hooks changed mid-render; two saves racing; restart mid-chain; a pick
   running > 40 min.
4. Rebase onto main (main moved: 72075b2 sync fix, 90ad8a7 retention, 4d1b717 CLAUDE.md, 3ae5afa
   spoiler words, 07d3931 YPP) — expect small conflicts in videoPick.ts only if any.
5. Merge to main, then the UI (worktree wf_f1d590fa-8eb-1) reads `activity`/`log` for real.
