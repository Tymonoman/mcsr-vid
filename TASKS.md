# TASKS — resume point (updated 24 Sept 2026 08:15 UTC)

**24 Sept ~09:00 UTC: main at c74ba08, pushed, all green.** Also merged via agy (reviewed): CLAUDE.md's Dashboard section rewritten for the NOW tab (every id checked against public/); "9th seed" not "#9 seed" in the playoff paragraph and the series description (`seedOrdinal`, playoffs.ts). The runner now resumes an agy conversation after a refused command (a glob, a pipe). Rewind eval finished (`research/rewind-eval/README.md`): agy 5/15 hits vs 18% chance (p≈0.12), timeline heuristic 9/18 vs 19% (p≈0.003) — hybrid proposed to the operator, `videoPick.ts` unchanged. Loose end: ~12 playoff descriptions on disk (some live) still say "#N seed"; an already-rendered match uploads its old text until audit #4 (rebuild the generated text at upload) is built — the next code task. Rewriting live descriptions is the operator's call.

**24 Sept 08:05 UTC: main at 8049bce, pushed, all green.** Merged: the NOW tab + status lines UI (422adfb); opening a match already on the channel no longer spends a model watch (d90e2bf); and three tasks done by agy and reviewed — Shorts join no playlist (audit #5), the dead `.thumb-header.has-hook` CSS, the tip-jar line in the pinned comment (audit #8). New: `bash scripts/agy-task.sh <name> <prompt-file>` hands easy, fully specified tasks to agy in its own worktree (home `/app/.tools/agy-dev`: ECC pruned, ponytail, /watch, the Claude skills); review the diff, grep `scripts/` + `public/`, commit. Still open: `docker restart mcsr-dashboard` then `bash scripts/browser-checks/run-all.sh http://mcsr-dashboard:8080`; CLAUDE.md's Dashboard section still describes Check/Package/Publish/After, not the NOW tab; the rewind eval (running); `playoffThumbnailStyle` is documented as not wired (operator's pick); audit code fixes left: #3 explain-the-moves captions, #4 upload-time text refresh, #6 series spacing + chapter wording, #7 dashboard metrics on engaged views.


**08:15 UTC: merged to main and pushed — teaser (2af9850), status + per-match log + edge-case errors + agy title-hook proposals (12ebf7d), cleanup (cf53520), GitHub CI + README (76105ef), docs (9c25d06).** Remaining: the NOW-tab UI (workflow running; worktree wf_f688ba52-ca7-1 when it lands — merge last, then `bash scripts/browser-checks/run-all.sh http://mcsr-dashboard:8080`), the rewind eval (research/rewind-eval/), and one `docker restart mcsr-dashboard` (loads everything above; the UI then needs only a page reload). Cleanup's leftovers for the UI agent/next session: `remotion/types.ts` hookText?, `.thumb-header.has-hook` CSS, `scripts/browser-checks/rerender-check.cjs` + its run-all.sh line; wire or delete `playoffThumbnailStyle`.


**24 Sept 07:40 UTC: the audit is delivered** — https://claude.ai/artifact/Cv1yCG5WRm2b6zLrA7wGuT (text: `~/.claude/projects/-app/research/audit-2026-09-24.md`). **Teaser merged to main (`2af9850`).** GitHub CI + README done on branch `worktree-wf_447e7ec6-6f3-1` — merge AFTER status (main's shortFlow.test.ts has a date that went stale at 03:00 UTC; status fixes it). Audience research done (`research/audience-2026-09-24.md`). Still running: status (+ agy title hooks), cleanup, UI, rewind-eval.


**Second stop, 24 Sept 06:00 UTC (usage limit).** The operator: "resume at 9am polish time
(07:00 UTC). have an audit ready by 11:55am polish time (09:55 UTC)." Eight resume workflows had
run ~7 minutes each; they were stopped, so their fresh worktrees (`.claude/worktrees/wf_12aa84f2-cd7-1`,
`wf_e9201910-2c6-1`, `wf_acb0618a-b77-1`, `wf_16dc7315-38a-1`, `wf_2dfe5127-54d-1`) may hold a
few minutes of uncommitted edits on top of the merged WIP branches. **At resume:** (1) for each
of those worktrees, if `git status --short` (minus node_modules) is non-empty, commit it as WIP on
its branch; (2) launch the audit FIRST (`~/.claude/projects/-app/research/audit-2026-09-24.md`,
due 09:55 UTC), then one workflow per TASKS.md as before (status, teaser, cleanup, ui, github,
audience, rewind-eval) — prompts are in `~/.claude/projects/-app/8d7d95a1-…/workflows/scripts/resume-*.js`.
Overnight facts: the nightly rendered 13617328 and agy picked; 13549300 + 13617328 wait for hooks;
/watch still does not run in the dashboard container (cause unknown — `docker logs mcsr-dashboard | grep -i watch`).


Work stopped at the operator's usage limit mid-way through the overnight goal. Every branch below
carries its own `TASKS.md` at its root with DONE / TODO. **All four WIP branches are pushed to origin.** Main is `07d3931` + this file; the lab
dashboard runs `ad30046` (restart pending for everything after it).

## The goal (the operator, 23 Sept 22:12 Polish, verbatim)
"you're a professional YouTube channel manager thats only goal is generating revenue and hitting
the ypp goal. work until 8:00 am polish time on Thursday or until you hit the weekly usage limit.
improve our shorts pipeline. we need people to be invested into speedruning. figure ou what's our
target and build onto it. heave a /claude-youtube audit ready by 7:45. clean up our codebase.
delete obsolete code. work on our GitHub repo. work on the dashboard UI and UX. add error
messages for every edge case you can think of and declutter the dashboard out of necessary
things. review the YouTube features were not using that we should be. start by brainstorming a
lot of new ideas even those crazy ones think whether we need them and implement them if we do."
Plus: "think of other agy uses for our project"; "add status lines and error messages to the
dashboard for easier debugging"; layout B (NOW tab); Gemini 3.8 Flash; /watch in the loop;
"you can do the teaser"; Ko-fi link everywhere (done).

## Done tonight (on main, pushed)
- Short flow v2 merged: model pick (agy + /watch), hook gate, chain, contract fields — CLAUDE.md
  Shorts section is current. Lab config: `reasonerCommand` (Gemini 3.8 Flash), `watchScript`
  (`/app/.tools/watch/`), `supportUrl` (Ko-fi). First production pick ran (13549300).
- Fixes: hidden-"1" sync (`72075b2`), retention CLI (`90ad8a7`), placement spoilers (`3ae5afa`),
  YPP panel two tiers + Shorts filter (`07d3931`).
- Ko-fi: https://ko-fi.com/mcsrreplayoffs in every live description (27 videos), all 78
  description files on disk, and the channel About.
- Research (read, ranked): `~/.claude/projects/-app/research/shorts-2026-09-23/` and
  `~/.claude/jobs/8d7d95a1/tmp/night1/research/` (judge.md = the TONIGHT/NEXT WEEK/NO ranking,
  report-features.md, report-ideas.md, report-ypp.md, agy-uses.md). The job tmp is deleted with
  the job — copy `night1/research/*.md` into `~/.claude/projects/-app/research/` first thing.

## Unfinished branches (each has TASKS.md at its root)
| Branch | Worktree | Head | What |
|---|---|---|---|
| `worktree-wf_d5f53274-045-2` | `.claude/worktrees/wf_d5f53274-045-2` | `c6413e5` wip | server status lines, `short-<id>.log.jsonl`, edge-case errors (tsc ok, tests not run) |
| `worktree-wf_f1d590fa-8eb-1` | `.claude/worktrees/wf_f1d590fa-8eb-1` | `d7c210e` wip | the NOW tab UI + status lines + declutter (unverified in a browser) |
| `worktree-wf_f1d590fa-8eb-2` | `.claude/worktrees/wf_f1d590fa-8eb-2` | `9091b5a` wip | cleanup / dead code (tsc ok, tests not run) |
| `worktree-agent-ad306227e8a5ce950` | `.claude/worktrees/agent-ad306227e8a5ce950` | `dd66022` wip | first-minute "COMING UP" teaser (code in; **unit suite passes** as of 21:50 UTC; teaser-specific tests, render check, `npm run config:example` still pending) |
| — | `~/.claude/projects/-app/research/rewind-eval/` | — | rewind eval kit (proxies + bumps + eval.mts; see its TASKS.md/README) |

Not started: GitHub CI + README refresh; the audience/target research; the audit
(`/claude-youtube audit`, was due 07:45 Polish — not done); the "features we don't use" adoption
(report-features.md has the top 10); ideas beyond the judge's TONIGHT list.

## Tomorrow, in order
1. Copy the research out of the job tmp (above). Read `judge.md`.
2. Merge in this order, running `npm run test:unit` after each: status (045-2) → teaser
   (agent-ad30…) → cleanup (8eb-2) → UI (8eb-1, last: it consumes the status fields). Resolve
   rebase conflicts against main (small: videoPick/shortFlow).
3. `docker restart mcsr-dashboard` (operator). Check a real NOW tab on the phone.
4. Then the judge's remaining TONIGHT items: agy title-hook proposals (WP1), DM moments + spoiler
   guard on typed hooks (WP2), the rewind eval runs (one agy call per quota window).
5. GitHub CI + README; the audit; the operator's Studio to-dos (end screens, related-video links on
   Shorts, watermark, Ko-fi link under the banner — they said they'd add it).

## Operator decisions still open
Replace Short `9O_R3A0Gbek` ("#31 vs #14" burned in, 24 Sept 13:00 UTC); retitle `r0F15RPC0nE` /
`HZMx38dwSSE` ("WINNER vs 3rd PLACE", 24 Sept 19:00 UTC); unlist `zSon9yOTYpM` (shows the series
decider); teaser fallback when nobody's lead changed (13446429); disk cleanup (hold the 8 published
finals until the rewind eval's proxies exist); playoff thumbnail framing.

## PLAN for 24 Sept (written 06:15 UTC by the coordinator, Fable; Opus agents do the building)

### Timeline (UTC / Polish)
- **07:00 / 09:00** wake. Launch the audit workflow FIRST, then seven workflows (one per TASKS.md)
  in parallel: status, teaser, cleanup, ui, github, audience, rewind-eval. Prompts are the
  `resume-*.js` scripts (quote the operator verbatim; refusal check 10 min after launch).
- **07:15** check the journals for "I did not…" refusals; relaunch any refuser with the OPERATOR block.
- **09:30 / 11:30** audit check-in: if the agent is not done, take its partial + `data-api.json`
  and finish the report by hand. **09:55 / 11:55: audit delivered** (file + a short summary to
  the operator: scores, what changed since 22 Sept, top 5 fixes split code vs Studio).
- **As branches finish:** merge in order (below), `npm run test:unit` after each, push.
- **Restart window:** only after the operator has saved the day's hooks (two matches waiting) and
  never during the 03:00 UTC nightly. Ask them for `docker restart mcsr-dashboard` once the
  status + ui branches are on main; a second restart is not needed for client-only changes.
- **Evening:** post-merge builds (below), then a report of the day.

### Audit inputs already collected (06:12 UTC)
`~/.claude/projects/-app/research/audit-2026-09-24/data-api.json` — channel (74 subs, 33,776
views, 27 videos incl. scheduled), every video's snippet/statistics/status, 29 playlists, 1
channel section, 90-day totals (31,323 views, 46,267 min, AVD 230 s, +77/−12 subs, 338 likes,
37 comments, 12 shares) and traffic (SUBSCRIBER 23,082 · RELATED 3,637 · SHORTS 2,706 · SEARCH
777 · CHANNEL 292). Baseline: `memory/project_channel_audit_2026_09_22.md`. Also read
`research/night1/report-features.md` (top-10 features) and `report-ypp.md` (YPP math, 2027 change).
Audit format: the claude-youtube skill's audit template (4 dimensions, scores, Next Steps).

### Branches and their state (all pushed except the 24 Sept resume worktrees)
| Job | Original WIP branch (pushed) | Resume worktree (24 Sept, local) | Head | Notes |
|---|---|---|---|---|
| status | `worktree-wf_d5f53274-045-2` @ c6413e5 | `.claude/worktrees/wf_12aa84f2-cd7-1` (`worktree-wf_12aa84f2-cd7-1`) | merged + wip | continue here |
| teaser | `worktree-agent-ad306227e8a5ce950` @ dd66022 | `wf_e9201910-2c6-1` | `58a7083` feat + wip | had already committed a "feat" — nearly done |
| cleanup | `worktree-wf_f1d590fa-8eb-2` @ 9091b5a | `wf_acb0618a-b77-1` | merged + wip | |
| ui | `worktree-wf_f1d590fa-8eb-1` @ d7c210e | `wf_16dc7315-38a-1` | merged + wip | |
| github | — | `wf_2dfe5127-54d-1` | `fbf7047` wip | ci.yml draft, .gitignore; it also edited `src/dashboard/shortFlow.test.ts` (not its file — review or drop that hunk) |
Resume agents should `git merge` the *resume* worktree's branch (it already contains the original).

### Merge order and the overlap map
1. **status** → main. Files: src/shorts/{shortLog,videoPick,watchPov,generateShort,shortRender}, src/dashboard/{shortFlow,shortsRoutes,nightly}, src/youtube/youtubeUpload (+tests).
2. **teaser** → main. Overlaps with cleanup on `src/config.ts`, `remotion/types.ts`, `remotion/overlay.source.css` (teaser adds; cleanup deletes elsewhere in the same files — resolve by keeping both edits).
3. **cleanup** → main. Re-run `npm run config:example` after the merge (both branches touch DEFAULTS).
4. **ui** → main last (it consumes status's fields). Then `bash scripts/browser-checks/run-all.sh http://mcsr-dashboard:8080` after the restart.
5. **github** → main any time (isolated files) — drop its shortFlow.test.ts hunk unless it is a real fix.
Acceptance for every merge: `npx tsc --noEmit`, `npm run test:unit`, and for teaser/ui the rendered stills / screenshots read by a human-equivalent (the agent's report lists paths).

### After the merges (the judge's TONIGHT list, still open)
- WP1 agy **title-hook proposals** — **APPROVED by the operator 24 Sept 06:25 UTC ("use agy to propose the hooks based on previous ones")**; folded into the status agent's job (resume-status script): `titleHooks[3]` + `playerMoments` on the pick call, style examples = the operator's past saved hooks from uploaded matches (16 on disk; exclude spoilers), filtered by `hookProblem`, first in `suggestions.title`.
- WP2 **DM moment per player** in the publish kit (`playerMoments`, `?t=` link) + **spoiler guard on typed hooks** (`saveHooks` refuses via `hookProblem` unless `spoilerOk`).
- Adopt the features report's top items that are code: chapters as Key Moments check, Shorts related-link pill in the checklist, end-screen reminder pill; the rest are Studio steps for the operator.
- Ideas: only after the above; the judge marked most NO/NEXT WEEK.

### Operator checklist (with times)
- **Now:** save hooks for 13549300 and 13617328 (old Package panel until the NOW tab lands).
- **Before 15:00 Polish:** replace Short `9O_R3A0Gbek` (delete + upload `short-13473906.mp4`).
- **Before 21:00 Polish:** retitle `r0F15RPC0nE` ("WINNER vs 3rd PLACE") and delete/re-cut `HZMx38dwSSE`.
- `docker logs mcsr-dashboard 2>&1 | grep -i watch | tail -5` → paste (the /watch-in-container mystery).
- Studio: Ko-fi link under the banner; end screens on live long-forms; related-video link on each Short; watermark.
- Decide: teaser fallback when nobody's lead changed; disk cleanup (hold 8 finals until rewind-eval proxies exist — 2 of 8 made).

### Risks
- Agents refusing (last night: 4 of 9) → OPERATOR block verbatim in every prompt; check at +10 min.
- Two agents on one file → ownership lists in prompts; github's stray test edit shows it can still happen — review diffs at merge.
- /watch not running in the dashboard container → the status branch logs the reason to `short-<id>.log.jsonl`; tonight's nightly will show it.
- Quota: 8 Opus agents ≈ 1–1.5M tokens per hour; if the limit nears, stop and commit WIP again (the salvage loop is in this file's history).
