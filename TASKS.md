# TASKS — resume point, 23 Sept 2026 21:40 UTC

Work stopped at the operator's usage limit mid-way through the overnight goal. Every branch below
carries its own `TASKS.md` at its root with DONE / TODO. Main is `07d3931` + this file; the lab
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
| `worktree-agent-ad306227e8a5ce950` | `.claude/worktrees/agent-ad306227e8a5ce950` | `dd66022` wip | first-minute "COMING UP" teaser (code in, tests/render/config:example pending) |
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
