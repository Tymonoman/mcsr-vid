# TASKS — the dashboard UI: NOW tab, status lines, declutter

Branch `worktree-wf_f1d590fa-8eb-1` off main `4d1b717`. Stopped 23 Sept 2026 21:35 UTC (usage limit);
the coordinator committed the uncommitted work as WIP. Nothing here was verified in a browser.

## The job (the operator's words)
"work on the dashboard UI and UX. add error messages for every edge case you can think of and
declutter the dashboard out of necessary things"; "add status lines and error messages to the
dashboard for easier debugging"; layout chosen: **Option B, the NOW tab** — spec in
`~/.claude/projects/-app/research/shorts-2026-09-23/report-layout.md`.

## DONE
- Commit `6ad9115`: the earlier UI builder's partial patch applied (public/app.css, app.js,
  index.html, panels.css, youtube.js; + scripts/browser-checks/now-flow-check.cjs).
- This WIP commit: further edits on top —
```
 public/app.css    |   11 +
 public/app.js     | 1097 ++++++++++++++++++++++++++++++++++++++---------------
 public/index.html |    4 +-
 public/panels.css |  102 ++++-
 public/youtube.js |   34 +-
 5 files changed, 930 insertions(+), 318 deletions(-)
```

## TODO (in order)
1. `ln -s /app/node_modules node_modules`. Read `src/dashboard/shortsRoutes.ts`, `shortFlow.ts`,
   `server.ts` on main for the real route shapes (GET /api/shorts/plan/:id, PUT /api/shorts/hooks/:id
   with SaveHooksRequest, POST /api/shorts/pick/:id; rows carry shortState/shortDetail; /api/nightly
   carries waitingForHook/failed/picker/activity). /api/shorts/moments and render {pick} are gone.
2. Finish the NOW tab per Option B: steps Video · Pick · Hooks · Short · Video up · Short up; the
   open step is the one needing the operator or failed; errors in the step's row with the fix;
   one "Save hooks and schedule" button (phone bottom slot); "N more waiting ›"; hooks lock after
   upload; every match opens on NOW; After group removed, Manage fold to the bottom of Publish.
3. Status lines: activity line + elapsed ticking from activity.since + progress bar; Details fold
   per step from ShortPlanResponse.log with Copy (copyText, no Clipboard API on the lab); nightly
   strip Activity line; inline "dashboard unreachable — retrying" on failed polls.
4. Declutter: delete the old Short panel's moments list, "Cut this", burns-in line, mismatch
   warning, Short duplicates in Publish, hooked-thumbnail leftovers.
5. Verify in Playwright (scripts/browser-checks/launch.cjs) at 390x844 and 1440x900 against a stub
   server with every state; update the browser checks that pinned retired controls; finish
   now-flow-check.cjs. Rebase onto main, merge, `docker restart mcsr-dashboard` (client files are
   served from disk, but the server changes need the restart).
