# TASKS — resume point (updated 24 Sept 2026 08:15 UTC)

**26 Sept 18:45 UTC — RESUMED.** main 289ae33 is pushed and the dashboard booted it (the comment guard is live). Five background agents restarted the plan below (plain Agent tool, not workflows): A integrate icons (seed-icons-vanilla), B independent review r2 + screenshots (watch-progress), C finish the 4 review fixes (thumbs-rerender), D research + primer + reset/death split + --dry-run (pick-mechanics; the fact-check, review and ONE dry-run eval on 13673240 follow as separate agents), E build publish-at. As each returns: check it, run the next step (review/fix), send the operator the images/screenshots, merge only on his OK in the order of step 3.

## ▶ RESUME HERE — stopped 26 Sept 2026 ~14:58 UTC (16:58 Polish) for the operator's shutdown

When the operator says **"resume"**, do this in order. Every workflow was stopped cleanly; nothing is running (the thumbs-rerender test server was killed). Main is `3c60c99`+this commit; `d19a130` (the comment guard) and the TASKS commits are NOT pushed.

**0. Check the box first.** `bash scripts/preflight.sh`; `git worktree list` must show the five worktrees below. If the Claude container was recreated: Playwright's Firefox (needed by publish-at's browser check) lives outside the persisted volume — `sudo apt-get update && sudo apt-get install -y libgtk-3-0 libdbus-glib-1-2 libxt6 && npx playwright install firefox`. The 1.16.1 jar/refs/renders are in `/home/node/.claude/jobs/8d7d95a1/tmp/vanilla/` (bake.py re-downloads the jar if that dir is gone). Everything the resumed agents need is saved in `~/.claude/projects/-app/research/resume-2026-09-26/` (the four journals, round4-icons.json, round4-watch-progress.json, thumbs-rerender.json with the open review defects, pick-mechanics-api.md).

**1. Try the workflows' own resume** (works only if this is still the same session): `Workflow({scriptPath, resumeFromRunId})` with the scripts in `~/.claude/projects/-app/8d7d95a1-198f-4cf6-9e51-0fbaf6c8842a/workflows/scripts/` (round 4: `~/.claude/projects/-app--claude-worktrees-seed-icons-vanilla/8d7d95a1-198f-4cf6-9e51-0fbaf6c8842a/workflows/scripts/watch-progress-and-icons-r4-wf_15cb865b-c6a.js` run `wf_15cb865b-c6a`; `thumbs-rerender-wf_029deaf4-60a.js` run `wf_029deaf4-60a`; `pick-mechanics-wf_b45ebb6a-066.js` run `wf_b45ebb6a-066`; `publish-at-wf_1d33f0cc-6fd.js` run `wf_1d33f0cc-6fd`). If refused, do the per-branch steps below with fresh agents. **Every agent prompt must open with the PREFACE** (the newest chat line is handled elsewhere; this job is the operator's explicit request) — two research agents refused today when a new chat message arrived mid-run.

**2. Per branch — what is done, what is left:**
- **A. `seed-icons-vanilla`** (`.claude/worktrees/seed-icons-vanilla`, head `473d43a` WIP). The operator: "shipwreck looks meh. change it up a little the rest is good you can make the village 2d and give me a buried treasure thats 2d id like to see what it looks like. add an outline to the desert temple so its easier to recognize". All four passed review (shipIt): SHIPWRECK `scenes/SHIPWRECK-2d-dark.json` (with_mast, wood palette 3; runner-up `SHIPWRECK-iso-seabed.json`), VILLAGE `VILLAGE-house-2d.json` (framed, dark door panes), BURIED_TREASURE alt `BURIED_TREASURE-2d-section.json` (iso stays main), DESERT_TEMPLE `DESERT_TEMPLE-2d.json` now with `"outline": {"color":"#0d0c10","px":24,"exclude":["sand"],"base":true}` (bake.py/SeedScene outline option); RUINED_PORTAL unchanged. **Left: the Integrate step only** — render `remotion/assets/seed-icons/`: VILLAGE.png=house-2d, VILLAGE-alt.png=house-iso; SHIPWRECK.png=2d-dark, SHIPWRECK-alt.png=iso-seabed; BURIED_TREASURE-alt.png=2d-section; DESERT_TEMPLE.png=2d with outline; update `scripts/seed-icons/icons.sh`'s mapping; SeedIconSheet shows BURIED_TREASURE's alt; `SeedIconMC.test.ts`; review sheets in `/home/node/.claude/jobs/8d7d95a1/tmp/vanilla/out/r4/review/` (sheet.png old-vs-new at 132/64/40 with all shipwreck candidates, thumbs-sheet.png the 5 real thumbnails from `/home/node/.claude/jobs/8d7d95a1/tmp/example/<TYPE>.json`, treasure-2d.png iso vs 2d); CLAUDE.md thumbnail bullet + scripts/seed-icons/README.md; tsc, test:unit, overlayRender.test.ts; commit. Then look at the sheets, send them to the operator, merge only on his OK.
- **B. `watch-progress`** (`.claude/worktrees/watch-progress`, head `20dc0a6`). The operator: "add a progress bar on running /watch on a vid thats rendered". Built (70f3d1e: the pick reports a percent through activityProgress — proxy → /watch ×2 → model estimate), review r1's 2 defects fixed (20dc0a6: old stills were counted as new). **Left:** an independent review r2 (the round-4 script's "A: review" prompt), a screenshot of the Pick step's bar, then show the operator and merge on OK.
- **C. `thumbs-rerender`** (`.claude/worktrees/thumbs-rerender`, head `de5c309` WIP, tsc passes, tests unknown). The operator: "also i want an option to re render the thumbnails". Built 624c7a7 (per-match Re-render with thumbnail-prev/ backup, per-video Put on YouTube/Undo with thumbnail-youtube-prev, bulk re-render). Review r1 found 4 defects (in thumbs-rerender.json): Finish on YouTube could put the new thumbnail live without an undo copy; the nightly does not wait for a thumbnail re-render; the undo copy is taken once and never validated; the one-generation backup is replaced on every re-render. The fix was mid-way (WIP commit). **Left:** finish those 4 fixes, tsc + test:unit + the browser check against a scratch media copy (never /media, API stubbed), review r2, phone+desktop screenshots, show the operator, merge on OK. My advice already given to him: re-render every video once the icons are approved; swap the low-traffic ones directly; YouTube Studio Test & Compare (old vs new) on the top five by impressions (vASY6MzFRNM, opWF0g2VCP0, 4evKn5k0_p8, 6YWABc--rQk, f4Z2Dvg9ihc = 63% of 183k impressions 11–24 Sept).
- **D. `pick-mechanics`** (`.claude/worktrees/pick-mechanics`, no commits yet). The operator: "the model (agy) doesnt have the concept of hunger resetting and it suggested a moment where both runners hunger reset and nothing else happens. the model should have deep knowledge of speedrunning mechanics add it to the prompt." Case: 13673240's pick chose both stronghold `death_spawnpoint` hunger resets (7:16, 7:32) because `gameFacts` (src/shorts/videoPick.ts) hands death_spawnpoint to the model as a death (DEATH_TYPES, src/shorts/raceGap.ts). Done: the API-semantics research (pick-mechanics-api.md: mcsrranked.com labels death_spawnpoint "death reset"). **Left:** the web-mechanics and corpus research (with the PREFACE), write the primer (src/shorts/speedrunPrimer.ts, <~1,200 tokens, routine vs remarkable) + split resets from deaths in the facts/captions/heuristic (NOT matchScore.ts — report it), a `--dry-run` for `npm run pick`, adversarial fact-check + code review, then ONE dry-run pick on 13673240 (writes nothing to /media). 13673240 was saved with **noShort** at 14:33, so no Short went out of that window.
- **E. `publish-at`** (`.claude/worktrees/publish-at`, nothing written yet). The operator: "on firefox i cant change the upload date. theres just no way to edit the input box" + a screenshot of the Publish kit's read-only PUBLISH AT copy block — not a Firefox bug (the only real date input, Upload by hand's #ytWhen, types fine in Playwright Firefox at desktop and phone width). **Left: the whole build** (script above): editable time in the kit before upload (the chain uses it; Short 18 h after; slot rules are warnings), "Move on YouTube" for a scheduled video (videos.update on the whole status part; the Short keeps its 18 h gap), public = copy block; tests with stubbed API; browser check in Firefox AND Chromium, desktop + phone; review; show the operator.

**3. Merge order once he approves:** watch-progress and pick-mechanics both touch src/shorts/videoPick.ts/watchPov.ts; thumbs-rerender and publish-at both touch public/app.js and src/youtube/youtubeUpload.ts — merge one at a time, `npm run test:unit` after each, `npm test` after the icons, then he pushes and runs `docker restart mcsr-dashboard`, then `bash scripts/browser-checks/run-all.sh http://mcsr-dashboard:8080`.

**4. Done today, for the record:** the triple comment — ZqI4Cf1g3_w (lowkey–woofdoggo_ series) got 4 tip-jar comments (game 1's at 03:00, games 2–4's at 13:48 when the restarted dashboard's channel scan paired the series video to those folders as "studio" records and auto-finished each). Fixed in `d19a130` (the comment step reads the video's threads and posts nothing if the channel's comment is there; the scan skips a video another match owns); the 3 duplicates deleted via the API at the operator's word ("you delete"), the 03:00 one remains. Every other video has exactly one channel comment; playlists hold ZqI4 once each. Left alone: the old "studio" records in games 2..n of all four series (harmless now).

**5. The operator's own list:** on the lab host `cd /home/homelab/mcsr-vid && git push origin main && docker restart mcsr-dashboard` (loads the comment guard); pin the remaining comment on ZqI4Cf1g3_w; the older Studio list below (end screens, Shorts' related videos, trailer + Home layout, Ko-fi, runner DMs).

**26 Sept ~15:05 UTC.** Deleted the 3 duplicate comments on ZqI4Cf1g3_w (operator: "you delete"); the 03:00 one remains (pin it in Studio). The "upload date" box is the Publish kit's read-only Publish at copy block, not a Firefox bug: workflow wf_1d33f0cc-6fd builds an editable publish time on branch publish-at (worktree .claude/worktrees/publish-at) — before upload the chain uses it, a scheduled video moves on YouTube with one press (Short keeps its 18 h gap), slot rules become warnings. Running alongside: round 4 icons + watch progress (wf_15cb865b-c6a), thumbs-rerender (wf_029deaf4-60a), pick-mechanics resumed (wf_b45ebb6a-066, task wgrkefdhu) after two research agents refused on the Firefox message.

**26 Sept ~15:10 UTC — triple comment fixed (d19a130, main, not pushed).** ZqI4Cf1g3_w (lowkey–woofdoggo_ series) carries 4 copies of the tip-jar comment: game 1's at 03:00, then games 2–4's at 13:48 when the restarted dashboard's channel scan paired the series video (its description links every game) to those folders as "studio" records and auto-finished each. Guards: the comment step reads the video's threads and posts nothing if the channel's comment is there; the scan skips a video another match already owns. Checked every video: only ZqI4 has duplicates; its playlists hold it once each. Asked the operator: delete the 3 extra comments (13:48:11/13/14 UTC; keep the 03:00 one and pin it) via the API or in Studio. Left alone: the old "studio" records in games 2..n of all four series (harmless for comments now). Also asked: which "upload date" box fails in Firefox — the only date field (Publish → Upload by hand → Publish at, #ytWhen) edits fine in Playwright Firefox at desktop and phone width; there is no date field for the automatic chain's slot.

**26 Sept — thumbnail re-render option in flight (workflow wf_029deaf4-60a, branch thumbs-rerender, worktree .claude/worktrees/thumbs-rerender).** The operator: "also i want an option to re render the thumbnails. do you think its a good decision to rerender the thumbnails for each vid as the ones we have now are nicer?" Building: per-match Re-render (old variants kept in thumbnail-prev/, thumbnail.png untouched), per-video Put on YouTube / Undo (thumbnail-youtube-prev.png), bulk re-render (render only). My advice given: re-render all once the icons are approved; swap the low-traffic ones directly; Studio Test & Compare (old vs new) on the top five by impressions (11–24 Sept: vASY6MzFRNM 32k, opWF0g2VCP0 26k, 4evKn5k0_p8 24k, 6YWABc--rQk 18k, f4Z2Dvg9ihc 16k = 63% of 183k; channel CTR 3.65%). Every live long-form (23) still wears a pre-redesign thumbnail; 5 early Studio uploads have no thumbnail files at all.

**26 Sept — round 4 in flight (workflow wf_15cb865b-c6a).** The operator: "add a progress bar on running /watch on a vid thats rendered. shipwreck looks meh. change it up a little the rest is good you can make the village 2d and give me a buried treasure thats 2d id like to see what it looks like. add an outline to the desert temple so its easier to recognize". Track A: the pick reports a percent through activityProgress (proxy → /watch × 2 → model), branch watch-progress (worktree .claude/worktrees/watch-progress). Track B on seed-icons-vanilla: new shipwreck candidates, VILLAGE main = 2d, BURIED_TREASURE-alt = 2d, DESERT_TEMPLE 2d front with an outline (portal and temple otherwise kept). Review sheets → /home/node/.claude/jobs/8d7d95a1/tmp/vanilla/out/r4/review/. On return: look, send, merge both only on his OK.

**25 Sept ~16:50 UTC — seed icons round 3 DONE, waiting for the operator's pick.** Branch seed-icons-vanilla (53df9d5, worktree .claude/worktrees/seed-icons-vanilla; merges clean with main): the icons are PNGs rendered from the real 1.16.1 structures (scripts/seed-icons/: bake.py reads the jar's .nbt + block models, render.sh/icons.sh; the desert pyramid rebuilt from the game's generator logic in scripts/seed-icons/structures/). Main/alt per type: VILLAGE plains_small_house_1 iso / 2d; SHIPWRECK with_mast 2d side on a seabed / iso wiki angle; DESERT_TEMPLE 2d front / iso close (the 2d front is the weakest at 40 px); RUINED_PORTAL portal_6 with its one missing obsidian added + lit, 2d / iso; BURIED_TREASURE the old scene through the new engine (water now translucent). Swap = rename <TYPE>-alt.png over <TYPE>.png. Review sheets sent: /home/node/.claude/jobs/8d7d95a1/tmp/vanilla/out/review/{sheet,wiki-compare,thumbs-sheet,thumbs-sheet-alt,compare-rival}.png. On his pick: swap as chosen, merge, `npm test`, he pushes + `docker restart mcsr-dashboard`. Also on main: e67ce23 (shortFlow test read the real clock).

**25 Sept ~10:45 UTC — resume point.** main a6a2d48 (+ this commit), 6 commits NOT pushed (no GitHub credential in the container since the restart; the operator pushes from the lab host: `cd /home/homelab/mcsr-vid && git push origin main`). Dashboard boot = 84d9582 — needs `docker restart mcsr-dashboard` for the versus intro and the slot icons. **In flight:** a background agent (worktree isolation) is building seed-type icons as isometric Minecraft DIORAMAS from the real 1.16.1 textures — the operator: "our competition has wayyyy better icons. can't we just steal them? or make quality ones like he has" (answer: no copying his art — make our own at his quality). Same API `SeedIconMC({type,size})`; renders land in /home/node/.claude/jobs/8d7d95a1/tmp/diorama/ (review sheet, side-by-side with his crops in …/tmp/rival/, the five real thumbnails from …/tmp/example/*.json). On its return: look at the renders, send them to the operator, merge only on his OK. Also open: explainMovesSec is 1 s on the lab (recommend 4, then redo 13448958/13141080 stills+export); the operator's Studio list (delete spIyAaQmZr8, pin 6 comments, end screens, related videos, trailer, Ko-fi); whether python3 now reaches /watch (next pick's log).

**24 Sept ~20:45 UTC — the operator's picks are in ("id like those"), main 3860e85, NOT pushed (no GitHub credential in the container since the restart — push from the lab host: `cd /home/homelab/mcsr-vid && git push origin main`).** Thumbnail seed slot back on with `SeedIconMC` (inventory-slot icons from the Minecraft 1.16.1 textures in remotion/assets/minecraft/); the intro card is the versus screen (remotion/Intro.tsx). The rejected hand-drawn icons, the bigger-plates intro and the unpicked layouts are deleted. Takes effect after `docker restart mcsr-dashboard` (Remotion is bundled in the server process); PNGs/webms on disk are kept, so only new renders get the new look. The Short picker's /watch still needs python3 in the dashboard container — the next pick's log shows it.

**24 Sept ~19:30 UTC — waiting for the operator's picks.** The first seed-icon set was rejected ("doesnt look like minecraft at all") and the thumbnail's seed slot is OFF (`SHOW_SEED_SLOT = false`, remotion/Thumbnail.tsx, d93debb). New options from the real Minecraft 1.16.1 textures on branch worktree-wf_080e1007-499-1 (0a9f189, remotion/SeedIconMC.tsx, style "slot" | "iso"; renders /tmp/opt-icons/). The bigger intro was rejected too ("change it up think of another layout"): three layouts on branch worktree-wf_080e1007-499-2 (03285b0, remotion/IntroLayouts.tsx, prop introLayout "tape" | "versus" | "cards", default unchanged; renders /tmp/opt-intro/). On a pick: merge the branch, switch the Thumbnail slot to SeedIconMC with the chosen style (and SHOW_SEED_SLOT true), make the chosen intro layout the default, render-check, `npm test`. Recommended: icons B with A's boat; intro 1 (tape).

**24 Sept ~19:05 UTC: main at ea8419b, pushed, all green.** Merged since: the thumbnail redesign (bigger figures facing each other, name plates clear of the duration stamp, crimson/warped split, our own 16x16 seed-type icon above the VS — remotion/seedIconArt.ts is hand-editable); the bigger 5 s intro (players and stats fill the frame); comment retry on the nightly tick (once per VIDEO — a series' record sits in every game's folder); YPP rates over the days Analytics returned; series chapter seed labels at upload (moot for playoff games: the API has no seedType for private rooms). 13448958 and 13141080 re-exported with the teaser + subscribe line, waiting for the operator's hooks. The operator set explainMovesSec to 1 in Settings — too short to read; 4 recommended (a change means re-doing those two exports' stills, ~25 min). Needs the operator: `docker compose build && docker compose up -d dashboard` (python3 for /watch, and loads all of today's server code), then the Studio list in the entry below.

**24 Sept ~18:40 UTC — the operator: "retitle change descriptions and do everything you can from the 30 day action plan from the audit."** Done on the channel (Data API, own channel, each verified by a read-back): 11 retitles/description fixes (9O_R3A0Gbek, -4v3Q1F0CXA, r0F15RPC0nE, HZMx38dwSSE, 4dIJIAEUJCk SWEPT→AWKWARD, POQrpE0-5d8 + 4dIJIAEUJCk "Nth seed", XdEnjmUmLoU's link → hMA09SfxwxE, names added to LUClAl05hAY, 48I_StdUsWg, k9m6lFIRs0g, UchGHjZUuXk); the duplicate spIyAaQmZr8 made private and unscheduled (deleting it is the operator's — Studio) and taken out of its 3 playlists; zSon9yOTYpM unlisted; the season playlist ("MCSR Ranked matches") cleaned of 8 Shorts and a deleted video; the pinned comment (with the tip jar) posted on 6 long-forms via Finish on YouTube (pinning is Studio); upload records' titles synced (backups in the job tmp dir). The non-subscriber trailer write returned 200 but YouTube ignores unsubscribedTrailer via the API — Studio. Code: duplicate-upload guard (ed02ae4), Dockerfile pip3 after python3 (6e59037; needs `docker compose build && docker compose up -d dashboard` — the dashboard has no python3, so /watch never runs for picks), pre-match trim + countdown teaser (090c375), avatars face each other (1f913c9), hooks always save, no seed/rank/elo hooks, not-at-night/skip-tonight, blind caption D. In flight on agy: seed icons (v2), bigger intro (v2), thumbnail redesign, series chapters at upload (b3), comment retry (b4), YPP arithmetic (b5); a Claude agent re-exports 13448958 + 13141080 (then the operator saves their hooks). Operator-only: delete spIyAaQmZr8; end screens; related-video links on Shorts; pin the 6 comments; trailer + Home layout; Ko-fi settings; runner DMs; save hooks daily; the image rebuild.

**24 Sept 09:20 UTC: main pushed, all green — goal closed at 11:55 Polish.** Also merged: the intro card's length as a setting (`introSec`, 2–7, default 7 = unchanged; the card lies over the frozen countdown, match start stays at 10 s; applies to the next render — an already-rendered match keeps its 7 s card). Audit #1's second half (the teaser large across the countdown) is not built. Final report: https://claude.ai/artifact/74sSn9ivdnURFtWMKMoDoR. (An upside-down avatar in a sample still was Dinnerbone's UUID in remotion/Root.tsx's sample props — fixed to Ranik_'s.)

**24 Sept 09:05 UTC: main at 7fc5c06, pushed, all green — the audit's code fixes are in.** Merged this morning: #4 upload-time text refresh (`uploadTextFor` rebuilds the generated title half and patches old descriptions: "#N seed"→"Nth seed", closing line, tip jar; edited text untouched; the kit shows the same text); #6 series spacing (`seriesPairGapDays` 3, `publishSlotFor` + `publishWhy` in the kit), series chapters "game N · <world seed type>", SWEPT/sweep refused (hook save and the title fold now refuse result words; "to win" passes as a stake); #7 engaged views + watch hours before raw views (YouTube panel, YPP Shorts gate counts engaged views — 850 not 3,197 — as YouTube's YPP does); #3 explain-the-moves captions (`explainMovesSec`, ships OFF — the operator's call to switch on in Settings → Publishing); a loadPreview TypeError on a repainted panel; all 23 browser checks passed on the live dashboard (5df85a7). **Needs `docker restart mcsr-dashboard`** for the server half of all this. Operator decisions: switch on explain-the-moves (look at a render first); the rewind-eval hybrid picker; rewriting live descriptions still saying "#N seed" (future uploads are fixed by #4). Left from the audit: #1 shorter intro + teaser across the frozen countdown (changes every render — operator's call).

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
