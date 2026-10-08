# mcsr-vid

Turns an MCSR Ranked match id into a synced, split-timer-overlaid video (`fetch-match` →
`download-vods` → `validate-sync` → `render-overlay` → `generate-project` / `export:fast`), plus
thumbnails and a Short, published to the YouTube channel **MCSR Replayoffs**. Everything below is
what an agent cannot derive from the code; the rest is in the files it names.

## House rules

- The match footage is never cut. The two editable regions — before the match and after the run
  — are automated (`ANCHOR_SEC`, `src/pipeline/postRoll.ts`; the tail is at most `postRollSec` = 30 s,
  cut earlier where the winner goes quiet, never under 15 s).
- Each POV's audio leans toward its side of the frame (`povAudioPan`, default 0.7; 0.5 is the
  centred mix everything before 18 Sept 2026 shipped with) in `export:fast` only — the Kdenlive
  project's MLT mix stays centred, and the Short (stacked top/bottom) lowers the POV the moment is not about by 12 dB instead (`focus`, 23 Sept 2026).
- Nothing names the winner: no result line in the description, no winner in a hook or on a
  thumbnail. The upset hook is a question.
- **The YouTube API compliance audit cleared on 15 Sept 2026** ("completed your review and don't
  require any further actions"; submitted 7 Sept, round-2 recording 14 Sept — the reply texts are
  `handbook/api-review/`). `videos.insert` is allowed; `youtubeUploadEnabled` is true on
  the lab and the dashboard uploads. `nightlyUpload` is `"scheduled"` since 22 Sept 2026 (the
  operator's edit — it changes what a nightly render does). Google may re-review: keep every API call
  inside what the recording showed (own channel, own data, nothing shown to anyone else).
- Nothing irreversible without the operator: deletions, retitles on the live channel, config
  that changes what a nightly render does.
- **Studio automation stays inside the audit's own rule** (own channel, own data, nothing shown
  to anyone else) and never does what rail 2 of its plan rules out — see "Studio automation"
  below.

## Layout

`src/` is grouped by what the code is for; a module's folder is the first thing its path says.

| Folder | What lives there |
| --- | --- |
| `src/api/` | The outside services read: MCSR Ranked (`mcsrApi.ts`, `types.ts`), Twitch (`twitch.ts`, `twitchChat.ts`), avatar renders. |
| `src/pipeline/` | A match to a finished video: fetch, VOD download/discovery, sync (`countdownDetect.ts`, `sync.ts`, `syncFile.ts`, `syncEdit.ts`), the overlay (`overlayProps.ts`, `overlayRender.ts`, `splitStates.ts`), the Kdenlive project and `export:fast`, and the text it writes (`title.ts`, `description.ts`, `hooks.ts`, `chapters.ts`). `pipeline.ts` is the stage runner. |
| `src/thumbnails/` | The variant strip and its manifest. |
| `src/shorts/` | The model's pick (`videoPick.ts`, `watchPov.ts`, `pickCli.ts`), the heuristic scorer it falls back to, the reasoner, the vertical render, `generateShort.ts`. |
| `src/playoffs/` | The bracket and its games (`playoffs.ts`), a series as one video (`series.ts`, `seriesCli.ts`). |
| `src/youtube/` | The Data API client and auth, upload records, the upload itself, the channel pairing, the publish slot. |
| `src/dashboard/` | The web server (`server.ts`, one dispatch chain), its route groups (`youtubeRoutes`, `exportRoutes`, `shortsRoutes`, `syncRoutes`), the match screen's payload (`matchMeta.ts`), jobs, the nightly, suggestions, the shelf (hidden/queue/checklist), the publish set. |
| `src/telegram/` | The Telegram bot: the Bot API client (`bot.ts`), the morning report's facts (`facts.ts`) and its rendering (`report.ts`), the Claude CLI adapter that is the report's brain (`claude.ts`), the reports `/ask` reads (`knowledge.ts`), the 07:00 Warsaw schedule (`schedule.ts`), slash-command parsing (`commands.ts`), the dedupe/snapshot state file (`state.ts`), the wiring `server.ts` boots (`index.ts`) and the CLI (`tgCli.ts`). |
| `src/cli/` | Entry points nothing else imports: batch, status, score, chat, bench, retention, the TUI. |
| `src/` root | `config.ts`, `cliArgs.ts`, `errorText.ts`, and the tests that cut across folders. |

Tests sit beside what they test (`foo.test.ts` next to `foo.ts`); fixtures are `src/fixtures/`.
`remotion/` is the compositions; `public/` the dashboard's browser files; `scripts/` the
browser checks and the small build/preflight helpers; `docs/` the GitHub Pages site (not repo docs — see the root `README.md`).

## Commands

Use the script, don't reconstruct the shell line. Extra arguments go after `--`.

| Script | What it does |
| --- | --- |
| `npm run dashboard` | The web dashboard (`PORT`, default 8080). |
| `npm start` | The terminal UI (`src/cli/tui.tsx`). |
| `npm run still -- <Composition> <out.png> [--frame=N] [--props=p.json]` | One Remotion frame to PNG — the fast visual check. Rebuilds overlay CSS first. Composition ids are in `remotion/Root.tsx`. |
| `npm run validate-project -- media/<id>/match-<id>.kdenlive` | Load the generated MLT XML through the MLT engine. Exit 0 = parses. Malformed XML only: it passes a project whose media is missing. |
| `npm run export:fast -- <matchId> [--cpu] [--seconds=N] [--full-tail]` | The finished MP4 in one ffmpeg pass (Intel VAAPI on the lab), no Kdenlive. `--seconds` renders a short range as a smoke test, to `smoke-<id>.mp4` (it once wrote over a published match's final). Open the `.kdenlive` when a match needs a human; both place clips through `placeOnTimeline`. |
| `npm run export:nvenc -- media/<id>/match-<id>.kdenlive [out=N]` | melt + `h264_nvenc` to `out/export.mp4`. Needs an NVIDIA GPU; the lab has none. |
| `npm run short -- <matchId> [--at=<ms>] [--seconds=N]` | The vertical Short (`short-<id>.mp4`) plus its `.title.txt` / `.description.txt`, cut from the pick's window (`short-<id>.pick.json`). Refuses without the operator's hook (`short-<id>.hook.txt`) or once the Short is on YouTube. `--at`/`--seconds` override the window by hand. The cut is recorded in `short-<id>.cut.json` with the hook it used. |
| `npm run series -- <matchId \| all> [--join-only]` | A playoff series as one video (`src/playoffs/series.ts`): renders every game of the slot that has no export, joins them into game 1's `series-<g1>.mp4`, rewrites game 1's title/description/chapters/tags for the series; the series' Short is picked and cut like any match's, from game 1's directory, once the hooks are saved. `all` walks the board in date order; `--join-only` joins what is exported. The dashboard's nightly cannot see a run here: start one in the daytime. |
| `npm run sync-status -- [matchId]` | Where a match's POV clips are placed. With an id and no `sync.json`, derives it from the `.kdenlive` and writes it, so a re-export picks the corrected offsets up without a re-render. No id lists every match and writes nothing. |
| `npm run chat -- <matchId>` | Fetch both players' Twitch chat to `chat-<nick>.json` for a match the pipeline saved none for (it does this itself after `download-vods`). Existing files are kept; delete one to refetch. |
| `npm run clip -- <twitch url \| local file> [--from=HH:MM:SS --to=HH:MM:SS] --title="…" --speaker="…" --when="…" --credit="…" [--slug=…] [--seconds=N]` | A standalone clip (a stream statement, a reaction — not a match) framed in the channel's look and composited to `<mediaDir>/clips/<slug>/clip-<slug>.mp4`. See Clips. |
| `npm run tg -- report --dry-run` | The morning report's exact text, printed, nothing sent — needs no Telegram key. `cmd "/stats 7d" --dry-run` answers one slash command the same way; `send --md <report.md>` sends a report (Markdown turned into Telegram formatting), `send <text>` / `send --file <path>` a line or a file, to the operator's chat; `whoami` prints the chat ids that recently messaged the bot (`getUpdates`), for pairing `TELEGRAM_CHAT_ID`. See Telegram bot. |
| `npm run pick -- <matchId \| all> [--force] [--dry-run]` | Ask the model for the Short's moment (see Shorts): prints the prompt size, the model's raw answer, any validation failure and the pick. Without `--force` a pick newer than the export is kept. `--dry-run` asks afresh and writes nothing into the match directory; it refuses (exit 1) rather than make the proxy or a /watch cache, saying why the one on disk does not count (none, older than its source, other arguments — a checkout without `/app/.env` adds `--no-whisper` — or a run that kept none); only a missing one is a reason for a real run. |
| `npm run bench -- <Composition> [--frames=N] [--codec=] [--pixelFormat=] [--concurrency=N]` | Render throughput for one composition. Measure before claiming a render change is faster. |
| `scripts/seed-icons/icons.sh [TYPE…]` | Re-render the thumbnail's seed-type icons from their specs (~6 s each; needs the 1.16.1 client jar, fetched from Mojang once). One spec: `scripts/seed-icons/render.sh <spec.json> <out.png>`. |
| `npm run retention -- <videoId>… [--days=90]` | The audience retention curve per video (Analytics API `audienceWatchRatio` by `elapsedVideoTimeRatio`), printed at every tenth. Measured 22 Sept 2026: 16–22 points go between 3% and 10% of the video — the first minute after the intro, the least eventful stretch of a run — then a slow drift; the finish lifts the curve again. |
| `npm run config:example` | Rewrites `mcsr-vid.config.example.json` from `DEFAULTS` in `src/config.ts`, so the example cannot drift (it had, by seven keys). Run it after adding a key. |
| `npm run analytics -- <videoId> [--traffic-sources] [--days N]` | YouTube Analytics via `~/.claude/skills/claude-youtube/` (outside the repo; token at `~/.claude/.tmp/youtube_oauth_token.json`). |
| `bash scripts/agy-task.sh <name> <prompt-file> [model]` | Hand an easy, fully specified task to agy (Gemini, the operator's subscription) in worktree `.claude/worktrees/agy-<name>` on branch `agy/<name>`; its answer lands in `.tools/agy-dev/runs/<name>.json`. Its home `.tools/agy-dev` has ECC (pruned to this stack), ponytail, /watch and the Claude skills; it may write only under `.claude/worktrees` and run the read/test commands in its `settings.json`. Review the diff and commit yourself. The picker's home (`.tools/agy-home`) stays plugin-free on purpose. |
| `python3 scripts/reap.py <command…>` | Subreaper wrapper, only needed if zombies ever climb again (see Pitfalls). |
| `bash scripts/browser-checks/run-all.sh <url>` | Drives the dashboard in a real browser the way the operator does (26 Playwright checks, two of them only when a Studio upload or an unexported match exists; self-configuring from `/api/matches` and `/api/playoffs`). Point it at the real dashboard (`http://mcsr-dashboard:8080` from the Claude container), not just a local test server — four checks only ever exercised a secure origin and hid a broken Copy button for it. Needs `npx playwright install chromium firefox` once and a server with real data. |

Lab timings for a 10-minute match: overlay render ~9 min, `export:fast` ~10 min, a Short in
seconds; a nightly render takes ~12 min, ~21 min with the MP4 (the Short waits for the hooks).

## What the render produces

Almost nothing in the overlay moves, so the render is stills plus one strip (`src/pipeline/overlayRender.ts`):

- `overlay-top.png` — the identity/stats band, static. On a playoff game it carries the series
  dots (one hollow square per game needed, filled per game won, at the score the game started
  on) and the seed in the rank's place; `overlay-top-end.png` is the same band with the
  winner's dot filled, and `export:fast` switches to it at the run's end (`topEndAtSec`). The
  Kdenlive project does not know the second still.
- `overlay-splits-<n>.png` + `overlay-splits.json` — the meta+splits region (1440x346), one still
  per distinct state (`src/pipeline/splitStates.ts`). The manifest is written last and means "the render
  finished". The last state is the subscribe card (`postRollCta`, `ctaFrameOf`). Both subscribe cards
  (this one and the mid-roll) show `ctaReason` in quartz above the gold SUBSCRIBE ("A NEW MATCH EVERY
  DAY", Settings → Publishing, one row of at most 24 plain-ASCII characters; empty = the bare card,
  byte-identical to before 1 Oct 2026); the Short's closing card has a SUBSCRIBE row, and the
  description carries "a new match every day. subscribe to catch the next one." as its own paragraph
  (`uploadTextFor` adds it once to an older unedited description at upload).
  `renderOverlay({ only: ["splits"] })` redoes just the stills in seconds.
- The first minute's **COMING UP card** is two more of those stills (`teaserFramesOf`): "COMING
  UP · AT 5:14 · THE LEAD CHANGES ON BLIND TRAVEL" in the meta column from `teaserAtSec` (10,
  Settings → Publishing, empty = none) after match start for `teaserSec` (5) — aimed at the
  16–22 points lost between 3% and 10% of the video. The moment is `src/pipeline/teaser.ts`,
  from `match.timelines` only: an unplanned death, else the lead change that overturned the
  biggest deficit, else a split under 2 s; never in the first minute or the last minute before
  the game is decided, and it names nobody. It reads `death` only, so it never promises a hunger
  reset — nor sees a bed-spawn death in the End, a real one to `deathKind`. A match led wire to
  wire, no death, no close split, gets no card (4 of 10 checked, 24 Sept 2026); the mid-roll
  SUBSCRIBE wins an overlap.
- **Explain the moves** (audit fix #3, 24 Sept 2026; `explainMovesSec`, Settings → Publishing,
  default null = **off** — on changes what the nightly renders, the operator's call): the first
  time either player reaches each of the six `MILESTONES` splits, the meta column shows the split
  and why the runner is there ("BASTION · TRADING GOLD TO PIGLINS FOR ENDER PEARLS") for that many
  seconds — two stills per card (`explainFramesOf`). The lines are `MOVE_LINES` in
  `src/pipeline/explainMoves.ts`, written for the Minecraft player who has never watched a
  speedrun and for YPP's reused-content review ("where you explain the moves"); they name nobody
  and rows break at their `\n` (26 characters, three rows at most). A card that would share a
  frame with the SUBSCRIBE line, the teaser or the card before waits for it; one that would then
  reach the finish is dropped.
- `overlay-timer.mp4` — the RTA column (480x346), the only thing rendered per frame.
- `overlay-intro.webm` — the intro card (the versus screen, `remotion/Intro.tsx`), `introSec` long (Settings → Publishing, 2–7, default 7;
  the 24 Sept 2026 audit proposed at most 3 — the operator's call). It lies *over* the frozen
  countdown and never moves the timeline's anchor. `export:fast` cuts `7 - introSec` seconds off
  the countdown's head (`headTrimSec`) and lays the card over the MP4's own 0, so the card still
  opens the video, "3, 2, 1" follow it and match start is at introSec + 3 s (7 → 0:10, byte for
  byte today's; 3 → 0:06). The Kdenlive project does not cut: it stays at 0:10. Both take the
  card's length from the file, so a match keeps the card it was rendered with until
  `only: ["intro"]` redoes it.
- `overlay-countdown-teaser.png` — the COMING UP line large across the bottom of both POVs
  (`remotion/CountdownTeaser.tsx`, clear of the countdown digit at their centre), rendered with
  the top band only when `countdownTeaser` is on (default off) and the match has a teaser
  moment; removed otherwise. `export:fast` shows it from the card's end to match start when the
  setting is on and the file exists; absent, the filter graph is today's. The Kdenlive project
  does not know it.

## Shorts

Rebuilt on 23 Sept 2026 (the operator's calls; contract `src/shorts/shortPlan.ts`, research in
`~/.claude/projects/-app/research/shorts-2026-09-23/`). The old Shorts were fixed 22 s windows
that ended on the finish 80% of the time: 21–31% of feed plays became engaged views and 2,819
views brought 0 subscribers.

- **A model watches the whole match and picks the moment** (`src/shorts/videoPick.ts`,
  `pickShortMoment`): a 2 fps 640x360 proxy of the export (`short-proxy.mp4`, proxy time = match
  clock; 1 fps for a series), /watch's stills and transcripts per player (`src/shorts/watchPov.ts`
  → `watchScript`, the plugin copied to `/app/.tools/watch/` because the dashboard container
  cannot see `~/.claude`; transcripts need `GROQ_API_KEY` in `/app/.env`), then Antigravity
  (`reasonerCommand`: `agy` with `gemini-3.8-flash-high`, `--sandbox`, never
  `--dangerously-skip-permissions` — the prompt carries Twitch chat). The answer is one
  continuous window of 12–60 s (`SHORT_MIN_MS`/`SHORT_MAX_MS`), both POVs or one player's alone
  (a death, a zero cycle), a focus side, a hook suggestion and a one-line why — the why can
  exaggerate (it once made a 7→5.5-heart hit "half a heart"), so it is for the operator's eyes
  only. Validation: bounds, `rtaAtStart` within ±2 s of the start (the answer must be tied to the
  footage), a series window ends before its game is decided. One retry on an empty answer
  (Flash sometimes reaches for a shell command, which headless mode denies), then the old
  timeline heuristic (`src/shorts/shortMoment.ts`) stands in and `short-<id>.pick-error.json`
  says why. The pick is `short-<id>.pick.json`; `npm run pick -- <id|all> [--force]` asks again.
  A whole match costs ~1.5–5 min and ~80–140k tokens on the operator's subscription. While it runs,
  the Pick step's bar is one percent over its phases (`src/shorts/pickProgress.ts`, weighted by lab
  timings): the proxy by ffmpeg's `time=`, each /watch by its stills on disk and stderr markers
  ("running /watch on edcr's stream · 2 of 2"), the model by an elapsed-time estimate that never
  arrives; it never goes back and stops at 99 until the pick is written.
- **No Short renders and nothing uploads before the operator saves the hooks** (the gate is in
  `generateShort.ts`, `youtubeUpload.ts` `hookRefusal`, and every render path): the Short's hook
  is its own field, `short-<id>.hook.txt`, prefilled on the dashboard with the model's
  suggestion; the long-form's title hook is the edited title. Saving both
  (`PUT /api/shorts/hooks/:id`) starts the chain in `src/dashboard/shortFlow.ts`: render the
  Short, upload the long-form at its slot (or the kit's Publish at, see Publish kit), upload the Short 18 h later. A hook changed before the
  upload re-renders; after the upload the hooks lock. "No Short for this one" lets the long-form
  go alone. `short-<id>.status.json` holds each step's state and errors.
- **On screen** (`src/shorts/shortRender.ts`, `remotion/Short.tsx`): the hook for 4 s
  (`SHORT_HOOK_SEC`), then captions from the race data (`raceCaptions`, `src/shorts/raceGap.ts`:
  "SILVERRRUNS 8 S UP AT THE EYES" — a leader may be named mid-race, never the result), a running
  clock in the top nameplate (YouTube's own UI covers the bottom ~20%), the off-focus POV lowered
  12 dB, and a closing card: "WHO TOOK IT? FULL MATCH ON THE CHANNEL" when the window ends before
  the match is decided, else "FULL MATCH ON THE CHANNEL" ("SERIES" for a series). The single-POV
  layout is a centre crop that keeps the crosshair and the hotbar.
- **The model is told the game** (`src/shorts/speedrunPrimer.ts`, sourced lines only; 26 Sept 2026, after it built
  "THEY BOTH DIED IN THE STRONGHOLD?!" on two hunger resets; corrected by the fact-check of 26 Sept). `deathKind`
  (`src/pipeline/matchScore.ts`) is the one reading of `death_spawnpoint`: the hunger reset in every phase but the
  End — at a respawn anchor in the Nether too, five of the six before blind on disk — and in the End, where no bed
  sets a spawn, a real death. The prompt's facts, the Short's captions and hook, the heuristic, the title chips,
  the suggestions' chaos score and the card's "N deaths" all follow it: `metrics.deaths` counts real deaths only
  (the operator, 26 Sept: "yes" to leaving resets out of the score — it changes what the nightly picks;
  `CACHE_VERSION` 4 re-reads every suggestion). `teaser.ts` keeps its own stricter reading.
- **The pick also proposes the long-form's title hook** (`titleHooks`, up to 3, and `playerMoments`
  for the runner DMs, both optional on `ShortPick`; operator's ask, 24 Sept 2026: "use agy to propose
  the hooks based on previous ones"). The prompt shows the operator's own past saved hooks as style
  examples (the first ` | ` segment of every `match-<id>.title.edited.txt` beside a `youtube.json`,
  spoilers, "PLAYOFFS" and, since 2 Oct 2026, any "vs" shaped hook at all left out, real nicknames or
  not); each proposal passes `hookProblem` or is dropped with the reason logged; `suggestions.title`
  lists them first (the dashboard's chips are held to the same rule, so one cannot reach the panel
  either). The operator's calls (24 Sept): when the model's window is rejected its title hooks go
  with it — the heuristic fallback carries none.
- **Never a nickname, label or epithet for a runner, "vs" or not** (`hookLabelProblem`,
  `src/pipeline/hooks.ts`; `hookProblem`'s `players` argument, `src/shorts/videoPick.ts`; `withHook`'s,
  `src/pipeline/title.ts`; 2 Oct 2026). The operator, after "LCQ vs YN | lauveer vs edcr" and "ASIAN
  VS CARNIVORE | hackingnoises vs BeefSalad" were both called out on X as naming a runner by a slur
  and a race label, and the replies read it as Claude's suggestion: "we fucked up." Root cause traced
  further back than the model: `match-12730175.title.txt` (edcr vs doogile) had "YN vs TAS" as its
  own first suggestion — `withHook` carrying forward whatever a thumbnail manifest's `hookText` held,
  unvalidated, from before the thumbnail's hook text came off (18 Sept). Where that August headline
  came from first (typed, or an early chip) is not on record. It reached the operator's edit from
  there, then `pastTitleHooks` showed it as a style
  example, and the prompt told the model an epithet could be reused "when that same player is in this
  match" — the model copied "YN" onto lauveer–edcr, a different match's different player. Both
  permissions are gone now: `pastTitleHooks` shows no "vs" example at all (above), and `withHook`
  refuses a carried hook that labels a player exactly as `hookProblem` refuses a model's or warns on
  a typed one — a carried value is as untrusted as either. The shared rule everywhere: a denied word
  (an ethnicity or nationality term, a slur-adjacent abbreviation) is refused outright, "vs" or not;
  a fresh "X vs Y" is checked against the match's own two players (API or `titleNames` spelling) and
  a mismatch is a label too. A model's proposal and a carried one both fail closed; the operator's
  own typed hook still always saves (`writeHooks`, `src/dashboard/shortFlow.ts`), the problem landing
  in `saveWarnings` next to the field like every other check there — "it should just be a
  suggestion." A match rendered before this fix keeps whatever its `title.txt` already carries until
  its next full re-render.
- **The Short's title** is `<hook> | <left> vs <right>` with `titleName` (Skycrab, lowkey), plus
  `#mcsr #minecraft` when it fits in 100 characters — the only Short with a player name in its
  title drew the search traffic.
- **A playoff game's nameplates show the seed, not the ladder rank**: a bracket has its own
  order. A series is picked and cut from game 1's directory, the clips from the picked game's.
- **Auto-crop usually declines, and should**: streamers' panels reach the frame edges.

## Dashboard

`src/` is read at boot; `public/` is served from disk per request. After pulling server changes
run `docker restart mcsr-dashboard` on the lab (both containers share one image; the repo and
`/media` are bind mounts). The nightly strip names the running and the checked-out commit when
they differ (`code: { boot, now }` from `src/dashboard/repoHead.ts`). Client changes need only a reload.

- **The dashboard can restart itself once it is idle** (`src/dashboard/restartWhenIdle.ts`, 8 Oct
  2026 — part of the operator's week goal: "the automation lives in the dashboard code, not this
  session"). `POST /api/restart-when-idle` arms a pending restart; `DELETE` cancels it; `GET`
  (and `GET /api/nightly`'s own `restart` field, for the strip) reports it. Armed, every 30 s
  `idle()` checks every reason the standing rule exists for ("never restart while a chain
  uploads" — a 1 Oct 2026 restart cut a Grand Final upload at 30%): a pipeline render, an export
  (also a series game's and a sync fix's Re-encode — same job table), a Short render, the model's
  pick queue, the publish chain, an upload, a `.upload-session-*.json` still on disk, an NAS copy,
  and the 20 minutes before `nightlyRenderHourUtc` might fire. Idle, it runs `npx tsc --noEmit`
  (5 min cap) before it dares exit — code that would not even type-check must never be the reason
  the channel stops updating unattended — then logs the commit it is booting into
  (`src/dashboard/repoHead.ts`) and calls `process.exit(0)`; tini's `restart: unless-stopped`
  brings the same, now-updated bind mount back up. A failed boot check disarms (no automatic
  retry) and keeps its error on the state until a fresh POST or a DELETE; an arm that never goes
  idle for 6 h gives up on its own. The nightly strip shows one small, non-`.bad` line while
  armed.
  **Review fixes, 8 Oct 2026**: `idle()` also reads `nightly.ts`'s own `nightlyChainRunning()` —
  between a chained render's job settling and the next one's `startJob` (`nightlyMaxRenders` > 1),
  this function is awaiting a live suggestion scan and `pickContext`, so a job and an export can
  both read "not running" while a render is still about to start; the flag covers that gap and is
  cleared by whichever call ends the chain (a skip, "not chaining further", or a thrown ranking
  step). A signal function throwing (not just a failing `tsc`) now also sets `restartState().error`
  the same way a failed boot check does, instead of only a `console.error`. And a failed or stuck
  arm (that `error`) is folded into the Telegram morning report's health section
  (`restartIdleHealth`, `src/telegram/facts.ts`) — before this, a self-deploy that never landed was
  invisible unless someone opened the dashboard, which contradicts "I act only on what the 07:00
  report lists."

- **Two screens, one bar.** The list and the match are two screens at every width
  (`body.view-match`, `public/app.css`), not just under 860 px: the desktop no longer keeps a
  card column open beside the match. The four list tabs are the only navigation — a 72 px rail
  on a desktop, a fixed bottom bar on a phone or tablet — and a tab tap is also the way back
  (`showTab` calls `showList`); `#backtolist` exists only under 860 px. Each tab cell is the name
  over its count (`#tab-* small`); the button ids are unchanged. The nightly strip is a static
  `#nightly` under the header on every screen; its warnings (`server behind`, `Run now failed`)
  are direct children with `.bad`, which is what lets the phone match screen keep exactly those
  and hide the plan, the queue and the button (`body.view-match #nightly > :not(.bad)`, no `:has()`).
- **The match screen is a head and four groups** in the order the morning happens, and the
  order is the point: **Now** (`#now` steps · `#nowsync` weak-sync frames · `#save`), **Check**
  (`#h-preview` final video · `#synccheck` · `#syncedit` fold), **Package** (`#h-thumbs` thumbnail ·
  Splits fold · Title & description fold with `#savetext`), **Publish** (`#h-youtube` YouTube panel,
  then `#h-publishkit`, `#checklist`, Manage fold). The After group and `#h-short` were deleted: no
  Short renders and nothing uploads before the hooks are saved; once saved the chain runs itself, so
  the Short's status and preview sit in Now, its title/description in the kit's after-upload fold,
  and the Manage fold (`#mhide`, `#mdel`, outputs table) moved to the bottom of Publish. Package
  begins with `#h-thumbs` Thumbnail (`#variants`); the hook fields moved to Now. On a desktop they
  are two columns (Now + Check left, Package + Publish right); under 860 px one group is shown at a
  time (`.panel.on`), switched by the `.jump` bar in the bottom-bar slot (`now`, `check`, `package`,
  `publish`) — a tap `preventDefault`s the hash link and scrolls to the top: the group is the whole
  screen and the head above it is short, and the hash scroll put the head, `#headwarn` with it,
  under the back bar on the very panels that hold Upload and Adopt. Re-selecting the match on screen
  (the strip's last-run link, a card's "Rendered · open") keeps the group that was open; every match
  opens on Now, a link's too (`showPanel(panel ?? keepPanel ?? "now")`). Any phone check that fills a Package or Publish
  control taps `.jump [data-panel=…]` first. Now (`#now`, `public/app.js`, `paintNow`) is one column
  of steps in pipeline order from `GET /api/shorts/plan/:id` (`ShortPlanResponse`): **Video**
  (exported, and whether sync is weak/stale; `#nowsync` shows the two 9.6 s countdown frames
  side-by-side on weak sync, the same look as Check's sync check, because a weak sync is the one
  thing worth seeing before saving hooks), **Pick** (the model's window with `src#t=start,end`
  preview, why line, POV/kind; or the heuristic standing in with `!` and its reason, not a stopped
  step), **Hooks** (prefilled `#hook` title hook with title chips, `#shorthook` for 4 s with Short
  chips, and `#noshort` checkbox; locked once uploaded; typing writes "not saved" to `#savedmsg`;
  saving before a pick explains why the Short hook is empty), **Short** (renders automatically once
  hooks are saved, ~2 min; watch preview and download link once rendered; skipped if `noShort`),
  **Video up** (scheduled publish slot time, next free slot, or open link once up; warns if uploads
  are off on the box), and **Short up** (18 h after the video; omitted if `noShort`). A finished
  step is one line; the step that needs the operator, is running, or failed is open. A running step
  carries the server's activity line (`activitySum`) with a live elapsed clock counting up from
  `activity.since` (`tickClocks`) and a progress bar when percent is known. A failed step says
  "failed" in words with the server's error, timestamp, static fix hint (`fixFor`), and an action
  button (`Retry` saves the saved hooks again to restart the chain; `Re-encode in Check ›` if sync
  is stale). Each step has a Details fold (`.steplog`) with the server's log lines from `plan.log`,
  error count, unfoldable line details (`.logline pre`), and a `Copy` button (`copyText` to plain
  text). A failed poll shows an inline scanline ("dashboard unreachable — retrying in 5 s",
  `.nowconn`) without blanking or freezing the panel. "Pick again" sits inside Pick (or "Ask the
  model" if unpicked and not on the channel). Opening a match queues a model pick (`GET
  /api/shorts/plan/:id` → `shortPlan(id, { queue: true })`) when it is exported, has no readable
  `short-<id>.pick.json` (a heuristic fallback pick counts as one), is not `noShort`, has neither
  its Short nor its long-form on the channel (record, scan pairing or manual tick), has no pick
  running or queued, reads from the MCSR API, and is not a playoff game before its join; the pick
  spends a model watch only when `reasonerCommand` is set.
  `#save` sits in `.saverow` at the end of the Hooks step while hooks are editable (text: "Save
  hooks and schedule", "Sync looks right — save hooks and schedule" on weak sync, "Save hooks" if
  already saved, or notes uploads are off on the box), then moves after the last step on desktop
  (pinned to the phone's bottom slot) as "Next waiting ›" when other matches await hooks. "Waiting
  for a hook" counts matches with a pick ready to glance at (`shortState === "waiting-for-hook"` and
  `shortDetail !== "not picked yet"`), as the strip and `#tab-matches small` count it; backlog rows
  not picked yet (`shortDetail === "not picked yet"`, sorted after in-progress) are neither counted
  nor offered as next (opening one asks the model). On a phone, `#nextwaiting` in `#backbar` shows the
  count beside `#backtolist`, which omits its own count when "N more waiting" already says it.
  The head is short on purpose — the match id, `#failure`, and `#headwarn` (the detector's
  confidence line plus a mirror of `#syncstale`, so leaving Check never hides the sync warning) —
  because the sync frames must start on the phone's first screen; `#checklist` (six fact pills hidden
  by CSS, all ten still in the DOM — hook-flow-check reads its text) sits at the bottom of Publish,
  since every pill left on view is a post-upload tick. `#preview .previewmeta` is one row for the
  same reason (the file name gets the ellipsis; the Short's `.previewmeta` lines still wrap).
  `#run`/`#stop` are the head's primary button for an unrendered match and live in the Manage fold
  (with `#mhide`, `#mdel`, the outputs table) once it is rendered; `armStop` opens that fold.
  The kit's description + tags are one more fold; its "after the upload" fold opens itself once
  `kit.videoUrl` exists and brings back the Short's title and description once the Short is cut.
- **Rendered rows are two lines**: names + id, then one state line naming where the match stands
  (`waiting for hook`, `scheduled`, `published`, `published · no Short`, `@mcsrmatches posted 1d ago`,
  `in progress · overlay`, `failed`). Running rows show the server's own detail once, not twice
  (`SHORT_LINE` + `shortDetail`); unpicked rows are backlog sorted after in-progress (`exported · no Short
  picked yet — opening it asks the model`). Deleted, not folded: the stage pips and their legend, the
  list's order line, the suggestions' bucket legend, the head's jump-link row, the old Re-run at the
  top of a rendered match, `#hostmeta` on phones. "Render only" is a text link in a suggestion card's
  links row (`a[data-act="render"]`, same handler); the button row is Render + Short + MP4 · Queue ·
  Dismiss.
- **The touch-target block fires on `pointer: coarse` OR `max-width: 860px`.** Playwright's
  Chromium drops the coarse-pointer emulation after a full-page screenshot on a mobile context,
  so a width-only measurement of a phone page found 28 px inputs the real phone never shows; the
  width clause makes the 44 px targets a fact of the layout rather than of the emulation.
- **Suggestions** (`src/dashboard/suggest.ts`, `src/dashboard/suggestPresent.ts`): scored candidates, cached in
  `<mediaDir>/.suggest-cache.json`; bumping `CACHE_VERSION` re-fetches everything on the next
  scan (~350 MCSR API calls against 500/10 min). Scanned at boot, every `suggestCacheTtlMin`
  (30) for new matches, before the nightly picks, and fully on the `rescan` link. Every scan also
  reads the own match lists of the favourites and of `STRONG_DRAWS` (measured draw ≥ 1.0 —
  hackingnoises, edcr, nahhann off the default roster; BeefSalad was the fourth until the block):
  9 calls, so a strong name too quiet for the feed's paging still reaches the pool — offered every
  scan a match is not yet in the pool (`cache.pool`), not just the scan its VODs are first seen on
  (4 Oct 2026: gating this pull on `countedMatchIds` too — a flag that means only "already counted
  for popularity" — left a match that missed one scan's detail-fetch shortlist, or that fell out of
  the pool once full, stuck there for good; a live 10-day sample had 60 of 114 known-player dual-VOD
  matches stuck exactly that way). Pruning to `POOL_MAX_ENTRIES` (500) now keeps a known player's
  matches ahead of a newer no-name one too, not just the newest overall — plain recency let the
  feed's sheer volume of random matches crowd a known player's matches out days before they actually
  aged out. A scan's slots go one card per pair, across all three buckets: close, chaos, and `known` —
  a known player's match (`suggestKnownSlots`, default 4, on top of the close/chaos slots, settings
  tab) needing no closeness or chaos score at all. The operator, 4 Oct 2026: "schedule some matches
  really known players the matches don't have to be that interesting you can lower the threshold
  like this for the suggestion mechanism."
  **The known bucket is also capped one slot per player, not just one per pair** (`take()`,
  `src/dashboard/suggest.ts`, 7 Oct 2026): sorted by audience alone it was a 1-2 name monopoly —
  silverrruns' matches held 3 of 4 live "known" slots every scan, and a sample of the last 4
  days' 15 pooled, known-player, dual-VOD matches from doogile, hackingnoises and Pinne got zero
  of them (read-only investigation, 6 Oct 2026). A first pass skips a candidate if either player
  already filled a slot this scan (same shape as the pair-level `pairs` Set, one level up); a
  second, unconstrained pass backfills any slot the cap leaves empty, so the bucket is never
  emptier than before. No scoring input changed — `CACHE_VERSION` stays 4. A scan that stumbles —
  a corrupt `.suggest-cache.json`, a match whose detail fetch keeps failing, a Twitch login lookup
  that never resolves — now says so with a `console.error` instead of quietly resetting dismissals
  or returning fewer matches than it found; a scan where more than a couple of detail fetches fail
  also surfaces one note in the result, next to `scanNote`, rather than looking like "no good
  matches" (7 Oct 2026).
- **Favourite players come first, then known ones** (`tierFor`, `suggest.ts`; `favouritePlayers`,
  Settings tab, default doogile, Feinberg, Infume, Pinne, lowk3y_, silverrruns — edcr is the
  operator's call; `knownFollowerThreshold`, default 10,000; `pairRepeatDays`, default 3, 0 = off).
  The order, for the list and the nightly alike (`orderForDisplay`, `src/dashboard/suggestPresent.ts`;
  `take()` in `suggest.ts` uses the same tier and audience when a scan picks the cards, then the
  bucket's score, and — for the `known` bucket only, 7 Oct 2026 — one slot per player as well as
  one per pair): a match with a favourite → one with a known player → neither — above everything
  else, an expiring card included (1 Oct 2026: an expiring no-name sat at #1 of 443) — then, inside a
  tier, expiring → the rival's post after → audience → bucket → popularity. Audience is expected
  views, not ladder activity (`audienceFor`): the bigger player's draw + half the other's × (1 + 0.5 ×
  favourites) × 0.5 when the same pair had a long-form on the channel, or a render waiting for hooks,
  within `pairRepeatDays`; popularity (appearances + followers, which is how often someone plays —
  gothy666's 241 to Infume's 91) only breaks the last tie. Known: a favourite; else, when draw.json
  measured them 3+ times (`DEFAULT_DRAW`, seeded once), a draw ≥ `KNOWN_DRAW_MIN` (0.6) —
  authoritative either way (hackingnoises, no follower data: known; romuxii, 1,962 followers, 0.43:
  not); else that many Twitch followers. A draw nobody measured is a prior from the following
  (`UNMEASURED_DRAW`: 50k+ 1.0, 10k+ 0.75, else 0.5). No chaos/closeness term: match quality is
  uncorrelated with views once players are controlled for (1 Oct 2026). The pair snapshot
  (`pairPosts.ts`) refreshes in the background; the nightly waits for it at most 15 s. The operator,
  30 Sept 2026: "no name players no one will click on that"; 1 Oct: "the suggestion system is shit
  it recommends and schedules matches that no one will watch".
- **Blocked players** (`blockedPlayers`, Settings tab, default `["Aquacorde", "BeefSalad"]`;
  `isBlockedPlayer`/`blockedIn` in `src/config.ts`, compared whole and ignoring case): a runner who
  has withdrawn permission for their footage. A match with one is dropped before the suggestion scan scores it
  and leaves the pool on the next scan even if it was already in there (`suggest.ts`), never shown
  on the list however stale the cache (`suggestPresent.ts`), never rendered by the nightly even
  if the operator queued it — the block outranks the queue, the only gate that does
  (`nightlyEligible`/`resolveQueuedPick`/`playoffPicks`, `nightly.ts`), never "worth rendering today"
  (`src/telegram/worth.ts`), never uploaded, long-form or Short, one clear line like `hookRefusal`
  (`src/youtube/youtubeUpload.ts`), never gets its hooks saved so its chain never starts
  (`src/dashboard/shortFlow.ts`), never rendered by `npm run short` even run by hand
  (`src/shorts/generateShort.ts`), and never a style example in the pick prompt's past hooks
  (`pastTitleHooks`, `src/shorts/videoPick.ts`). `finishOnYouTube` carries the same refusal
  (no playlist, thumbnail, comment or tag write; a still-pending step's note says why, already-done
  steps are left alone and nothing is persisted, so unblocking needs no repair) to every one of its
  three callers at once — Adopt, the Finish button and the nightly's `retryFailedPlaylists`/
  `retryPendingComments` ticks; **Adopt** (`POST /api/youtube/adopt/:id`) also refuses up front,
  before `videos.update` — the write `finishOnYouTube`'s own gate does not cover. `POST /api/render`
  (a brand-new match, `matchIsBlocked`, `src/dashboard/matchStatus.ts`) and `POST
  /api/series/:id/render` refuse before the fire-and-forget run even starts, and `renderSeries`
  itself refuses too (`{kind:"blocked"}`, `src/playoffs/series.ts`) — the one place both that route
  and `npm run series` settle through. `hasBlockedPlayer` (`youtubeUpload.ts`) reads
  `povNicknamesOnDisk`, the same disk-only POV-clip reader `matchStatusFor` itself uses, so a
  generated MP4 (`overlay-timer.mp4`, `final-<id>.mp4`, …) is never mistaken for a player. The
  operator, 2 Oct 2026, after Aquacorde commented that he does not give permission for his footage
  to be used in the videos: "were fuuuuucked … take down all his videos and blacklist him." His 7
  videos and 4 playlists were set private on the channel the same day (ledger
  `/home/node/.claude/jobs/8d7d95a1/tmp/aquacorde/ledger-apply.json`). BeefSalad joined the list
  4 Oct 2026 after commenting "do not use my footage again" — the operator's standing rule is that
  a runner's no is a block, same as Aquacorde's. The known bucket (`suggestKnownSlots`, above) is no
  exception: a match is pruned from the pool for being blocked before `tier()` ever sees it.
- **Rival posts** (`src/dashboard/rivalPosts.ts`): the competitor's (`rivalChannelHandle`, default
  `mcsrmatches`) last 50 uploads, matched to cards by nickname pair, date and run length (their
  video is the run plus a few seconds; a post of the wrong length is another match of the same
  pair). A posted match sorts after the fresh ones, in the nightly's order too. `playersFromTitle`
  takes the pair right before the MCSR tag, so the rival's hook-less "A vs B | MCSR Ranked" titles
  and spaced nicknames ("Darvy  x1" is DARVY__X1) parse too — 18 of its 129 titles were missed
  before 1 Oct 2026.
- **Hook chips** (`src/pipeline/hooks.ts`) lead with the match's stake — the margin, a lead change, a
  death — and put the nickname and "Rematch: X leads N-M" chips after them (1 Oct 2026: the early
  9.36%-vs-2.25% CTR reading was 4,590 impressions; at 126,745 it was 2.77% against 2.59%, a wash, and
  the rematch record can already include the match itself). The pick prompt labels the operator's past
  hooks by register (stake, question, rivalry) and says stake is preferred. A typed hook that reuses a
  nickname an earlier uploaded title gave another player ("TAS" stood for doogile) comes back with a
  warning in `saveWarnings` — one nickname per player; the post-mortem of 30 Sept 2026 found "TAS" on
  four players across seven titles. The description's links block gains "last time they met:
  https://youtu.be/<id>" at upload when the same pair has an earlier long-form on the channel
  (`lastMeetingFor`, `src/youtube/youtubeStore.ts`; once, unedited descriptions only). Suggestions never use seeds, ranks or elo (the operator's
  call, 24 Sept 2026: "no one cares about that" — and they change daily). "SWEPT"/"sweep" is a result word in
  `spoilsTheResult` (a best of 5 titled "PLAYOFFS | SWEPT vs TAS" told how it went). A typed hook always
  saves — any check on it (result words, length) comes back as a warning beside the field, never a refusal
  (the operator: "it should just be a suggestion"); so does the Title & description fold's save for a segment the generated title does not carry
  (`typedSpoiler` — "3rd Place" is a round name there, not a result).
- **Three `hooks.ts` chip bugs fixed 6 Oct 2026**, after a 3-judge panel (click, accuracy, risk)
  scored 26 real matches' hooks: `secondsPhrase()` replaces the old `seconds()` helper, which
  stripped a trailing ".0" and left the plural behind ("Decided by 1 seconds"); it also renders under 100ms as exact milliseconds rather
  than a rounded, overstated "0.1 seconds" (the channel's own past title was "58 MILLISECONDS"),
  and the 3-10s tier keeps the same "Decided by" subject instead of a bare "N seconds apart" (every
  such hook in the panel was dropped for not saying what the number measured). The lead-change
  chip ("The lead changed N times") is now the numberless question "Does the lead ever settle?":
  the exact count both overcounted (it read splits — bastion loot, the blaze rod — the overlay
  panel never shows) and let a viewer work out who leads at the end by parity once they'd counted
  the flips on screen. The swing chip ("A M:SS lead, gone" / "N seconds swung it") used
  `maxSwingMs`, the raw step between two splits' signed gaps, which fires just as readily when a
  leader simply pulls further ahead — verified false on 5 real matches where the leader led wire
  to wire and won. It now reads `metrics.splits` for the biggest lead a player actually held at a
  split they did not go on to win from (`OFF_PANEL_SPLITS` excludes "Bastion loot" and "Blaze rod",
  the two the overlay never shows — a bug this fix's own first draft had, caught only by a live
  `getMatch` recheck, not the panel's notes), and asks "Can a M:SS lead survive?" rather than
  asserting the outcome. The DNF fallback says "One of them never **killed** the dragon", not "reached" —
  `finishMarginMs` null only means no dragon kill; the loser can have fought and died in the End.
  `src/shorts/videoPick.ts`'s `hookProblem` also strips `PACE_TO_WIN` (`hooks.ts`: "sub-N to win
  [it]" only, never a bare "to win", so "X battles back to win it" stays refused) before its own
  spoiler check, as `spoilsTheResult` does: it had disagreed with `hooks.ts` and was silently dropping the pace chip
  ("A sub-N to win it", already `hooks.ts`'s own highest-weighted candidate under 8 minutes)
  wherever it would otherwise have won, in both the dashboard's chip list (`shortFlow.ts`) and the
  Short's own `chipHook`/`extrasOf`. Full write-up: `handbook/knowledge/hooks-2026-10-06.md`.
- **Three more chip-truth fixes, 8 Oct 2026**, ahead of the operator's planned auto-hooks (a match
  whose hooks go unsaved 6 h after its pick gets the best chip auto-saved, so a chip must be true
  unattended): an Opus judge reviewing Test & Compare material found the lead-change and no-death
  chips still checkably false against real matches, and a playoff series' chips reading the wrong
  game.
  - **The lead-change chip still counted the two off-panel splits** (`panelLeadChanges`,
    `MatchMetrics`, `matchScore.ts`): `leadChanges` — the shared field `closenessScore`/`chaosScore`
    read, so left unchanged, `CACHE_VERSION` untouched — counts every split including "Bastion
    loot" and "Blaze rod" (`OFF_PANEL_SPLITS`, now exported from `matchScore.ts` so `hooks.ts`'s
    swing-chip filter and this one share one definition) and the dragon; `panelLeadChanges` is a
    second field counting only the six the panel shows, excluding the dragon too (it almost always
    "flips" to the winner, which would let a viewer read the result off the last flip by parity).
    "Does the lead ever settle?" now reads it. Live-verified: 13560037 (panel 1, old field 3),
    13782182 (panel 0, old field 2) — the chip fired on both under the old count.
  - **"Not a single death" counted real deaths only** (`onScreenDeaths(match)`, `matchScore.ts`):
    a hunger reset is routine in `metrics.deaths` (the chaos score's own term, unchanged, 26 Sept
    2026) but the POV still shows a death screen for one, so the chip now reads every
    `death`/`death_spawnpoint` timeline entry regardless of kind. Live-verified false under the
    old `deaths === 0` test: 12730175 (five hunger resets), 13766294 (one).
  - **A joined series' chips read game 1's own numbers, not the game that decided it**
    (`hookFactsMatchId`, `src/playoffs/series.ts`): `matchMeta.ts`'s `readHookSuggestions` and
    `shortFlow.ts`'s `suggestionsFor` both now build the `HookInput`'s `metrics`/`match` from
    `series.games`' last entry (chronological, so the last is the one that reached `firstTo`) when
    the match is a joined series, while the manifest/budget/identity stay keyed on game 1 as
    before — a margin, a pace or a lead-change chip quoting game 1 can be false of the video once
    a later game actually decided it.
  Pinned against real match/series data (fixtures `src/fixtures/match-{13560037,13782182,
  13766294}.json`, and the real edcr-lauveer Round of 16 record in `series.test.ts`), not a live
  write.
- **A subscribe line during the race** (`midRollCtaAtSec`, Settings → Publishing; default 90,
  null = none): the post-roll card in the meta column reaches 25–45% of viewers, the first split
  (~90 s) 50–60% (`npm run retention`, 22 Sept 2026). The meta column shows SUBSCRIBE for
  `midRollCtaSec` (4) seconds at that moment — two more stills (`midRollFramesOf`,
  `src/pipeline/splitStates.ts`). The operator switched it on that morning; the five Round of 16
  series were re-exported with it.
- **The title spells two players the broadcast's way** (`titleNames`, default
  `{ Pinne: "Skycrab", lowk3y_: "lowkey" }`, `titleName` in `src/pipeline/title.ts`): the title
  only — the overlay, the description and the tags keep the API spelling, and the tags carry
  both. The operator's call, 22 Sept 2026; the fourteen live titles were rewritten the same
  morning (the `| Minecraft Speedrun` tail with it).
- **`nightlyUpload` is `"scheduled"` on the lab since 22 Sept 2026** (the operator's call:
  "whatever gets the most views"), and since 23 Sept it decides how the chain uploads once the
  hooks are saved: private, scheduled for the next free 19:00 UTC slot — a series for 23:00 —
  or the operator's own time from the kit's Publish at, and the Short 18 h later (`"private"`: no publish time; `"off"`: the chain stops after the
  render). The nightly itself never uploads any more. Still not writable from the Settings tab.
  **Picking that free slot and claiming it is one serialized step** (`claimSlot`,
  `src/dashboard/shortFlow.ts`, 7 Oct 2026): four hooks saved inside one second started four
  chains whose renders all finished together, and every one of them computed "the next free
  slot" before any other had recorded one — three long-forms landed on the same 19:00 UTC hour.
  An in-process lock (a promise chain, not a true mutex — there is only ever one dashboard
  process) now makes the pick and its write to this match's own `slotClaim` one step, so a
  concurrent chain's own pick sees it (`storedTimes`, `src/youtube/publishSlot.ts`) before the
  slow real upload that follows even starts; the claim clears once the upload-video step settles,
  done or failed. The operator's own chosen time (the kit's Publish at) is untouched by this —
  it is already a claim on disk before any chain runs. The lock's critical section can reach the
  MCSR API (`pairGapTimes`'s `getMatch`, a cold playoff-bracket fetch) — a stall there would once
  have blocked every other chain's upload, not just the slow one's, so `getJson`
  (`src/api/mcsrApi.ts`) now carries a 15 s `AbortSignal.timeout`, the same bound every other
  external call in this codebase already uses (review fix, 7 Oct 2026).
- **Auto-hooks** (`autoHooksAfterHours`, Settings → Publishing, default null = off; `autoHooksTick`,
  `src/dashboard/shortFlow.ts`, on the same 15-minute tick as `shortTick`): the operator's own
  grant for the week of 8–14 Oct 2026 ("a match whose hooks I haven't saved 6 h after its pick
  lands gets the best title hook that passes hookProblem + hookLabelProblem + spoilsTheResult (the
  model's, else a hooks.ts chip) and a Short hook chosen the same way; the chain then runs as if
  I'd pressed Save"). Due: a readable pick (the heuristic's counts) whose own `createdAt`, or the
  file's mtime without one, is at least that many hours old, hooks not yet saved, not hidden,
  neither video on the channel, no blocked player, the export present and not stale, no chain or
  save already running for it. The candidates and their order are exactly `#hook`/`#shorthook`'s
  own (`suggestionsFor`, not re-implemented): the model's proposals first, then the chips, each
  already filtered through `hookProblem` (which is `hookLabelProblem` and `spoilsTheResult`
  together) — the first survivor wins. Upper-cased to match the house style when the operator's
  own recent saved hooks (`pastTitleHooks`) read mostly upper case. No title candidate survives:
  nothing is saved and the match's `hooks` step reads failed, with "no suggested hook passed the
  checks — save one by hand". A title that survives with no Short hook saves with `noShort: true`.
  Every save is logged to `short-<id>.status.json`'s own `autoHooks` record (`listAutoHooks`), kept
  across any later save so the morning report's "Auto-saved hooks" block can always say what it
  last picked; a later operator save overwrites the hooks as usual. The session turns the setting
  on live (`PUT /api/settings`) once this merges — it is not on anywhere by default.
  **Review fixes, 8 Oct 2026**: `autoHooksTick` skips a playoff game whose series hasn't joined
  yet (game 1 before the join, or game 2..n) before ever calling `saveHooks` — the same
  `seriesGameUnjoined` check `shortPlan` already makes — because `saveHooks` would otherwise only
  ever refuse it with `SERIES_GAME`, every tick, until the bracket catches up. Any refusal
  `saveHooks` does return (that one included, were the pre-check ever to miss a case) now fails
  the match's `hooks` step the same way `AUTO_HOOKS_NO_PASS` does, so it reaches
  `gatherNeedsYou`'s `failedStepItems` — the one place the operator said he acts from — instead of
  only a `short-<id>.log.jsonl` line nothing reads. The tick's own loop wraps each match's
  `autoSaveHooks` call in try/catch, so one broken match directory throwing instead of returning a
  controlled result can't abort the tick and starve every match due after it.
- **A playoff game's thumbnails can carry the tournament** (`playoffThumbnailStyle`, in the
  Settings tab; `remotion/Thumbnail.tsx` `playoff`): "bracket" puts the round in the band and
  "Best of 5" under the VS; "trophy" grows the band for a gold PLAYOFFS wordmark over the round
  and the series length, and frames the body. The plates keep the name, never the seed. Default
  "plain" — the operator picks from the renders in the 22 Sept report. A ranked match is never framed. **Not wired yet**: nothing in
  `computeThumbnailProps` sets `playoff`, so the setting changes no render today; wire it when
  the operator picks a style.
- **Thumbnails are two big figures and two names** (`remotion/Thumbnail.tsx`, the thumbnail section of
  `remotion/overlay.source.css`; built from the 24 Sept 2026 study of @mcsrmatches,
  `~/.claude/projects/-app/research/thumbs-2026-09-24/spec.md`): the renders cut at the knee on a mid-value crimson/warped
  split, name-only plates at y 516–600 (`nickFontPx`: 56 px, 49 for 16 characters) so YouTube's
  duration stamp never covers one, and the seed type framed above the VS (`seedType` from
  `match.seedType`; null or unknown leaves the slot out; the art is `SeedIconMC` drawing
  `remotion/assets/seed-icons/<TYPE>.png`, a 1024 px render of the real 1.16.1 structure — the
  jar's own template, blocks and textures — by `scripts/seed-icons/` (`bake.py` resolves a scene
  spec from `scripts/seed-icons/scenes/`, `render.sh` draws it; `icons.sh [TYPE…]` regenerates the
  icons; preview with the `SeedIconSheet` composition). Every main is a 2d elevation (the operator, 26 Sept:
  "i will go with 2d options for every seed type for the temple i want the outlined one") and
  `<TYPE>-alt.png` is the iso render, renamed over `<TYPE>.png` to swap; which spec makes which file
  is the map in `icons.sh`. A spec's `outline` draws a dark contour round the structure's silhouette
  (the desert temple's, 26 Sept: "add an outline to the desert temple so its easier to recognize").
  The shipwreck's main is `SHIPWRECK-2d-front-beached` (the real with_mast ship tilted onto a
  sandbank — the `roll` edit; the operator's pick on 26 Sept, "i pick L"); change the spec and
  `icons.sh SHIPWRECK` redoes it. A hand-drawn set was rejected on 24 Sept ("doesnt
  look like minecraft at all"), the one-item GUI slot and then hand-built dioramas on 25 Sept ("the
  temple doesn't look like the temple try to copy the real structure. you can also try and make it
  2d. the portal is not complete so it looks off. […] the buried treasure actually looks the best and
  most correct its simple and easy to grasp"): the portal's frame is completed on purpose; the buried
  treasure's old scene is its iso alt) — no rating, seed, placement or other text. The four pose pairs
  of `thumbnailVariants` still render, the first (`walking`/`crossed`) the auto default — off by
  default; `thumbnailRotatePoses` (7 Oct 2026, Settings → Publishing) switches a fresh auto pick
  to deterministic-by-match-id rotation among the pairs actually rendered instead, because 88% of
  uploads were wearing that one pose pair (the 7 Oct packaging audit). An operator's pick and an
  already-uploaded thumbnail are never touched either way. **"cheering-relaxing" (the left runner,
  arms up) is excluded from every automatic pick** (`RESULT_LOOKING_POSE_KEY`,
  `thumbnailVariants.ts`; 8 Oct 2026, chip-truth): it reads as the result, spoiling when the left
  player won and misleading when they didn't, so both `autoDefaultKey`'s rotation and `tc-thumbs`'s
  SSIM "most different" pick (`tcThumbs.ts`, which had picked it 7 of its first 10 sets) filter it
  out of their own pool first, falling back to the full list only if that would leave nothing to
  pick from. The operator can still choose it by hand (`chooseVariant`) — the exclusion is only on
  the paths nobody reviews. `RIGHT_RENDER_SIDE` follows the CSS mirror of the right image. The hook text came off on 18 Sept
  and its twins were deleted on 24 Sept: an older manifest's `hookText`/`-hook` records are read
  by `readManifest`, hidden by the panel and handed to the title by `carriedHookText`. The
  checklist's thumbnail pill ticks on `chosenBy: "operator"`, and `variantStillReusable` keeps a
  PNG already on disk, so the layout reaches only matches rendered after it.
- **`npm run tc-thumbs -- <matchId…>`** builds a Test & Compare set per match
  (`<mediaDir>/<id>/tc/`: the live pose as a control, the most-different already-rendered pose by
  SSIM, and the live pose re-rendered with a short on-image caption, `src/thumbnails/tcThumbs.ts`).
  **The caption (`.thumb-caption`, `remotion/overlay.source.css`; `tcCaption.ts`) was unreadable
  and sometimes wrong at YouTube's 168x94 thumbnail size, fixed 8 Oct 2026 (chip-truth, verified by
  rendering stills and reading the PNGs at that size, not just by eye on the full canvas):** the
  font grew 56px to 76px so it is actually legible that small, `CAPTION_MAX_CHARS` tightened 14 to
  9 to match what still fits at the larger size (the longest clean token, "1:36 LEAD"), a
  decimal-seconds margin and the lead-change question are now dropped outright rather
  than squeezed (no clean short form exists, and `shortenHookChip` returns null — "a caption is a
  clean token or nothing"), and no template glues a bare "S" unit onto a digit any more ("1.3S" +
  Monocraft read as "1.35"; "48S LEAD?" had the same problem) — a whole number of seconds keeps a
  space before "SEC" instead. The byte-identical-when-`caption`-absent pin
  (`thumbnailCaption.render.test.ts`) still holds; its own box widened slightly for the bigger font
  and is checked against both the shortest live token and the longest approved one.
- **`videos.insert` is the only call the audit gated** (`youtubeUploadEnabled`). `playlistItems.insert`,
  `thumbnails.set`, `commentThreads.insert` and `videos.update` are all inside the token's
  `force-ssl` scope, so **Finish on YouTube** repairs a Studio upload too: playlists, the pinned
  comment and the tags. It leaves the thumbnail alone on a video uploaded elsewhere whose variant nobody
  confirmed here, so it cannot replace an image picked in Studio.
- **Adopt a Studio draft** (`POST /api/youtube/adopt/:id`, the panel's "Adopt this draft"): the
  operator drops the file into Studio leaving every box empty, pastes the 11-character id, and the
  title, description and tags go on through `videos.update`, then the finish steps run. It exists
  because the pairing everything else relies on is the `/matches/<id>` link *in the description*,
  which a blank draft has not got — so the write is what makes the video findable. It replaces the
  title and description, so it is one explicit press on a video named by id: never something a
  scan, the nightly or `finishOnYouTube` can reach. It refuses a malformed id, an id already
  recorded for another match **or as any match's Short** (`videoIdOwner` reads both kinds —
  `allUploads` reads only `youtube.json` and cannot see a Short, which is the id most likely to be
  pasted by mistake), a video three minutes or shorter, a title still reading `<HOOK>`, a
  description that would not pair, a strip with no `chosenBy: "operator"` variant (the thumbnail
  step would otherwise decline and leave YouTube's auto frame on), and a video on someone else's
  channel. It is **not** behind `youtubeUploadEnabled`: `videos.update` is not the call the audit
  gates. Re-adopting the *same* video carries the finish ledger forward, so a second press redoes no step.
  The comment step also reads the video's threads and posts nothing when the channel's comment is
  already there (`postComment` itself de-duplicates nothing): four went up on the series video
  ZqI4Cf1g3_w on 26 Sept 2026, one per game folder the channel scan had paired it to — the scan no
  longer records a video another match already owns.
- **A record's `privacyStatus` is from upload time and is never updated**, so the comment step
  re-reads the live status before it skips: a draft adopted while private and published an hour
  later would otherwise carry "private" for ever and never get its first comment. The comment
  still cannot go up while the video really is private, so a scheduled video gets it on the
  nightly's tick once it goes public (`retryPendingComments`) — or, with `commentSoonAfterPublish`
  on (7 Oct 2026, default **off**), within a jittered 5-20 minutes of going public, checked by the
  same 15-minute tick that drives `shortTick` (`commentSoonTick`, `src/youtube/youtubeUpload.ts`).
  Off keeps the comment landing on the nightly's tick, hours after the video goes public — the
  03:00:0X pattern the 6 Oct 2026 packaging read flagged as a visible machine-made tell.
- **`videos.update` replaces the part it is given.** `addTags` (`src/youtube/youtube.ts`) reads the snippet
  and sends it back whole — a `part=snippet` write that omits the description blanks it on a
  published video. It only ever adds tags, so a tag typed in Studio survives, and it refuses to
  write at all if the read returns no video. `reschedule` (the kit's Move on YouTube, one press)
  sends the `status` part back whole the same way. `videos.update` is not the call the audit gates.
- **Upload** sends `match-<id>.tags.txt` and refuses a title still containing `<HOOK>`. The text
  is the render's, refreshed at upload (`uploadTextFor`, `src/youtube/youtubeStore.ts`; the kit
  shows the same): the title keeps the operator's hook and rebuilds the rest from the stored line,
  a description nobody edited gets the known drifts patched ("9th seed", the closer, the tip jar —
  not rebuilt, since its VOD links and ratings are the render's), the tags gain `titleNames`
  spellings, the Short's title follows `buildShortTitle`; anything that will not refresh cleanly
  (a title over 100, an unknown tail) goes up as stored with one log line. It adds
  the video to the season playlist (`PLHG-jSA-dWDo`), a per-matchup and a per-player playlist
  (`src/youtube/youtube.ts`; ids remembered per process because YouTube's list is eventually consistent).
  A Short joins none (the 24 Sept audit found 8 in the season playlist, between the replays).
  A matchup playlist is created on a pair's *second* video, with the first added alongside
  (22 of 28 playlists held one video on 22 Sept 2026). The Season 11 playoffs playlist exists
  (`PLBtNy46ii7uU`). A Short's description gains "the whole match: https://youtu.be/<id>" at
  upload time, once the long-form's id is in `youtube.json`. A published long-form also queues an
  NAS copy (`archiveMatch`, same for a Studio upload the channel scan records), which now only
  actually runs 03:00–08:00 Warsaw (see The NAS).
  **YouTube caps `playlists.insert` at about a dozen per rolling 24 h** (429 RATE_LIMIT_EXCEEDED;
  measured 15–16 Sept 2026): the step records the refusal in the ledger and the nightly's tick
  presses again (`retryFailedPlaylists`), so a cap line in the panel needs no press from anyone.
  **A Studio upload is recognised without a tick** (`src/youtube/channelUploads.ts`): the channel's
  videos are paired to matches by the `/matches/<id>` segment in the pasted description; the
  YouTube panel's "check the channel" link lists the channel at once. The manual `uploaded`
  tick is the fallback for a video with no match link.
  **The panel's numbers lead with engaged views** ("412 engaged · 1,090 views · 31 h watched"):
  62% of long-form views are muted Browse/Search previews (audit, 24 Sept 2026), so
  `videoEngagement` (`src/youtube/yppProgress.ts`, one top-videos Analytics request cached an hour)
  sits beside the Data API's views, "engaged n/a" when Analytics has no row or no answer, and the
  YPP Shorts gate counts engaged views, which is what YouTube counts; the A/B tab shows
  impressions and CTR, no views.
- **Settings tab** (`src/dashboard/settings.ts`, `GET`/`PUT /api/settings`): the handful of config keys worth
  changing without an ssh session. It writes `mcsr-vid.config.json` atomically and applies to the
  live `config` object, so nothing needs a restart — `scheduleNightly` reads the hour from `config`
  on every arm and the route re-arms it when that key moves, or the setting would lie. The file is
  read fresh and merged, so a hand-edited key the panel does not know about survives a save, and
  the merged object goes through `validateOverrides` — the loader's own function — so the panel
  cannot write a file that then fails to boot. **`youtubeUploadEnabled`, `nightlyUpload` and
  `studioAutomation` are deliberately not writable here**: the first switches the live channel's
  upload path, the second what a nightly does with its MP4, the third whether a real Chrome ever
  signs into the channel's own Google account (see "Studio automation") — all three stay a
  deliberate edit on the box and the panel only reports them. Add a key by
  adding a `SettingField` to `SETTINGS`; the panel and both tests derive from that list.
- **Publish kit** (`GET /api/publishkit/:id`): copy buttons for the title, the publish slot
  (`publishHourUtc`, default 19:00 UTC, the competitor's measured hour; a series video takes
  `seriesPublishHourUtc`, 23:00, its own slot — the test is the day *and* the hour, so the two
  kinds never push each other a day out — `src/youtube/publishSlot.ts`; `publishSlotFor` also keeps
  a ranked video and a series of the same two players `seriesPairGapDays` (3) UTC days apart,
  scheduled or public, and says so beside the slot and in the chain's log, because the
  doogile–Aquacorde series drew 84 views beside their same-day ranked video's 2,095), description, tags, the
  Short's title/description, a pinned comment, a community post, and a DM per player. The pinned
  comment (`pinnedCommentFor`, `src/youtube/youtubeUpload.ts`; the finish step and the kit build the
  same text) is a spoiler-free question about the race's closest rung ("who would you have backed on
  blind travel, X or Y?"; it never reads the result), the sync line, "more matches like this" with the
  pair's playlist (a read-only lookup — a pair's playlist is only created on its second video — else the
  left player's, else the season's) and the tip jar; the subscribe line lives in the description, not
  here. `copyVariety` (7 Oct 2026, off by default): rotates this sync sentence and the description's
  closer and subscribe-line paragraphs through a few phrasings of the same facts, each keyed off the
  match id by its own salt (`variantIndex`, `src/pipeline/description.ts`) so the three don't always
  move together, and a re-render or re-upload keeps its own phrasing rather than the one
  byte-identical sentence every video carried before. The DM (`src/dashboard/playerDm.ts`), when the pick has the model's `playerMoments` and the
  video is on YouTube, hands the runner a `?t=` link to their own moment and asks "ok if i keep posting
  your matches?" (API spelling, the channel named, the takedown offer kept); sending it is the
  operator's. When
  `pullSource` is set it opens with an rsync *pull* the operator's PC runs (`src/dashboard/publishSet.ts`;
  the lab host's path, not the container's `/media`) — pull, not push, because the image has no
  ssh client and the PC already reaches the lab. `GET /api/export/bundle/:id` is the same
  publish set as one `.tar`.
  **Publish at is editable** (26 Sept 2026, the operator: "on firefox i cant change the upload
  date"; `PUT /api/shorts/publishat/:id`, `setPublishTime` in `src/dashboard/shortFlow.ts`): a
  `datetime-local` in the browser's zone, stored in UTC as `publishAt` in `short-<id>.status.json`;
  while typing, the line beside Save names the instant in UTC (an hour a clock change repeats takes
  its first; an untouched Save sends the kit's own instant, and so does the by-hand upload while
  its field holds the kit's value). The chain's upload takes it while it
  is an hour ahead (`MIN_LEAD_MS`: YouTube checks the time once the file is up; Save and the
  by-hand form refuse less), else the next free slot, and the Short 18 h after. A stored time is a
  claim (`claimedPublishTimes`) and counts for the pair gap, unless its match is hidden; a playoff
  game 1 not joined yet takes `seriesPublishHourUtc`. The slot rules come back as warnings, never
  refusals (`slotWarnings`), and hide while another time is typed (they are the saved one's).
  Scheduled on YouTube with an upload record here (a dashboard upload, an adopted draft, or a
  Studio upload the channel scan recorded — `recordStudioUpload` keeps its `publishAt`), the button
  reads "Move on YouTube to …" and stays off until the time is changed (untouched, it would put
  the painted time back over a move made in Studio since): one press, refused while the match's
  chain runs (the Short's upload takes the long-form's time as it starts); `reschedule` reads the
  video live, sends the status part back whole (nothing for the time it already has), the record
  follows and the Short keeps its 18 h. The kit's state is the record's (`onChannel`; a public
  video's scan entry has lost its time), except where the record says less than the scan's entry
  for the same video: private with no time (a Studio upload recorded before 26 Sept kept none), or
  no time ahead while the scan still has it scheduled (moved in Studio). Now and the list read the
  record alone. A Studio upload the scan has not recorded yet says "move it there". A playoff game
  after game 1 has no time of its own, and a private room whose bracket cannot be read stores
  none (it may be one). `publish-at-check` lets only GETs reach the server (Save, Move and the
  by-hand upload's POST are answered in the browser; a plan GET that could queue a pick is aborted).
- **Publish checklist**: facts from disk plus manual toggles in `<mediaDir>/<id>/publish.json`
  (`src/dashboard/matchShelf.ts`). The Rendered tab counts matches waiting for a hook (`#tab-matches small`,
  falling back to `ready` on a server one restart behind) and is ordered by what needs the operator
  first (failed, then waiting for a hook, then running, scheduled, published).
- **Dismiss** hides a suggestion (`DELETE /api/suggestions/:id`) with an undo line
  (`POST …/restore`). **Delete** refuses while any job writes into the match directory.
- **A test server arms its own nightly.** Any `PORT=… npm run dashboard` schedules a render at
  `nightlyRenderHourUtc` against the same `/media` as production, and neither knows the other is
  running — two of them at 03:00 pick the same card and render into one directory. Kill a test
  server before the hour, or set `nightlyRenderHourUtc: null` for it.
- **Nightly** (`src/dashboard/nightly.ts`): at `nightlyRenderHourUtc` (default 3 UTC; `null` disables) the
  server renders the first eligible card in dashboard order, skipping the night if a render is
  running or under two matches of disk remain, then the MP4 (`nightlyRenderExport`), then queues
  the Short's pick — no Short and no upload: those wait for the operator's hooks (see Shorts).
  `nightlyNotifyUrl` gets one line on done / failed / aborted, plus "N waiting for a hook". With
  `nightlyMaxRenders` above 1 a clean run starts the next card, within four hours of the hour
  and through the same guards. The
  strip's `Run now` is the same path, as is a card's "Render + Short + MP4". Cards marked "not at night" (`nightlySkip`) are bypassed when picking candidates, and the strip's "Skip tonight" records `skipNightOf` in `.dashboard.json` to skip that night's scheduled run once and clear while `Run now` ignores it.
  **A candidate also needs a known player** (`nightlyEligible`, `isKnownPick`, 1 Oct 2026): unless
  the operator queued it themself, a pick is skipped unless a player is known (see Favourite
  players; `knownTierFor`) — a playoff
  pick (`bucket: "playoffs"`) always counts, since the bracket's players are the season's top 16
  and their Twitch following is often unmeasured. Nothing eligible says so in the skip reason
  ("…or has no known player"). A queued id the latest scan trimmed off the ranked list is still
  resolved rather than dropped (`resolveQueuedPick`): the scan's own pool first, no API call, else
  one `getMatch` and the scan's own scoring — the operator's own pick must not go silently empty.
  The strip's preview (`GET /api/nightly`, `previewPick`) is polled, so it resolves from the pool only
  and leaves such an id out; only the run may spend the `getMatch`. The nightly picks from
  `getSuggestions()`'s own cards, never the full pool, so the known bucket's per-player cap
  (7 Oct 2026, above) reaches it for free — fixing the shared selection once, in `suggest.ts`,
  rather than patching `nightly.ts` too.
- **The experiment engine runs between-video A/B tests unattended** (`src/dashboard/experiments.ts`
  + `experimentsEvaluator.ts`, 8 Oct 2026 — the operator's week goal: "get the YPP ETA back to last
  week's pace … the channel runs itself; I act only on what the 07:00 Warsaw Telegram report lists
  under 'Needs you'"). The data is `<mediaDir>/.experiments.json` (hypothesis, arms, a day-by-day
  `schedule`, and each experiment's `result`/`verdict`/`decision` once evaluated) — written
  atomically like `short-<id>.status.json`, read defensively like every other state file here;
  "tc" experiments (Studio's own Test & Compare, another branch) are carried through untouched.
  A tick inside the 15-minute cadence (`server.ts`), 30 minutes before `nightlyRenderHourUtc`,
  applies that night's schedule entry's `render` patch through `saveSettings` — the only way this
  ever changes a setting, and only real `SETTINGS` keys, an unknown one refused with one log
  line — and records `appliedOn` so a restart or the next tick does not re-apply the same day.
  `nextPublishSlot` (`src/youtube/publishSlot.ts`) takes a day's `slot.rankedHoursUtc` instead of
  the bare `publishHourUtc` for a **ranked** video only, never a series: sorted, first free hour
  wins, so a two-a-day cadence day is just `rankedHoursUtc: [15, 19]` plus a render entry
  `{ nightlyMaxRenders: 2 }`; no entry is the old single-hour behaviour, byte for byte.
  `shortPublishAt` (`src/dashboard/shortFlow.ts`) takes the long-form's publish day's
  `slot.shortDelayHours` (1–48) in place of the standing 18 h (`SHORT_DELAY_MS`,
  `src/youtube/youtubeUpload.ts`). A separate daily tick, same 15-minute cadence, evaluates every
  running "between" experiment once a UTC day (`evaluatedOn`): any arm under 1,000 impressions is
  "inconclusive", never a guess; CTR is a two-proportion z-test (`|z| ≥ 1.96`); a retention metric
  (average view %) reports the per-arm view-weighted mean and is "numbers only" unless every video
  of one arm beats every video of the other, 3+ a side. At the experiment's `end`, a winner with
  `adoptWinner` becomes the new default (`saveSettings`) and the decision is written with its
  numbers; otherwise the control arm's settings are reapplied, in case a render arm left something
  else live mid-run. Two evaluation failures in a row (a Reporting or Analytics API error) sets
  `needsHuman` rather than retrying silently forever. `/ask`'s knowledge (`src/telegram/
  knowledge.ts`) gets a generated "experiments-live" doc alongside `handbook/knowledge/*.md`, and
  the morning report's channel message gets one deterministic "🧪 Tests" line (running count,
  today's schedule, any verdict or decision since the last report) — see
  `handbook/knowledge/experiments.md` for the week's baseline and ledger.
  **Review fix, 8 Oct 2026**: `settle()` no longer marks an experiment `done`, or writes a
  `decision` claiming a setting took effect, when its own `saveSettings` throws (a typo'd key, a
  value `validateOverrides` rejects) — the failure now falls into the same `lastEvalFailure`/
  `needsHuman` retry path a Reporting/Analytics read failure already does, so the experiment stays
  `running` and tries again tomorrow instead of being frozen "done" on a change that never
  happened. `evaluateExperiments` is guarded against itself (`evaluating`, the same shape as
  `shortTick`'s `ticking`, `src/dashboard/shortFlow.ts`) since several experiments' worth of serial
  network reads can outlast one 15-minute tick; its final write also re-reads the file fresh and
  overlays only the experiments it touched, so a slow evaluation cannot clobber an `appliedOn` (or
  anything else) `applyScheduledRenderArm` wrote while it was still awaiting a response.
  `applyScheduledRenderArm` itself now returns whether `nightlyRenderHourUtc` was the key that
  moved (`SaveResult.rearmNightly`), and the 15-minute tick (`server.ts`) calls `scheduleNightly`
  when it does — the same signal `/api/settings`'s own PUT handler already acts on, since the
  nightly's pending timer computes its delay once at arm time and would otherwise keep firing at
  the stale hour for a night. `writeExperimentArmFile` files a chained render (`nightlyMaxRenders`
  > 1) that starts after UTC midnight under the night's own date — `appliedOn`, when it is within
  a day of now — rather than the wall-clock date it happens to start on, which can already be a
  different (or missing) schedule entry than the one actually applied. And `needsHuman` now
  reaches `gatherAlerts` (`needsHumanExperiments`, read from `src/telegram/facts.ts`) — the morning
  report's "⚠️ Problems" and Claude's own prompt — not just the on-demand `/ask` doc, since the
  operator said he acts only on what that report lists under "Needs you".
  **Two discovery fixes, 8 Oct 2026, needed before any of this can actually run unattended**: a
  day was carrying at most one `ScheduleEntry`, and nothing ever filled `exp.videos`, so a real
  cadence (the operator's own plan: "publish hour, the Short's offset, `explainMovesSec` on/off,
  `countdownTeaser`, `introSec`, alternating by day") had nowhere to put two experiments' worth of
  data on one date, and the evaluator above was evaluating an array that stayed empty forever.
  - **A date can now carry a render-arm entry and a slot-arm entry of *different* experiments at
    once** (`slotEntryFor`/`renderEntryFor`, `src/dashboard/experiments.ts`): the slot lookups
    (`rankedHoursForDate`, `shortDelayMsForDate`) take the date's first entry tagged `slot`; the
    render lookups (`applyScheduledRenderArm`, `writeExperimentArmFile`) the date's first entry
    tagged `render`. Either falls back to the date's first entry at all when none carries that
    tag, so a date with just the one entry — every shape on disk before this existed — resolves
    exactly as before, tag or no tag.
  - **The evaluator enrols `exp.videos` from disk before it evaluates anything**
    (`enrolVideos`, `src/dashboard/experimentsEvaluator.ts`, idempotent — checked by `matchId` per
    experiment, never duplicates, never removes): every match directory with its own
    `experiment-arm.json` (`writeExperimentArmFile`) enrols `{ matchId, arm }` into the render
    experiment it names, with `videoId` from `youtube.json` when the match has one by now — a
    match not yet uploaded is enrolled anyway and simply has no metrics to fetch until it is.
    Every long-form upload record (`youtube.json`, `kind: "video"`, never a Short) whose publish
    time (`publishAt`, else `uploadedAt`) falls on a date whose slot entry names a slot experiment
    enrols too, into the arm whose own `slot.rankedHoursUtc` is exactly that one publish hour
    (an hour-split experiment: two hours a day, each its own arm) when such an arm exists, else
    the schedule entry's own `arm`.
  **Review fix, 8 Oct 2026**: `evaluateExperiments`'s final write used to force-write a stale
  in-memory copy over *every* between experiment, not just the ones this run actually changed —
  widened from the old behaviour (only a `status: "running"` one, evaluated in the loop) by
  `enrolVideos` needing its own mutations persisted for a "done" or "planned" experiment too. A
  concurrent edit to one of those untouched experiments' *other* fields (`needsHumanAck`, from
  some future route) landing mid-run would have been silently reverted. Fixed by seeding `touched`
  from which between experiments' `videos.length` actually changed (plus whatever the running-loop
  itself touches, as before) — a "done"/"planned" experiment `enrolVideos` finds nothing new for
  is left to whatever the final fresh read holds for it.
- **Playoffs** (`src/playoffs/playoffs.ts`): the bracket (`/playoffs`) knows the series, not the games;
  the games are private-room matches (type 3) found in each seed's history, and the API stamps
  them with the season *after* the bracket's (a Season 11 bracket's games are season 12). **No
  surface prints a series score** — round and game number only, "Round of 16 · Game 2 of 5"; a
  1–0 going in is as much of a spoiler as the result, so the score is not even computed. A
  "Playoffs" section sits above the suggestions while a slot is within 14 days
  (`GET /api/playoffs`), and `playoffContextFor(match)` drives the title tail, the description
  paragraph, the intro line, the tournament playlist and the frozen season-end elo. The nightly
  puts detected games ahead of the suggestions only when the operator sets `playoffsFirst`
  (default **false** — it changes what tonight renders); a game whose players did not stream is
  skipped by `playoffVodsReady` and the pick falls through to the next candidate, because the
  pipeline's VOD guard throws before a match directory exists and nothing would remember it.
  Season 11's bracket (verified live, 10 Sept): the Round of 16 is **eight** slots over **two**
  evenings — Sat 12 and Sun 13 Sept, 17:00 Warsaw — so `playoffsFirst` wants to be on for both
  nights, not one. Quarterfinals onward carry `startTime: null` and no participants until the
  round below resolves; a slot with no participants matches no game, so such a game packages as
  an ordinary private match — the video is still made, it just loses the round/game framing until
  the bracket fills in (the 30-minute cache picks that up by itself). Two things S11's rooms did
  that the detection now allows for: the host joined game 13333220 as a *third player* and never
  left spawn (`withoutGhostPlayers` in `getMatch` drops a private room's extra seat with no
  timeline; `gameBelongs` tolerates the third seat since a feed entry has no timeline), and a
  forfeit nobody won is a room reset however long it ran (edcr–lauveer's 2:25 one was numbered
  game 3 of 6 under the old one-minute rule). The S11 bracket has **14** played series, not 15:
  the edcr–Feinberg quarterfinal was a walkover (`results[]` carries a `player: null` fifth).
- **A series is one video, and game 1's directory is the series** (`src/playoffs/series.ts`, 21 Sept
  2026). Each game is rendered by the pipeline unchanged — its own sync, overlay and intro
  card — and the exports are joined with `ffmpeg -f concat -c copy` (all exports are the same
  h264 1080p60/aac) into `series-<g1>.mp4`, which `findExportedVideo` prefers, so the upload,
  the kit and the pairing (game 1's `/matches/<id>` link first) work on game 1 as on any match.
  `series.json` beside it names the games and their lengths. Its chapters name each game's world
  ("0:00 game 1 · village seed", `seedPhrase`, as the tags do), never the bracket seed or a score.
  Each game's own split/Result chapters follow its header too (7 Oct 2026, `buildChapters`,
  `src/pipeline/chapters.ts`), offset to where that game starts in the joined video, and the
  whole merged list is re-filtered to YouTube's 10s minimum once more since a sub-chapter can
  land within that gap of its own header or of the next game's.
  **The join deletes the games'
  own exports** — a series is fifty minutes of 1080p60 and the disk holds one copy — and takes a
  game back out of the series (`-c copy` at its recorded offset, exact because every game
  starts on its own keyframe) whenever a re-join needs it. `exportStale` reads the record, so a
  sync fix on game 3 makes the series stale and names game 3; its Re-encode re-exports the game
  and the join follows (`startFastExport` settles through `assembleSeries`), the other games
  extracted rather than re-encoded. Games 2..n are hidden once joined; the series' head lists
  them (each has its own sync check). The Short
  is the best-scoring game's, copied in as `short-<g1>.*` with a description that links the
  series (`shortFromMatchId`); cut another game's by hand and `adoptSeriesShort` makes it the
  series'. The board's slot row shows what is exported / the run in flight / the joined video,
  and "Render the series" (`POST /api/series/:id/render`) runs the lot in the server; every
  export settles through `startFastExport` (the nightly's chain, Re-encode, a series run), and
  that is where a series joins itself once its last game's export lands. `PlayoffContext.score`
  (the going-in score) exists for the band's dots only — the description, the title, the board
  and the kit still print the round and the game number and nothing else, pinned in
  `playoffs.test.ts` and `series.test.ts`. Posting order is chronological (a Grand Finals
  title gives both semis away). The operator's calls, 21 Sept: chronological, ranked uploads
  keep going meanwhile, the dots as the official broadcast draws them.
- Phones (<= 860px): rows carry no Hide/Delete on a coarse pointer — the match screen's Manage
  fold has them; cards drop their splits chart only under 600 px, so a tablet keeps it. The
  playoffs board is folded at every width whatever the date (eleven series of game rows put the
  first suggestion 1,700 px down a desktop list); the summary line names the rounds and the next
  slot, and the fold stays open once opened across repaints.
- **Tonight's queue** (`queue` in `<mediaDir>/.dashboard.json`, `src/dashboard/matchShelf.ts`;
  `PUT /api/nightly/queue` takes the whole list): a card's "Queue for tonight" puts it ahead of the
  ranked pick, in the strip's order (↑ / ×); the nightly drops an entry the moment its render
  starts, and skips one that is processed, hidden or gone from the list (the run resolves it from
  the scan's pool or one `getMatch` first; the preview from the pool only, see Nightly). Queueing a match removes it from `nightlySkip` so an
  explicit queue always wins over a card's "not at night" toggle — and over the known-player gate:
  the operator's own pick is never second-guessed by a gate meant for the ranked list.
- **The NAS** (`//192.168.0.240/homelab`, CIFS, ~33 MB/s; 562 GB free on 1 Oct 2026): `/archive` is
  `tymek/mcsr-archive`, where `src/dashboard/archive.ts` copies published matches (a delete there
  is recoverable, `isArchived`); `/home-media` is the whole share (the operator's movies, music,
  backups — never touch them). **Transfers run only 03:00–08:00 Warsaw** (`inNasWindow`,
  DST-correct; the operator, 1 Oct 2026: "make the transfers to the nas only after 3am as it's a
  bit loud" — the disks are audible in the house): an automatic copy asked for outside it defers
  with one log line, a long queue stops when the window closes and the rest waits for the next
  night's sweep (`sweepArchive` in `src/dashboard/nightly.ts`, run before the render, for every
  upload the NAS does not have yet), and `isArchived` / the archive tier of `capacity()` are
  cached in memory so a polled GET never reaches the mount itself. `/home-media/mcsr-replayoffs/` is the pipeline's own NAS folder (the
  operator, 1 Oct: "create a directory there and use the space responsibly"): `vods/<id>/` holds
  known-player matches' VOD sections secured before Twitch's 14-day expiry (copy the folder to
  `/media/<id>/` to render one), `research/` the datasets behind reports, `backups/` anything
  replaced; at most 300 GB, every write a line in `ledger.jsonl`, README there. Free SSD space by
  archiving to the NAS first, not by deleting.
- `docs/` is the GitHub Pages site (`mcsr.sezamki.site`: the OAuth homepage, privacy and terms
  pages Google checks). `deploy/mcsr-claude.service` is the lab's systemd user unit for the
  Claude container. Only `~/.claude` is a persisted volume in that container: save loose ends
  inside the repo.

## Telegram bot

One morning report at `telegramReportHourWarsaw` (Settings has no field for it — a config-file
edit, like `nightlyUpload`), Europe/Warsaw, DST-correct; every slash command answers fresh, on
demand. Built 28 Sept 2026 (the operator's ask: "I want AGY to be the brain of it"); the brain
moved from agy (Antigravity) to Claude Haiku on 6 Oct 2026 — the Short picker keeps agy
(`src/shorts/reasoner.ts`, `src/shorts/videoPick.ts`); only this bot moved. Runs inside the
dashboard process (`server.ts` calls `startTelegramBot()`), over the Bot API's `fetch` calls
directly (`src/telegram/bot.ts`) — no dependency, long-polling `getUpdates`, no webhook, no port.

- **Secrets are `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `/app/.env`**, loaded the way
  `src/shorts/reasoner.ts` and `src/api/twitch.ts` do. No token: one log line, nothing runs. A
  token with no chat id: any `/start` gets "your chat id is N — add TELEGRAM_CHAT_ID=N to
  /app/.env and restart the dashboard" and nothing else — the pairing step (`npm run tg --
  whoami` does the same lookup from the terminal). With both, every update from any other chat is
  ignored silently. **Only one poller**: a test server (`PORT` other than 8080 — the "a test
  server arms its own nightly" pitfall applies here too) never starts it; a 409 from `getUpdates`
  means another process is polling and this one backs off rather than fight it.
- **A narrow command gathers only its own section.** `gatherFacts(nowMs, sinceMs, only)`
  (`facts.ts`) takes which sections to compute; `/report`, `/todo` and `/ask` want the full
  picture (Claude's prompt is richer for it) and pass none, but `/stats`, `/comments`, `/ypp`,
  `/waiting` and `/health` each pass their one section, so they skip the other five API round
  trips — including the live Claude ping `gatherHealth` makes, which only `/health` and `/alerts`
  (it folds a down API into its own lines) still pay for.
- **Claude Haiku is the brain, code is the facts** (moved off agy 6 Oct 2026). `facts.ts` gathers
  everything deterministically — every number, list and link in a report — and only the TODAY
  section's headline and ordered to-do list, and `/ask`'s answer, come from Claude through one
  small adapter, `src/telegram/claude.ts` (`runClaude`), called from `index.ts`. It spawns
  `claude -p --model claude-haiku-4-5-20251001 --output-format json --tools "" --strict-mcp-config
  --disable-slash-commands --no-session-persistence --setting-sources "" --system-prompt
  "<…>"` as a plain argv array (never a shell), `cwd` the OS temp dir and the prompt on stdin —
  never argv, so a knowledge pack can run ~70 KB without flirting with argv's own cap. No
  project CLAUDE.md, hooks, plugins or user settings load (`--setting-sources ""`, confirmed by a
  real run: an identical trivial prompt took ~2,100 input tokens without it, ~390 with it); auth
  still works because it comes from `~/.claude/.credentials.json` under `HOME`, not a setting
  source, and `HOME` is one of the four env vars (`PATH`, `HOME`, `LANG`, `TMPDIR`) in the child's
  short allow-list — never the Telegram token or any other secret this process holds.
  `--tools ""` and `--strict-mcp-config` give it nothing to call; `--disable-slash-commands`
  turns off skills. TODAY asks for **plain text**, not JSON: line 1 the headline (must not repeat
  a to-do item), then "1. …" items, parsed by `parseTodayPlainText`; `/ask` gets a few plain
  sentences back directly. Every prompt's system message says plain text only, no tools, every
  number copied from FACTS; **no viewer comment text or author name is ever put in a Claude
  prompt** (`/ask` included) — only counts, video titles and ids (`factsForPrompt`, `index.ts`).
  The user prompt opens with what the operator's day is (`CHANNEL_CONTEXT` in `index.ts`: save
  hooks, fix failures, keep every day scheduled, reply to comments; scheduled uploads are not
  chores) and gets times already in Warsaw local time (`whenWarsaw`), so the list reads as a
  plan, not the JSON. The adapter never retries — a limit, a timeout, a missing binary or no
  login all mean asking again right now gets the same answer (`describeFailure`, `claude.ts`);
  a limit reads **exactly** "usage limit reached — try again later" everywhere it can happen
  (the TODAY note and `/ask`'s whole reply, verbatim, nothing else), a missing binary says
  "binary missing in the container", no login says to run `claude setup-token` and put
  `CLAUDE_CODE_OAUTH_TOKEN` in `/app/.env`, and anything else is the adapter's own message.
  A failure (120 s timeout; a ping uses ~30 s) or an unusable answer falls back to a rule-based
  to-do list (`fallbackToday`) and the report shows that one-line reason under it.
  `/report`, `/todo` and `/ask` first answer "asking Claude (haiku) — this can take up to two
  minutes".
- **`/ask` also gets the channel's reports** (the operator, 29 Sept 2026: "give agy some knowledge
  about the channel competitors and such let it have access to reports you made so I can ask him
  questions without him reporting he doesn't know"). `handbook/knowledge/*.md` is in the repo because
  the dashboard container cannot see `~/.claude`: `channel.md` (the standing briefing, always sent
  whole), the competitor, audit, audience, YPP, edcr and Studio reports, and `chat-analyses.md`
  (what was answered in chat). `knowledgeFor` (`knowledge.ts`) sends the briefing, an index of
  every doc and the `## ` sections that share the most words with the question, best first, inside
  70 KB (sent to Claude over stdin, not argv, so there is no ~128 KiB cap to budget against —
  70 KB just keeps `/ask` answering quickly). **No viewer comment text or name goes
  into these docs** — they are paraphrased — and a figure carries the date it was read. Add a
  report by copying it in; a new answer worth keeping goes into `chat-analyses.md` or `channel.md`.
- **The report is three messages, each saying a thing once** (the operator, 29 Sept 2026: "too
  much repetitive info split it up into a couple messages"; `renderMorningReport` returns them):
  the day (**Needs you** at the top, then **Auto-saved hooks** below it, Claude's headline, which
  must not repeat a to-do item, and its numbered to-do list with one
  dashboard link; Problems only when there are any; overnight in a line when quiet; health as one
  line naming only what is down), the channel (live counts, then the 1/3/7/30-day stats as one
  `<pre>` table, a metric per row; YPP as the countdown and the gate holding it back — `tierEta`,
  a tier lands when subscribers AND watch hours-or-Shorts-views do), and the comments (grouped by
  video, each title once as hook · players, in a `<blockquote expandable>`, filled until the
  4096-character limit — `visibleLength`, the text Telegram counts after parsing the HTML). The
  full breakdowns stay one command away (`/health`, `/ypp`, `/alerts`, `/needs`). HTML parse mode rather
  than MarkdownV2: it renders the same bold/code/links/quotes and needs escaping of three
  characters, not eighteen, in viewers' comment text. Every dynamic string goes through `escapeHtml`.
- **"Needs you"** (`gatherNeedsYou`, `facts.ts`; `renderNeedsYou`, `report.ts`; the operator's own
  rule for the week of 8–14 Oct 2026, "I act only on what the 07:00 Warsaw Telegram report lists
  under 'Needs you'"): a deterministic section — code, not Claude — at the top of the day message,
  "Nothing today." when empty. Only six kinds, one line each, a deep link where there is a match:
  a failed `short-<id>.status.json` step (match, step, the error's first line) until the operator
  retries or re-saves; Studio signed out/needing verification/wrong channel
  (`<mediaDir>/.studio-probe.json`, the Studio automation's own file — absent is no item, read
  defensively); no long-form scheduled to go public in the next 48 h, naming both bare UTC days;
  a blocked runner in tonight's queue, rendered and not hidden, with an upload record, or as a
  comment's author newer than the last report (`isBlockedPlayer` against the display name — the
  line names the video or the match, never the comment's own text);
  `<mediaDir>/.experiments.json`'s `needsHuman` entries not yet `needsHumanAck`'d (the experiment
  engine's own file, another branch — also read defensively); and the standalone Studio worker's
  own heartbeat (`<mediaDir>/.studio-worker.json`, `studioWorkerItems`/`studioWorkerHealth`,
  `facts.ts`, 8 Oct 2026 — read defensively the same way, a type duplicated locally rather than
  imported from `studioWorker.ts`): a heartbeat over 90 min old is one item naming when it last
  beat and the restart command (`npm run -s studio -- worker --enable`, same as "Studio
  automation" below), and `WorkerHeartbeat.sameErrorStreak` (computed read-before-write in
  `runWorker`) at 3 or more is a second, independent item quoting that error's first line — both
  on the same file as `gatherHealth`'s own "studio worker" line (ok with the last cycle's time, or
  down); no file at all means the worker was never started, so neither fires. Below it, **"Auto-saved hooks"**
  (`renderAutoHooks`, `listAutoHooks`) lists the last 36 h of auto-hooks saves (see Dashboard, above)
  — never part of Needs you, since there is nothing left to act on unless the operator wants to
  change one before its upload — and is omitted entirely when empty. "Published" reads
  `AutoHooksRow.privacyStatus` (review fix, 8 Oct 2026), not just whether an upload record
  exists: the chain's own upload is a private, scheduled draft within minutes of the Short
  rendering, so `uploaded: true` alone was "published" on almost every row that ever reached this
  36 h window while it was still private — the row says "goes up `<when>`" until the record's own
  `privacyStatus` is actually `"public"`. Both cap themselves to a
  share of the 4096-character message (`NEEDS_YOU_BUDGET_CHARS`/`AUTO_HOOKS_BUDGET_CHARS`) rather
  than trusting the day to stay short by luck. `/needs` answers the Needs-you section alone, fresh,
  on demand (the narrow-command pattern above); it goes into Claude's own FACTS too
  (`factsForPrompt`), so the to-do list agrees with it rather than inventing its own reasons.
- **A link about one match opens that match.** `public/app.js` routes `#match=<id>` once the list has
  loaded and on `hashchange` (`openLinked`: the match on Now, Rendered under it; an id the list lacks
  is the list, quietly), and `syncHash` keeps the address naming the match on screen
  (`replaceState`: a reload keeps it, leaving clears it, no history entry). A report links a match as
  `<dashboardBaseUrl>/#match=<id>` (`matchLink`: `/waiting` rows, any `#<id>` in a to-do item, the
  nightly's last run, each overnight upload and each upcoming row; queued and "not at night" ids and
  the "Worth rendering today" ids stay text, since the route opens only rendered matches) and
  the list as the bare base URL (default `http://actimel:8080`, the lab's own address — the
  Clipboard API pitfall). `deep-link-check` pins the route.
- **Dedupe is `<mediaDir>/.telegram.json`**, written atomically (write-then-rename, as
  `.dashboard.json` and `short-<id>.status.json` are): the Warsaw date the report last went out
  on, its instant (what "overnight" and "since the previous report" mean throughout), the
  previous live channel snapshot (subs/views/videos, for `/stats`'s "+N since last time"), and
  Telegram's own update cursor. A restart that missed 07:00 still sends the report if it is
  before 10:00 Warsaw and today's date is not already recorded — `shouldCatchUp` in
  `schedule.ts`. A test server never runs the scheduler at all, so it cannot race the real one's
  write.
- **`/stats` reuses `src/youtube/yppProgress.ts`'s Analytics call shape**, not a second
  implementation: one `dimensions: "day"` request over ~62 days
  (`views,engagedViews,estimatedMinutesWatched,subscribersGained,subscribersLost,likes,comments`),
  aggregated in code into the four windows (`windowStats.ts`) against the equal-length window
  immediately before each — never a 30-day window compared to a mostly-empty 30 days before launch
  without saying so (`currentDays`/`previousDays` note a short window). Says which day the data
  ends on; Analytics lags 1–3 days.
- **`/comments` is `commentThreads.list allThreadsRelatedToChannelId=<channel>`**
  (`channelCommentThreads`, `src/youtube/youtube.ts`; own-channel read only, 1 unit), not the
  per-video `commentThreads` the publish kit's pinned-comment check uses. Unanswered = not the
  channel's own top-level comment and no *returned* reply is the channel's either;
  `repliesTruncated` flags a thread whose `totalReplyCount` exceeds what the API returned and
  none of those were the channel's — genuinely uncertain, not counted as answered on a guess. Up
  to 8 shown, newest first, each with the exact-comment link (`&lc=<id>`) and the video's Studio
  comments page; the inbox link covers the rest. **Every YouTube link the bot sends opens Studio,
  never the public watch page** (8 Oct 2026, the operator's ask — the bot is for managing the
  channel, not watching it): the exact-comment link is `studio.youtube.com/video/<id>/comments?lc=<id>`
  and the overnight section's "video"/"Short" links are `studio.youtube.com/video/<id>/edit`.
- **"Worth rendering today"** (`src/telegram/worth.ts`, in the day message and `/worth`): the
  roster's (`favouritePlayers`) ranked matches of the last 3 days with both Twitch VODs, not on
  disk or on the channel, scored by lead changes and the finish gap, at most five lines with the
  match id in `<code>` (those ids are not in the rendered list, so no deep link). 6 list calls and
  at most 8 match calls per gather, VOD listings only for empty slots, a 120 s deadline, cached
  6 h in `.telegram.json`; `/worth` gathers fresh.
- **`/health` pings Claude for real** (a live `runClaude` call, named "claude (haiku)", ~30 s
  timeout — not just the last report's outcome), and `/alerts` folds the same ping's failure into
  its own lines. DNS timing flags `api.mcsrranked.com` over 1 s (the Tailscale DNS incident of
  27 Sept 2026).
- **The dashboard container needs its own login.** The image already has the binary (`Dockerfile`:
  `npm install -g @anthropic-ai/claude-code`), but the `mcsr-dashboard` service mounts no login for
  it — `claude.ts`'s auth comes from `~/.claude/.credentials.json`, which only exists where someone
  has signed in, and from `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` if either is set (the only
  two secrets in the adapter's own env allow-list besides `PATH`/`HOME`/`LANG`/`TMPDIR`). The
  operator runs `claude setup-token` once, in the `mcsr` container's tmux (a Claude subscription —
  separate from agy's Antigravity/Gemini one, which the Short picker keeps), adds
  `CLAUDE_CODE_OAUTH_TOKEN=<the token>` to `/app/.env`, and restarts `mcsr-dashboard` — until then
  every Claude call in the bot fails "auth" and `/health` says so.
- **Reports reach Telegram because they are sent, not by a hook** (the operator's ask, 28 Sept: "All
  reports made in this chat should also be forwarded there for safekeeping"; then 29 Sept: "not
  every message should be on telegram"). A session writes the report to a file and runs `npm run
  tg -- send --md <file>` (`src/telegram/markdown.ts`: headings and bold, code, links, bullets, a
  table as an aligned `<pre>`; cut between paragraphs, never inside a code fence; a piece Telegram
  will not parse goes again as plain text). What counts as a report: the end of a finished task
  (what was built, merged, published, uploaded), a research or analysis write-up, an artifact's
  link. Not: an answer to a quick question, a progress note, a question to the operator. A Stop
  hook forwarded every end-of-turn message of 300+ characters for a day; it was removed for that.
- **What is not built**: `youtubeUploadEnabled`-gated actions, renders, queue edits — every
  command is read-only, and `/help` says so. No command writes anything the dashboard would show
  as changed.

## Studio automation (phase 1, 7 Oct 2026)

Does what Studio has no API for, starting with pinning a video's own first comment. The operator,
7 Oct 2026, after reading the plan (`handbook/knowledge/studio-automation-plan-2026-09-28.md`) and
asking "will it lock the whole account like ban it or what": a separate Google account added as
an **Editor** of the channel (Studio → Settings → Permissions), not the owner, with 2FA on, is the
recommended way to run this — it keeps the owner account out of the blast radius of anything
Google's anti-abuse systems do to a container-run browser. Off by default
(`studioAutomation`, like `nightlyUpload` and `youtubeUploadEnabled`: not writable from the
Settings tab, a deliberate edit on the box) and phase 1 only — pinning, nothing else of the full
plan's phases 2-4.

**How it works** (`src/youtube/studioBrowser.ts`): a real, headed `google-chrome-stable` on a
virtual Xvfb display, with a login profile saved in the `studio-profile` volume. Automation
connects to that already-running Chrome with Playwright's `chromium.connectOverCDP` — **never**
`chromium.launch()`, which stamps a browser with its own automation markers. Nothing here ever
types a password, answers 2FA, solves a CAPTCHA, or opens accounts.google.com on its own; the
operator signs in by hand, over a remote screen, whenever Google asks. `probe()` classifies the
session (`ok` / `signed-out` / `verify` / `wrong-channel`) at the start of every Studio job; a
`verify` or `signed-out` result is recorded as that attempt's error and chased no further until
the operator logs in again — not retried in a loop.

**Setup**, in order:

1. Rebuild the image (`google-chrome-stable`, `x11vnc`, `novnc`, `websockify` are new Dockerfile
   layers) and recreate the `dashboard` service so it picks up the `studio-profile` volume.
2. Set `STUDIO_VNC_BIND=<your Tailscale IP>` in `/app/.env` — compose reads the project's `.env`
   for substitution — so the login screen's port (6080) binds there instead of `127.0.0.1` only.
   **Never set it to `0.0.0.0`**: the dashboard's own port (8080) is already LAN-reachable by
   design, and port 6080 is the one thing standing between that and an interactive, already
   signed-in Google session. Optionally also set `STUDIO_LOGIN_SECRET=<any string>` — unset (the
   default) leaves the three `/api/studio/*` routes exactly as unauthenticated as every other
   dashboard route; set, a request without the same string in an `x-studio-secret` header is
   refused before it starts a browser or returns the one-time VNC password, which matters more
   here than anywhere else because 8080 is reachable from the whole LAN even when 6080 is not.
3. Turn on 2FA on the account that will sign in (phone prompt primary, an authenticator app
   backup, printed backup codes) before the first login — see the plan's section 1a.
4. **YouTube panel → Studio login**: opens a one-time URL and an 8-character password good for
   15 minutes. Open it on the Tailscale IP, sign in by hand, approve 2FA, wait for Studio's own
   channel to load, then press **Done** — it probes the session and stops the screen.
5. Test on an unlisted video you name: `npm run studio -- pin <matchId|videoId> --dry-run` opens
   the confirm dialog and screenshots it without ever clicking the final Pin.
6. Only then set `studioAutomation: true` on the box.

**Safety rails**: never types a password or touches 2FA; never unpins, replaces, or removes a pin
someone set by hand — `pinComment` (`src/youtube/studioActions.ts`) checks for an existing "Pinned
by" line first and returns `"already-pinned"` rather than touch it; one browser at a time, an
in-process lock claimed synchronously before Chrome ever spawns (`starting`, `src/youtube/studioBrowser.ts`
— a login and a probe pressed back to back must not race into two Xvfb/Chrome pairs) plus the
profile's own `SingletonLock`; at most 10 Studio actions per nightly tick (`retryPendingStudio`,
`src/youtube/youtubeUpload.ts`), each with a random 2-6 s pause between clicks; a `verify` probe is
never retried within the same call — nothing about the session changes until the operator logs in
again. **The nightly's own retry tick** waits while an `export:fast` is running, since Chrome and
ffmpeg share the lab's four cores (`anyExportRunning`, `src/dashboard/nightly.ts`) — a manual press
(Finish on YouTube, Adopt) does not wait on that check, since those are the operator's own
occasional presses rather than a background loop; a rare moment of contention there is accepted
rather than given its own gate. The pin step itself only ever runs after the comment it is pinning
has actually posted and the video is re-confirmed public live (`finishOnYouTube`, same reason the
comment step re-checks). A login screen a crash or restart left open (Chrome, x11vnc, websockify
all survive a dashboard restart as orphans — tini reparents them) is swept at the next boot
(`killOrphanedLoginScreen`, `src/dashboard/studioLogin.ts`): the x11vnc/websockify pids are written
to a pidfile in the profile dir while the screen is open and checked against `/proc/<pid>/cmdline`
before being signalled, so a pid a fresh container happens to reuse for something else is never
touched on a guess. `npm run studio -- probe | pin <id> [--dry-run] | login [--profile-dir=<path>]`
drives all of this from the terminal; `--profile-dir` points any of the three at a throwaway
profile instead of the real login.

### Phase 2/3: end screens and Test & Compare (8 Oct 2026)

Built from a read-only exploration of the real UI the same day (no Save/Start/Publish pressed —
see `s7r-*`/`lui-*` in that run's own `tmp/studio2/`): `addEndScreenFromTemplate`, `startTestAndCompare`
and `readTestAndCompare` (`src/youtube/studioActions.ts`), a standalone loop (`src/youtube/studioWorker.ts`,
`npm run studio -- worker [--once] [--dry-run]`), and a plan importer (`npm run studio -- tc-plan
<plan.json>`, `src/youtube/studioExperiments.ts`). **Nothing here has run against the real channel** —
every check above is a fixture page or pure logic; see "What is verified live vs only on fixtures" below.

- **One gate still covers all of it.** The worker checks `config.studioAutomation` itself, the
  same flag phase 1's `retryPendingStudio` reads — off, every cycle is a no-op recorded as
  `"skipped"`. The task that asked for this loop framed it as living outside the dashboard
  entirely (Chrome is only installed in this container, not the dashboard image yet) and did not
  mention the flag, but turning a real Chrome loose on the channel's own Google account is
  exactly what `studioAutomation` already exists to gate — a second, ungated path to the same
  browser would make that switch a lie. Starting the worker for real (`nohup npm run studio --
  worker &`) still needs `studioAutomation: true` on the box, the operator's own deliberate edit,
  same as phase 1 ever did.
- **Never runs 02:50–04:30 UTC** (`inBlackoutWindow`) — the nightly render's own window, Chrome
  and ffmpeg sharing the lab's four cores. One browser session per cycle, ~20 min apart (± 3 min
  jitter), human-paced clicks inside it (the same `randomPause` phase 1 uses). At most 3 end
  screens and 2 new Test & Compare starts a cycle; a running test is read once a day by UTC
  calendar date. A ledger (`<mediaDir>/.studio-ledger.json`) remembers which videos already have
  the template so a restart does not re-import; a heartbeat (`<mediaDir>/.studio-worker.json`)
  records `{ pid, at, lastCycle, lastError, lastErrors, sameErrorStreak }` — `sameErrorStreak`
  (read-before-write in `runWorker`, 8 Oct 2026) counts how many cycles running have now ended
  with this exact `lastError` — so the morning report's "Needs you" can notice both a dead process
  (`at` over 90 min old) and a standing error (the streak at 3+) without keeping its own history
  (`studioWorkerItems`/`studioWorkerHealth`, `src/telegram/facts.ts`).
- **Every Test & Compare title is checked before any page opens** (`titleTestProblem`, exported
  from `studioActions.ts`, reused by the plan importer so a title that could never start is never
  even planned): `hookProblem` (which already finishes with its own `hookLabelProblem` call),
  `hookLabelProblem` again directly, `spoilsTheResult` against the whole line, and the
  100-character ceiling. A thumbnail test's 2-3 files just need to exist on disk. Any refusal is
  returned before `startTestAndCompare` ever calls `page.goto`, pinned by a unit test that passes
  it a handle which throws if its `browser` property is ever read.
- **`npm run studio -- tc-plan <plan.json>`** turns a judge's approved plan (thumbnails[]/titles[])
  into planned `"tc"` experiments in `<mediaDir>/.experiments.json` (the dashboard's not-yet-merged
  experiment engine's own file — `src/youtube/studioExperiments.ts` only ever reads the whole file
  and writes `kind: "tc"` entries back, read-merge-write, atomic write-then-rename; a `kind:
  "between"` entry or any field it does not know about is never touched). Deterministic ids
  (`tc-thumbnail-<videoId>`, `tc-title-<videoId>`) are the whole idempotency mechanism — running it
  twice on the same plan adds nothing the second time. A pose-challenger file under `<id>/tc/tc-pose.png`
  is rewritten to its strip equivalent (`<id>/thumbnail.<pose>.png`, the pose read out of the plan's
  own note) because another job re-renders `tc/*.png` the same night; `tc-control.png`/`tc-caption.png`
  pass through unchanged — nobody asked those to move, and there is no strip equivalent for either.
- **The worker never sets a Test & Compare winner itself** — `readTestAndCompare`'s `"done"` state
  only ever records what it read off YouTube's own page (the live title/thumbnail it already
  applied). A `"needsHuman"` note lands on the experiment for anything `startTestAndCompare`/
  `readTestAndCompare` could not get past (a refused title, an unreadable page), and the worker
  never guesses past an ambiguous state on its own.

**What is verified live vs only on fixtures.** Confirmed against the real Studio UI, 7–8 Oct 2026:
`#endscreen-editor-link`, the "Import from video" button, `ytcp-video-pick-dialog` and its
search-then-"No matching results" behaviour (a confirmed *bug* on this profile — the picker's own
search call resolves against the operator's personal channel, not the brand one, so it returns
zero results for every query tried, including the raw template id, an empty query and the
template's exact title; `addEndScreenFromTemplate` reports this as its own `"picker-empty"`
outcome rather than guessing past it — **every attempt at a real end screen hits this today**,
operator-side account/permission fix needed before phase 2's end-screen half can do anything),
`#ab-test-button`, the "A/B Testing" dialog, its three mode chips (`#chip-0`/`#chip-1`/`#chip-2`),
`#set-test-button`. **Two live corrections, 8 Oct 2026** (both were guesses the first live run
proved wrong, not corner cases — both are fixed in code and in the fixture, which was wrong the
same way): the End Screens editor is a full panel with **no `aria-label="Close"` element at all**
(the two such elements anywhere on the page are hidden and belong to unrelated Studio dialogs) —
`addEndScreenFromTemplate` now waits on the confirmed "Discard changes" button instead, its own
real open/cleanup signal; and the A/B Testing dialog's own element is
`ytcp-creator-experiment-create-dialog`, not `ytcp-ab-test-dialog` (that tag does not exist on the
page — the original selectors for its title/thumbnail fields matched **zero** elements, so a real
run would have clicked Set test with nothing filled in). Confirmed live instead: title fields are
`[contenteditable="true"]` divs by `aria-label="Add title N"` (`Locator.fill()` does work on them,
verified), not `<input>`; thumbnail fields are real `<input type="file">` (3, `accept="image/jpeg,
image/png"`, under `ytcp-thumbnail-uploader`, scoped to the dialog root so this can never reach the
Details page's own separate thumbnail input sitting just outside it); slot 1 of both is pre-filled
from the video's live title/thumbnail already, so only the challenger slot(s) strictly need
filling (`startTestAndCompare`'s title path already only fills from slot 2 on; its thumbnail path
also fills slot 1 with the caller's own control file, redundant but harmless — same bytes already
showing). The A/B Testing dialog's `Close` button (not Escape) is confirmed the reliable way to
leave it. **A third live correction, the real one that mattered**: `#set-test-button` only
*stages* the test inside the dialog — a banner reads "The test is ready and will start once you
save your changes" — and nothing actually starts until the Details page's own `#save` button
(`SELECTORS.pageSaveButton`, the same one that saves a title/description edit) is pressed too. The
first live attempt skipped this: `startTestAndCompare` returned `"started"` with no error, its
screenshot showed a closed dialog, and nothing had actually happened — reopening the video later
showed a blank, unset A/B Testing form again, exactly as if nothing had run. `startTestAndCompare`
now clicks `pageSaveButton` and waits for "Changes saved" after `#set-test-button`, confirmed live
against the channel's actual first real Test & Compare (LUI5E7yF0zE, thumbnail-only, started 8 Oct
2026 — Studio's own report showed "Test running… · Estimated time remaining: 13 days 23 hours").
**`readTestAndCompare`'s `"running"` is now confirmed live too** (read against that same test,
right after it started) — only `"none"` and `"running"` are confirmed; `"done"`'s guess at the
word "winner" still needs a test to actually finish. **Still unverified, built against synthetic
fixture pages instead** (`studioActions.test.ts`, excluded from `test:unit`, run by `npm test`):
which row to click once the picker actually returns a result (no query ever has, on this profile —
see above), and whether `abTestSetButton`'s mere visibility (true even before a chip is chosen,
confirmed 8 Oct) is actually a reliable "no test already running" signal rather than just "the
dialog opened". Confirm the picker row the day the account-scoping bug is fixed, and the "already
running" signal against a second video while LUI5E7yF0zE's own test is still live.

**Related video — the plan's own second half of phase 2, confirmed dead-end today, 8 Oct 2026**
(read-only exploration, `tmp/studio3/`, no Save ever pressed — see the plan's section "Phase 2:
the Short's related video and end screens"): a Short's Details page carries its own "Related
video" control in the right-hand metadata column, between Visibility and Subtitles —
`ytcp-text-dropdown-trigger#linked-video-editor-link` (`SELECTORS.relatedVideoTrigger`), reading
"None" until something is linked. Clicking it opens the *exact same* `ytcp-video-pick-dialog`
the end-screen "Import from video" fallback above already drives — same search input, same
"No matching results" text, confirmed live by searching the exact match title ("Infume vs
Feinberg") and the exact long-form video id (`vASY6MzFRNM`) against the Short `k9m6lFIRs0g`:
both came back empty, and both videos independently confirmed genuinely public (not
private/scheduled, which would be a different, expected empty) via YouTube's own unauthenticated
oembed endpoint. This is the same account-scoping bug already confirmed for the end-screen
picker, not a second, separate one — the network capture shows the identical
`youtubei/v1/creator/list_creator_videos` call resolving against the signed-in account's default
(personal) channel rather than the brand one. `checkRelatedVideoPicker`
(`src/youtube/studioActions.ts`) only ever checks and reports, by design: it never clicks a
returned row or presses the page's own Save, because no search here has ever returned one to
confirm those selectors against — guessing at either now would be exactly what
`endscreenPickerRow`'s own doc comment already warns against doing twice. Already linked to
*anything* (not just the target long-form) is left alone and reported `"already-linked"` without
ever opening the dialog, the same "never replace what's already set" rail `pinComment`/
`addEndScreenFromTemplate` keep. `npm run studio -- related <shortId|matchId> <longFormVideoId>`
drives it from the terminal (no `--dry-run`: there is nothing destructive to stop short of yet).
Build the real click-and-save the day a search anywhere in Studio actually returns a row to
confirm against — the account-scoping fix, or signing in as an account whose default channel
already is the brand one.

**Review fixes, 8 Oct 2026** (branch `studio-p23`): `studioCli.ts`'s own `startAndProbe` used to
call `start()` then `probe(handle)` with no try/catch of its own, trusting a caller's later
`try { ... } finally { await handle.stop(); }` around the handle it would *return* — but a `goto`
timeout or crashed renderer inside `probe()` threw straight out of it first, before any handle
reached that finally, leaking Chrome+Xvfb and holding the profile's `SingletonLock` until
something killed it by hand (wedging every later Studio job, the unattended worker's own cycles
included, on "Chrome is already running against \<profile\>"). The fixed version now lives in
`studioBrowser.ts` itself (`startAndProbe`, injectable `start`/`probe` for a real unit test,
`studioBrowser.test.ts`), stopping on a throw the same way it already did on a non-`ok` result;
`studioCli.ts` wraps it only for the console/exit-code text, read back off `readLastProbe()`.
`inBlackoutWindow` read two hardcoded constants (02:50-04:30 UTC) instead of
`config.nightlyRenderHourUtc` — a Settings-tab change to the render hour, or a chained render
under `nightlyMaxRenders` running past 04:30, could desync the two and let Chrome and ffmpeg
contend for the lab's four cores after all. It now derives the window from the live config value
(10 min lead-in through the 4h chain window `nightlyMaxRenders` can use plus a 30 min finish
buffer — 02:50-07:30 at the default hour; `null` disables the blackout with the nightly).
`endscreenSaveButton`/`endscreenDiscardButton` were a plain `button:has-text("Save")`/
`"Discard changes")`, picked with `.first()` with nothing to say *which* "Save" that would
resolve to on a page the end-screen editor shares with the Details page's own `#save` — rereading
the 7 Oct exploration's own raw DOM dump (`s7r-endscreen-open.json`) found the answer already
sitting in it: the page's two "Save"-labelled `<button>`s are each wrapped in a `ytcp-button` with
its own id, `#save` (page-level, confirmed as `pageSaveButton`) and `#save-button` (the editor's
own, paired with `#discard-button`) — and in DOM order the page-level one comes *first*, so
`.first()` would have clicked the wrong button the moment a real end screen ever got this far.
Both selectors are now the confirmed ids; `studioActions.test.ts`'s fixture was reordered to match
the real page's own DOM order (page `#save` before the dialog) specifically so a reversion to the
old text-based `.first()` guess fails the test instead of passing by the fixture's own coincidence.
The worker's `"picker-empty"` outcome (the account-scoping bug, confirmed daily) was invisible on
the heartbeat — `endScreensAdded: 0` with no error looked identical to "nothing to do" — and retried
every ~20 min cycle for as long as the bug lasts, screenshotting each time; `.studio-ledger.json`
now also tracks `pickerEmptySeen` (once-a-day retry, same shape as a Test & Compare's own daily
check) and the heartbeat's `lastCycle.endScreenPickerEmpty` makes the standing bug visible rather
than silent. `writeHeartbeat` kept only `errors[0]`; it now also carries the whole cycle's
`lastErrors`. `.experiments.json`'s read-merge-write (`updateTcExperiments`) is reached from two
separate OS processes — this worker's own cycles and a one-off CLI invocation run alongside it —
unlike the rest of this codebase's read-merge-write files, which lean on "there is only ever one
dashboard process"; unguarded, two concurrent writers did not just lose an update, they crashed
outright (`writeExperiments`'s shared `.experiments.json.tmp` name means the second caller's own
`rename` hits an `ENOENT`, confirmed by temporarily removing the lock and running
`studioExperiments.test.ts`'s new concurrency check). `updateTcExperiments` now serializes through
a `wx`-flag lockfile (`withExperimentsLock`, `.experiments.json.lock`, stale after 30 s) — a plain
mutex, not a true cross-platform advisory lock (ponytail: good enough for two cooperating
processes on one filesystem; it only ever guards callers that go through *this* module.
`src/dashboard/experiments.ts` — merged into `main` 8 Oct 2026, its own sync `readExperiments`/
`writeExperiments`, running in the dashboard's own container against the same bind-mounted
`/media` — does not take this lockfile at all, so a dashboard tick and a worker cycle writing
`.experiments.json` in the same instant can still race each other; upgrade both sides to a real
lock, or have the dashboard honour this one too, if that ever actually bites).

### Phase 4: the worker drives itself (8 Oct 2026)

From the operator's own /goal that day: "the automation lives in the dashboard code, not this
session: when the usage limit hits, the channel keeps running" and "Studio: one browser session,
human-paced. On any sign-in or verification prompt, stop and add it to 'Needs you'. Never retry a
login." Six fixes/features on top of phase 2/3, all in `studioWorker.ts`/`studioActions.ts`/
`studioExperiments.ts` unless named otherwise:

- **`.experiments.json`'s read-merge-write no longer drops data** (`studioExperiments.ts`'s own
  `readExperiments`/`writeExperiments`): they used to reconstruct the file as `{ experiments,
  schedule }` only, silently losing `baseline`, `appliedOn` and `evaluatedOn` — the experiment
  engine's own once-a-day guards (`src/dashboard/experiments.ts`, merged into `main` 8 Oct 2026) —
  on every single `tc`-plan or worker write. They now carry the whole parsed object through
  (spread, with `experiments`/`schedule` validated as real arrays), rather than importing the
  engine's own stricter `ExperimentsFile`/`Experiment` types directly: those require
  `hypothesis`/`metric`/`start`/`end` on every `Experiment`, which a `tc` entry never sets, so
  importing them here would stop `planTcExperiments` from type-checking at all. Pinned by a direct
  round-trip test and a read-merge-write test asserting a `between` entry survives byte-for-byte.
- **The worker's own gate is no longer `config.studioAutomation` alone.** That flag also switches
  on the *dashboard's* own Studio paths (`retryPendingStudio`), and the dashboard container has no
  Chrome at all — it must stay `false` there. The worker (`runCycle`/`runWorker`) now gates on
  `opts.enable` — the CLI's own `--enable`, or env `STUDIO_WORKER=1` for a `nohup`'d session that
  cannot pass a flag after the fact — OR'd with `config.studioAutomation`: `npm run studio --
  worker --enable &` (or `STUDIO_WORKER=1 nohup npm run studio -- worker &`) is the operator's own
  browser-automation grant exercised directly, by a session in *this* container, not a second,
  ungated path to the same browser the dashboard's flag was built to gate. Without either, a cycle
  is still a no-op recorded as `"skipped"`, same as before.
- **End screens apply the starter layout instead of importing** (`addEndScreenFromTemplate`,
  `clickStarterLayout`/`pickStarterLayoutLabel`, `STARTER_LAYOUT_PREFERENCE`): the empty editor's
  own gallery (`lui-endscreen-text.txt`, read live 8 Oct 2026) is tried first — the card closest to
  the operator's own template (2 VIDEO + 1 CHANNEL/subscribe elements), "2 videos, 1 subscribe",
  else "1 video, 1 subscribe" — clicked, saved (`saveEndScreenChange`, waiting for the same
  "Changes saved" confirmation `startTestAndCompare` already waits for), confirmed saved. "Import
  from video" is kept only as a fallback for the day the picker's own account-scoping bug (phase
  2/3's own finding) is fixed and a search actually returns rows — on the real gallery read live,
  no card reads "2 videos, 1 subscribe" outright (the two "2 videos" cards there carry no
  subscribe element at all) but three read exactly "1 video, 1 subscribe", so every real attempt
  today takes that second preference and the Import fallback is not reachable in practice: the
  same exact text is both the "editor is empty" signal (`endscreenEmptyGallery`) and a valid,
  clickable starter card, so an empty editor always has *something* for `clickStarterLayout` to
  find. Kept anyway — a channel or locale where that is not true picks up the fallback with no
  code change.
- **Title tests use exactly one challenger** (`planTcExperiments`'s title branch): Title-only
  mode's own dialog has only one challenger slot (live + 1, confirmed live in phase 2/3), so a plan
  whose variants had more than one survive `titleTestProblem` used to be planned with an arm
  `startTestAndCompare` has no slot to fill. Now only the *first* variant to pass becomes the
  challenger; every variant is still checked and a failing one still logged as skipped, but a
  passing one past the first is simply not used (and not logged — there is nothing wrong with it,
  it just was not needed).
- **The worker plans a thumbnail Test & Compare on every new long-form by itself**
  (`planCycle`'s `thumbnailTcTargets`, `renderTcThumbSet`, `AUTO_CAPTION_MAX_CHARS`): a dashboard
  upload (`UploadRecord.source === "dashboard"`, never a Studio upload or a Short), uploaded on or
  after 8 Oct 2026, not blocked (`blockedIn(povNicknamesOnDisk(matchDir(matchId)))`, the same
  disk-only check every other Studio action already uses), with no `tc` experiment of its own yet
  of either kind — capped at `MAX_THUMBNAIL_PLANS_PER_CYCLE` (2) a cycle. For each one the worker
  shells out to the existing `npm run tc-thumbs` (reused, not reimplemented, the same way
  `startFastExport` shells out to `export:fast`) to render control + the most-different
  non-result-looking pose + a caption when `tcCaption.ts`'s own checks pass it, then keeps the
  caption arm only when it is `AUTO_CAPTION_MAX_CHARS` (6) characters or fewer — tighter than
  `tcCaption.ts`'s own 9-character ceiling, since nobody judges this one before it goes live, unlike
  the manual `tc-plan.json` flow a human approves first. The render touches no Studio page, so it
  needs no browser session, but still runs only inside the same cycle the worker's own blackout
  window (`inBlackoutWindow`) already excludes, and is skipped entirely under `--dry-run` since
  the render and the `.experiments.json` write are the whole action, with no later "stop before
  the final click" point to fall back to. Planning a `tc` experiment never starts it in the same
  cycle — the next cycle's own `tcToStart` picks it up, same as any manually-planned one.
- **A video already running a test in Studio is reconciled, never started twice**
  (`setExperimentChecked`, now also called from the `tcToStart` loop before ever calling
  `startTestAndCompare`): `LUI5E7yF0zE` itself is the reason this exists — its live thumbnail
  Test & Compare was started 8 Oct 2026 by a direct `npm run studio -- tc` CLI press, before any of
  this bookkeeping existed, so `.experiments.json` has no record of it at all. If a future cycle's
  own auto-thumbnail planner (or a hand-written `tc-plan.json`) ever names that same video,
  `readTestAndCompare` is checked first; a `"running"` or `"done"` answer promotes the
  experiment straight to that status (with a `start` timestamp if it did not have one yet) instead
  of calling `startTestAndCompare`, which Studio would refuse anyway ("a test may already be set
  up"). `setExperimentChecked` itself was the fix: it used to leave a `"planned"` experiment's
  `status` untouched on anything short of `"done"`, so this reconciliation path would have silently
  stuck at `"planned"` forever rather than ever being picked up by `tcToCheck`'s own
  `status === "running"` filter.
- The tc-plan importer's `tc/` files are now treated as final, judged renders in every case — the
  one-off `tc-pose.png`→strip-file rewrite `planTcExperiments` used to do for a single night's plan
  (whose `tc/` files were about to be re-rendered out from under it) is gone; every thumbnail
  variant path, from a human judge's plan or the worker's own `tc-thumbs` render, is used exactly
  as given.

**Review fix, 8 Oct 2026**: `renderTcThumbSet`'s `npm run --silent tc-thumbs -- <id>` is really
`npm run build-overlay-css && tsx src/thumbnails/tcThumbs.ts`, and `build-overlay-css.mjs`'s own
`console.log("remotion/overlay.css written (…)")` landed on stdout *ahead of* tc-thumbs' own final
JSON line — every single time, not a corner case — so `renderTcThumbSet`'s `JSON.parse` of the
whole captured stdout threw on every real invocation, silently breaking the headline
auto-planned-thumbnail-test feature (it still failed safe, reaching `errors`/the heartbeat, just
never actually planning anything). A human running `npm run tc-thumbs` by hand never noticed,
since a terminal shows the extra line fine. Fixed at the root: that status line now goes to
`console.error` — every other `npm run build-overlay-css && …` script in `package.json` only ever
shows it to a human, nobody else parses its stdout as data.

## Clips (prototype)

For a video that is not a match — a stream statement, a reaction, something worth posting on the
channel on its own (built 29 Sept 2026 for Feinberg's on-stream statement on the edcr situation).
`remotion/ClipFrame.tsx` is the reusable frame: a title band, the channel's quartz-bordered plate
around a 16:9 window (`CLIP_WINDOW_*`, `remotion/layout.ts`), a nameplate and credit line, the
MC/SR badge — exactly the thumbnail/overlay look, never a new one. `npm run clip` is the one
command: it gets the source (yt-dlp for a Twitch URL, `--from`/`--to` trims a VOD section; a
already-downloaded file is used as-is), renders the frame, and composites both with ffmpeg into
`<mediaDir>/clips/<slug>/clip-<slug>.mp4` — nothing here uploads anywhere, or posts anywhere; the
operator picks the title and reviews the file first, same as every other export. `clips/` is a
non-numeric directory name, which every scan of `mediaDir` already filters on (`/^\d+$/`), so it
sits beside the match directories without the dashboard ever seeing it.

## Chat replay (prototype)

`src/api/twitchChat.ts` fetches a VOD's chat through Twitch's web GQL persisted query without a
login, paging by **offset** — the cursor fails Twitch's integrity check without a browser token.
The pipeline saves it after `download-vods` and the Short scorer reads it. `remotion/ChatPanel.tsx`
renders it; where it sits in the frame is the operator's call, and nothing is wired into
`src/pipeline/pipeline.ts` until then.

## Session preflight

`scripts/preflight.sh` runs at session start (`.claude/settings.json`), always exits 0, and
prints one line when everything is fine. When it flags something — no GitHub credentials, a
read-only PAT, an expiring OAuth token — fix that first. `bash scripts/preflight.sh` by hand.

## Known pitfalls

- **Season vs career stats.** `pickStats` (`src/pipeline/overlayProps.ts`) falls back to career totals
  only when the season bucket has no ranked games, and the overlay then labels itself CAREER.
  Both paths are pinned by `src/pipeline/overlayProps.test.ts`; don't "fix" the fallback away.
- **A private room's two seats are ordered by uuid** (`withoutGhostPlayers`, `src/api/mcsrApi.ts`):
  a room seats its players in join order, and game 3 of the S11 Pinne–7rowl pilot came out with
  the sides swapped after two games the other way. Everything left/right hangs off
  `match.players` — sync.json, the clips' placement, the band's colours — so the order is
  settled where the match is read. Ranked matches keep the API's order: the matches rendered
  before 21 Sept 2026 carry sync files written against it.
- **Elo must come from the match, not the user.** `user.eloRate` is the rating now; use
  `eloAtMatchStart()` everywhere or the same match shows different numbers in different places.
- **Props functions are async.** `computeOverlayProps` and `computeThumbnailProps` return
  promises; a missing `await` renders a pending promise as player data.
- **Never import `Overlay.tsx` from Node code** — its `import "./overlay.css"` crashes outside
  webpack. Shared geometry lives in `remotion/layout.ts`.
- **MLT silently drops ProRes 4444's alpha.** VP9 `yuva420p` is the only alpha format Remotion
  emits that MLT composites; when spot-checking, decode with `-c:v libvpx-vp9` or the alpha
  looks missing when it is not. ProRes is also ~1.9x slower in Remotion (no parallel encoding).
- **Timeline zero is the countdown's first second** (`ANCHOR_SEC`, `src/pipeline/kdenliveProject.ts`): match
  start lands at exactly 10 s *on the timeline*. A clip whose match start is later than the anchor must be pushed
  into its own head, not un-blanked — the wrong fix renders perfectly and slides the overlay late.
  **The finished MP4 is not the timeline** since 24 Sept 2026: `export:fast` cuts `headTrimSec`
  off the front for a card under 7 s and records where match start landed in
  `final-<id>.json` (`{ matchStartSec }`, never for a `--seconds` smoke run). Anything that
  seeks in the finished video reads `exportMatchStartSec(dir, id)` — 10 without a record, which
  is every export before then and any Kdenlive export — and a series reads each game's from
  `series.json` (`matchStartSec`, copied at the join; `gameMatchStarts`): the Short's proxy cut
  and its spans (`videoPick.ts`), the dashboard's pick preview (`shortFlow.ts` `previewOf`). The
  description's chapters are written at render time, before any export, so they take
  `headTrimSec(config.introSec)` instead. Anything on timeline seconds is unchanged: the sync
  editor and the 9.6 s sync check read the POV clips (`clipTimeFor`), and the teaser, mid-roll
  and top-end stills are timed on the timeline before the cut.
- **`exportUpscale1440` (7 Oct 2026, off by default):** `export:fast`'s last filter can scale the
  already-composited 1080p frame up to 2560x1440 (lanczos, same fps) right before encoding —
  every overlay asset (`remotion/layout.ts`, the stills, the intro card) stays 1080p, and the
  Kdenlive project is untouched. A cheap test of the widely reported trick of uploading above a
  viewer's playback resolution to land in YouTube's higher-bitrate transcode tier; unconfirmed for
  this channel. Off keeps the filter graph and command line byte for byte what they were before
  this. A playoff series needs every game exported with the same setting — `assembleSeries`
  refuses to `-c copy`-join games at different resolutions and names which.
- **When the detector is not sure, a human settles it.** `GET/PUT /api/sync/:id` plus
  `GET /api/sync/frame?match=&side=&t=&offset=` back the match screen's "Fix the sync by hand"
  fold (`src/pipeline/syncEdit.ts`): one frame out of each POV clip at the same second of the *finished*
  timeline, which must show the same countdown digit because both players freeze through it.
  `clipTimeFor(offset, t) = offset + (t - ANCHOR_SEC)` is the only arithmetic. Saving stamps
  `source: "manual"` and `confidence: 1` — which clears the warning line and, in `src/pipeline/pipeline.ts`,
  makes the sync stage keep those numbers instead of re-running the detector, so re-rendering for
  a new thumbnail cannot put the machine's rejected guess back. Only the clip placement changes,
  so the fix is `export:fast` (~10 min), not a re-render — and it is not optional: a video went
  out of sync to the channel because sync.json was corrected *after* `final-<id>.mp4` was exported.
  `exportStale` (`src/pipeline/syncFile.ts`, mtime of sync.json vs the export) now refuses the Upload
  button, the nightly's video and the adopt route with one line, and the match page's "Sync check"
  (both POVs at 9.6 s, above the YouTube panel) is the look that catches the rest. "Save and
  re-export" presses the Final video panel's encode button, which an exported match now also has
  ("Re-encode MP4") — for months it did not, so the button saved and encoded nothing.
- **A Twitch archive outlives the stream by 14 days for most players** (60 for partners), and the
  chat goes with it. `withDiscoveredVods` writes what it finds to `<matchDir>/vods.json` and reads
  it back first, so a clip on disk stays renderable after the archive is gone — before 21 Sept
  2026 a re-render re-listed the channel and threw "1/2 VODs" once it had expired. `npm run
  download-vods -- <id>` is the way to secure a match ahead of its render (it saves the chat too);
  the listing reaches 40 archives back, since a playoff game packaged a week later sits behind
  every stream since.
- **Every consumer places the clips from `<matchDir>/sync.json`** (`src/pipeline/syncFile.ts`), which the
  pipeline writes when the sync stage decides — refined or kept-coarse, `source` says which.
  Without it `export:fast` and the Short fall back to `config.preRollSec` and run seconds early;
  `npm run sync-status` backfills the matches rendered before the file existed.
- **Sync reads the picture, and only the picture.** Two readings per clip
  (`src/pipeline/countdownDetect.ts`, settled by `detectMatchStartAny`): the countdown digit at the centre
  of the screen — a 96x72 crop's white-pixel count, the "10" the fattest, one step a second,
  0:00 the frame the "1" vanishes — and the 10 s camera freeze. The digit is the one that works
  in a private room (every playoff game), where the player can look around through the countdown
  and there is no freeze; both POVs of S11 Pinne–7rowl game 1 came back coarse before it
  (21 Sept 2026). The audio cross-correlation fallback is gone (22 Sept): opponents play separate
  worlds, it was 12–32 s wrong on real footage, and in a year it never once answered on a match
  on disk. A clip the picture cannot read keeps the coarse estimate at confidence 0 and the
  dashboard's sync editor settles it. **Ranked matches went to the editor for two reasons the
  detector now covers** (22 Sept 2026, replayed on the 13 ranked matches with clips on disk:
  26 of 26 clips read, 25 of them to the frame the "1" vanishes): the API's estimate can be a
  minute off (a VOD that lost a segment runs ahead of the API's clock; Aquacorde, 13559245:
  53 s, and `1 - off / 20` scored the countdown it found to zero), so an empty ±25 s window is
  followed by one ±150 s pass and the distance term is soft; and a world that loads late has
  the loading screen over the "10" (BeefSalad, 13549300), so a countdown is also read from its
  end — the drop out of the last digit with stepping seconds before it — and an onset has to be
  a real "10", half again the fattest digit after it, or the "6" after a waiting screen becomes
  the "10" (Feinberg, 13395245). The end is a drop to under half the digit's own pixels (a
  pause menu opened on 0:00 keeps button text in the crop, doogile 13223455), and a second
  counts as a digit only when most of its frames are (a one-frame flash after the "1",
  v_strid 13141080). Still unread: a digit that shrinks mid-countdown (a scene
  switch on "2", BeefSalad 13257079 — 1.2 s early; a digit fills a third of its bounding box, a
  crosshair a twentieth, which is the test to add if it recurs). **The hand editor's anchor is
  coarse**: it matches the same digit on both POVs at 9.6 s, which fixes the two clips to each
  other but leaves 0:00 anywhere inside that digit's second — three of eight hand-synced
  matches sat 0.9–1.0 s off the frame the "1" vanishes (both directions), so the overlay's
  timer led or trailed the players' own by that much. Prefer the detector's reading when it
  is confident; the editor is for a clip it cannot read.
- **The intro card is a versus screen** (`remotion/Intro.tsx`, `.iv-vs-*` in `remotion/overlay.source.css`;
  the operator's pick of three layouts, 24 Sept 2026): each half slides in with its own inline
  `translateX` and parts like a door on the way out, so every animated element takes its position
  from left/top in the CSS, never a CSS `transform` — an inline transform replaces the whole CSS one.
  A playoff game shows no head-to-head (it would read as the series score); flags are left out
  (they render as tofu without a colour-emoji font).
- **tini is PID 1 since 830321f**; if `ps -eo stat | grep -c ^Z` ever climbs, wrap the command
  in `python3 scripts/reap.py`.
- **The upload form rendered for the first time on 14 Sept 2026.** Everything inside
  `status.uploadsEnabled` in `public/youtube.js` sat unrendered for a week while the audit was
  pending, so a mistake there surfaced only when `youtubeUploadEnabled` went true — one such bug
  (a free `u`) shipped that way. `post-audit-check` renders that branch by flipping the flag in the browser's copy of
  `/api/youtube/status`; run it after touching that file.
- **Five browser checks pinned copy or controls that later commits changed on purpose**, and the
  redesign brought them back in line rather than silently: `smoke` no longer fills `#ytTitle`
  (the panel keeps no second title — hook-flow-check asserts it) or looks for `#rerender` (gone
  with plain thumbnails); `kit-scan`, `pinned` and `studio-upload` match the lowercase copy of
  8da852d; `playoffs-fold` asserts the board is folded on every date, an hour out included;
  `run-all.sh` picks a *Studio* upload for `published`, since the newest uploaded
  match has been a dashboard upload since 15 Sept. `round1-fixes` now asserts Final video → Sync check and YouTube above the kit,
  `round3` four `.jump` links and that Publish opens at the top with `#headwarn` and `#h-youtube`
  both on the first screen — those are the design.
- **The playoffs board lives *inside* `#suggestions` and its rows carry `.sugg`.** Anything that
  means "the suggestion cards" must say `#suggestions > .sugg`; the descendant form also matches
  playoff rows, which are hidden inside the fold until the operator opens it, so a
  `waitForSelector` on it waits forever on a row that is never shown.
- **`ss` is there, `lsof` and `fuser` are not.** `ss -tlnp | grep <port>` names the process that
  actually holds a port — which is not always the one `ps -eo pid,args | grep 'src/dashboard/server.ts'`
  finds, because the listener's `comm` is `MainThread`. Killing the grep's PID and restarting can
  leave the old listener up and the new server dead on `EADDRINUSE`.
- **A failure reports under the control that caused it** (`failAt`, `public/app.js`), not in
  `#failure` at the top of the match pane — that box sits above the hook, the title editor, the
  preview, the sync editor, the publish kit, the Short and the YouTube panel, so a press at the
  bottom of that column reported itself a screen and a half away. `clearFailAt` at the start of an
  action stops a stale message outliving the retry that fixed it. Three call sites repaint their
  panel after failing, so they report **after** the repaint or the message is wiped from under
  them. The banner is kept for a stage or pipeline error arriving over SSE, which has no control,
  and as `failAt`'s fallback when the anchor has been repainted away.
- **There is no Clipboard API on the lab's dashboard.** `navigator.clipboard` exists only in a
  secure context — https, or a localhost origin — and the dashboard is plain http on `actimel`, so
  on every machine except the lab's own browser it is `undefined`. `copyText` (`public/app.js`)
  falls back to `document.execCommand("copy")`, which does work there, and returns whether the
  text actually arrived: never set a button to "Copied" without checking. The browser checks read
  the clipboard by pasting (`readClipboard`, `scripts/browser-checks/launch.cjs`) for the same
  reason — `navigator.clipboard.readText` made four of them pass against 127.0.0.1 and die against
  the real dashboard. `--unsafely-treat-insecure-origin-as-secure` does not help: it needs a
  persistent profile.
- **A cut-short upload resumes its own session, never trusts a record.** A restart mid-upload
  leaves `upload-video`/`upload-short` recorded `"running"` in `short-<id>.status.json` with the
  file's `.upload-session-<name>.json` still on disk — and the channel scan can pair that same
  half-uploaded video to its match by the description link alone (`recordStudioUpload`,
  `src/youtube/channelUploads.ts`) long before every byte of it has actually landed, which used to
  make `advance()` read that record as "done" and leave the step `"running"` for ever (2 Oct 2026,
  the Grand Final's `series-13530634.mp4`, paired at 30% uploaded, 48 ticks with no progress).
  `shortTick`'s restart now settles a `"running"` upload step through `resumeUpload`
  (`src/youtube/youtubeUpload.ts`) instead of the normal upload-video/upload-short step: a session
  still on disk is finished through `uploadVideo`'s own resume with `resumeOnly` — which refuses to
  ever fall through to starting a second one, the one thing a restart must not cause — and writes
  the chain's own `source: "dashboard"` record over whatever the scan wrote, so the finish steps
  run as for any dashboard upload rather than declining as "uploaded elsewhere". No session and a
  `source: "dashboard"` record is trusted as done (the crash landed between writing it and marking
  the step so); no session and anything else on record fails the step and names Studio, not a guess.
- **Country flags render as tofu** without a colour-emoji font (cosmetic, intro card).
- **Verify visual changes by rendering** (`npm run still`, then read the PNG).
- **`npm run test:unit` after any edit; `npm test` after touching rendering or asset
  generation** — the full run adds the two tests that drive Chromium and ffmpeg. The
  PostToolUse hook's `prettier` + `tsc --noEmit` covers per-edit mistakes. `test:unit` runs on
  `DEFAULTS` (it sets `MCSR_CONFIG` to a missing file), so a switch the operator turns on in Settings
  cannot break it; the two render tests still read the live config, for `mediaDir` (7 Oct 2026).
- **Generated projects carry `<mlt root>`** with every resource relative to it, which is what
  lets a project rendered on the lab open on the desktop.

## Version control

Long-lived branches are normal. Before concluding a feature doesn't exist, check
`git branch -a`, `git worktree list` and the remote. Sessions run concurrently in
`.claude/worktrees/`: check for another session's uncommitted work before staging, and never
`git add -A` on a shared tree.

## Branding

One pixel-art Minecraft identity across overlay, thumbnails, channel art and reports:

- **Font:** Monocraft (`remotion/assets/fonts/`), `--pixel-font` in `remotion/overlay.source.css`.
- **Palette:** the custom properties at the top of `remotion/overlay.source.css` (`--panel` …
  `--muted`). Don't invent new colours for thumbnails, channel art or docs.
- **Badge:** the replay ring + MC/SR monogram is defined once in `remotion/pixelBadge.ts` and
  drawn by `<PixelBadge />`; change it there, never by re-inlining SVG. In `Overlay.tsx` it must
  render after its siblings or the header bar paints over it. The overlay's badge wears the
  thumbnail seed frame's double ring (`variant="ov"`, `.badge--ov`); the bare `.badge` is the Short's
  and the thumbnail's, so a ring on it reaches both.
- **The overlay wears the thumbnail's look** (the operator's pick of three, 28 Sept 2026): the name
  bars in the thumbnail's mid-value crimson/warped split with its checker, each name and head on a
  thumbnail plate (`.plate`), the bottom band on the checker with three plates (`.band-plate`:
  meta, splits, the gold-ringed RTA), hard pixel shadows only — no blur, and none past a band's
  edge, since each band is its own clipped image. Matches rendered before it keep the old look.
- **Channel art:** `branding/logo.png` + `banner.png` from `branding/generate_brand_assets.py`
  (`branding/README.md`).
- **Brand and launch plan:** https://claude.ai/code/artifact/82c863d6-1bf5-4e01-b679-a2a3c40fcc80
