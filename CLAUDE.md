# mcsr-vid

Full rationale and history per feature: `handbook/claude-md-reference.md` — read the matching section before changing that feature.

Turns an MCSR Ranked match id into a synced, split-timer-overlaid video (`fetch-match` →
`download-vods` → `validate-sync` → `render-overlay` → `generate-project` / `export:fast`), plus
thumbnails and a Short, published to **MCSR Replayoffs**.

## House rules

- **Match footage is never cut.** Only two regions are editable, and both are automated: before
  the match, and the tail (`ANCHOR_SEC`, `src/pipeline/postRoll.ts`; tail ≤ `postRollSec` = 30s,
  cut earlier where the winner goes quiet, never under 15s).
- Each POV's audio leans toward its side (`povAudioPan`, default 0.7) in `export:fast` only — the
  Kdenlive MLT mix stays centred. The Short lowers the off-focus POV 12dB instead (`focus`).
- **Nothing names the winner**: no result line in descriptions, no winner in a hook or thumbnail.
  The upset hook is a question.
- **Never a runner nickname, label or epithet, "vs" or not** (`hookLabelProblem`,
  `src/pipeline/hooks.ts`; `hookProblem`'s `players` arg, `src/shorts/videoPick.ts`; `withHook`,
  `src/pipeline/title.ts`). A denied word (an ethnicity/nationality term, a slur-adjacent
  abbreviation) is refused outright; a fresh "X vs Y" is checked against the match's own two
  players (API or `titleNames` spelling) and a mismatch is a label too. A model's proposal and a
  carried `hookText` value both fail closed the same way `hookProblem` does. Only the operator's
  own **typed** hook always saves — the problem lands as a warning in `saveWarnings`, never a
  refusal ("it should just be a suggestion").
- **No seed, rank or elo in hooks or suggestions**: match quality is uncorrelated with views once
  players are controlled for, and they change daily anyway.
- **The YouTube API compliance audit cleared 15 Sept 2026** (`handbook/api-review/`).
  `videos.insert` is the only call the audit gates; `youtubeUploadEnabled` is true,
  `nightlyUpload` is `"scheduled"`. Keep every API call inside what the recording showed: **own
  channel, own data, nothing shown to anyone else.** Google may re-review.
- Nothing irreversible without the operator: deletions, retitles on the live channel, config
  that changes what a nightly render does.
- **Studio automation stays inside the audit's own rule** (own channel, own data, nothing shown
  to anyone else) — see "Studio automation".

## Layout

`src/` is grouped by what the code is for; a module's folder is the first thing its path says.

| Folder | What lives there |
| --- | --- |
| `src/api/` | MCSR Ranked (`mcsrApi.ts`, `types.ts`), Twitch (`twitch.ts`, `twitchChat.ts`), avatar renders. |
| `src/pipeline/` | A match to a finished video: fetch, VOD download/discovery, sync (`countdownDetect.ts`, `sync.ts`, `syncFile.ts`, `syncEdit.ts`), the overlay (`overlayProps.ts`, `overlayRender.ts`, `splitStates.ts`), the Kdenlive project and `export:fast`, and text (`title.ts`, `description.ts`, `hooks.ts`, `chapters.ts`). `pipeline.ts` is the stage runner. |
| `src/thumbnails/` | The variant strip and its manifest. |
| `src/shorts/` | The model's pick (`videoPick.ts`, `watchPov.ts`, `pickCli.ts`), the heuristic fallback, the reasoner, the vertical render, `generateShort.ts`, `handShort.ts`. |
| `src/playoffs/` | The bracket and its games (`playoffs.ts`), a series as one video (`series.ts`, `seriesCli.ts`). |
| `src/youtube/` | The Data API client and auth, upload records, the upload itself, channel pairing, publish slot, Studio browser automation (`studioBrowser.ts`, `studioActions.ts`, `studioWorker.ts`). |
| `src/dashboard/` | The web server (`server.ts`), route groups (`youtubeRoutes`, `exportRoutes`, `shortsRoutes`, `syncRoutes`), match screen payload (`matchMeta.ts`), jobs, nightly, suggestions, the shelf (hidden/queue/checklist), the publish set, experiments. |
| `src/telegram/` | The Telegram bot: `bot.ts`, morning-report facts (`facts.ts`) and rendering (`report.ts`), the Claude CLI adapter (`claude.ts`), `/ask`'s knowledge (`knowledge.ts`), the 07:00 Warsaw schedule (`schedule.ts`), `commands.ts`, dedupe/snapshot state (`state.ts`), `index.ts`, `tgCli.ts`. |
| `src/clips/` | Standalone clips, not a match: `clipCli.ts` (+ `clipArgs.ts`) behind `npm run clip` — see Clips. |
| `src/cli/` | Entry points nothing else imports: batch, status, score, chat, bench, retention, the TUI. |
| `src/` root | `config.ts`, `cliArgs.ts`, `errorText.ts`, cross-folder tests. |

Tests sit beside what they test (`foo.test.ts` next to `foo.ts`); fixtures are `src/fixtures/`.
`remotion/` is the compositions; `public/` the dashboard's browser files; `scripts/` browser
checks and build/preflight helpers; `docs/` the GitHub Pages site (not repo docs — see root `README.md`).

## Commands

Use the script, don't reconstruct the shell line. Extra arguments go after `--`.

| Script | What it does |
| --- | --- |
| `npm run dashboard` | The web dashboard (`PORT`, default 8080). |
| `npm start` | The terminal UI (`src/cli/tui.tsx`). |
| `npm run still -- <Composition> <out.png> [--frame=N] [--props=p.json]` | One Remotion frame to PNG, rebuilding overlay CSS first — the fast visual check. Ids in `remotion/Root.tsx`. |
| `npm run validate-project -- media/<id>/match-<id>.kdenlive` | Loads the MLT XML through the MLT engine. Exit 0 = parses; passes a project with missing media. |
| `npm run export:fast -- <matchId> [--cpu] [--seconds=N] [--full-tail]` | One ffmpeg pass (Intel VAAPI), no Kdenlive. `--seconds` → smoke test `smoke-<id>.mp4` (never the real final). |
| `npm run export:nvenc -- media/<id>/match-<id>.kdenlive [out=N]` | melt + `h264_nvenc`. Needs an NVIDIA GPU; the lab has none. |
| `npm run short -- <matchId> [--at=<ms>] [--seconds=N]` | Vertical Short, cut from the pick's window. Refuses without the hook (`short-<id>.hook.txt`) or once on YouTube. |
| `npm run short:hand -- <matchId> <file.mp4> --hook "<hook>" --from <sec> --to <sec> --pov left\|right [--note]` | Registers a hand-cut Short as the pair the chain reads (`shortsByHand`). |
| `npm run series -- <matchId \| all> [--join-only]` | Playoff series as one video: renders every game missing an export, joins into `series-<g1>.mp4`. Nightly cannot see a run here. |
| `npm run sync-status -- [matchId]` | Where a match's POV clips sit; derives/writes `sync.json` if missing. No id lists everything, writes nothing. |
| `npm run chat -- <matchId>` | Fetch both players' Twitch chat for a match saved none for. |
| `npm run clip -- <twitch url \| file> [--from=HH:MM:SS --to=HH:MM:SS] --title="…" --speaker="…" --when="…" --credit="…" [--slug=…] [--seconds=N]` | A standalone clip, not a match — see Clips. |
| `npm run tg -- report --dry-run` | Morning report text, printed, nothing sent. **Prints real viewer comment text** — use `cmd "/needs"` / `"/ypp"` / `"/stats 7d"` instead when you don't need that. `send --md <file>` sends to the operator; `whoami` prints chat ids. |
| `npm run pick -- <matchId \| all> [--force] [--dry-run]` | Ask the model for the Short's moment. `--dry-run` writes nothing, refuses if the one on disk is current. |
| `npm run bench -- <Composition> [--frames=N] [--codec=] [--pixelFormat=] [--concurrency=N]` | Render throughput. Measure before claiming a render change is faster. |
| `scripts/seed-icons/icons.sh [TYPE…]` | Re-render thumbnail seed-type icons. |
| `npm run retention -- <videoId>… [--days=90]` | Audience retention curve per video, per decile. |
| `npm run config:example` | Rewrites `mcsr-vid.config.example.json` from `DEFAULTS`. Run after adding a config key. |
| `npm run analytics -- <videoId> [--traffic-sources] [--days N]` | YouTube Analytics via `~/.claude/skills/claude-youtube/`. |
| `bash scripts/agy-task.sh <name> <prompt-file> [model]` | Hand an easy task to agy (Gemini) in a worktree; review the diff and commit yourself. |
| `python3 scripts/reap.py <command…>` | Subreaper wrapper if zombies climb. |
| `bash scripts/browser-checks/run-all.sh <url>` | Drives the dashboard in a real browser (26 Playwright checks). Point at the real dashboard. |
| `npm run tc-thumbs -- <matchId…>` | A Test & Compare thumbnail set per match in `<id>/tc/` (control, most-different pose, a caption). |
| `npm run studio -- probe \| pin <id> [--dry-run] \| login \| worker [--once] [--dry-run] [--enable] \| tc-plan <plan.json> \| related <id> <id> \| link-related <shortId> <longFormId> [--dry-run]` | Studio browser automation CLI. |

Lab timings for a 10-minute match: overlay render ~9 min, `export:fast` ~10 min, a Short in
seconds; a nightly render ~12 min, ~21 min with the MP4.

## What the render produces

Almost nothing in the overlay moves, so the render is stills plus one strip (`src/pipeline/overlayRender.ts`):

- `overlay-top.png` — identity/stats band, static; on a playoff game carries the series dots and
  seed in the rank's place. `overlay-top-end.png` is the same with the winner's dot filled;
  `export:fast` switches to it at `topEndAtSec`.
- `overlay-splits-<n>.png` + `overlay-splits.json` — the meta+splits region, one still per
  distinct state (`src/pipeline/splitStates.ts`). The manifest written last means "render
  finished". Last state is the subscribe card (`postRollCta`, `ctaFrameOf`); `ctaReason`
  (Settings → Publishing, ≤24 plain-ASCII chars, empty = bare card) shows above SUBSCRIBE.
  `renderOverlay({ only: ["splits"] })` redoes just these in seconds.
- **COMING UP card** (`teaserFramesOf`): from `teaserAtSec` (default 10, Settings → Publishing,
  empty = none) for `teaserSec` (5). Moment from `src/pipeline/teaser.ts`, `match.timelines` only:
  an unplanned death, else the biggest-deficit lead change, else a split under 2s; never in the
  first/last minute, names nobody. Reads `death` only (never promises a hunger reset).
- **Explain the moves** (`explainMovesSec`, Settings → Publishing, default **null = off** — on
  changes what the nightly renders): first time either player reaches one of six `MILESTONES`
  splits, meta column shows the split and why (`MOVE_LINES`, `src/pipeline/explainMoves.ts`);
  names nobody; a card overlapping SUBSCRIBE/teaser/the prior card waits; one reaching the finish
  is dropped.
- `overlay-timer.mp4` — the RTA column, the only thing rendered per frame.
- `overlay-intro.webm` — the versus-screen intro card (`remotion/Intro.tsx`), `introSec` long
  (Settings → Publishing, 2–7, default 7). Lies *over* the frozen countdown, never moves the
  timeline anchor. `export:fast` cuts `7 - introSec` off the countdown head (`headTrimSec`); match
  start lands at `introSec + 3`s (7→0:10 default; 3→0:06). Kdenlive stays at 0:10.
- `overlay-countdown-teaser.png` — COMING UP line across both POVs (`countdownTeaser`, default
  off, needs a teaser moment). `export:fast` shows it card-end→match-start when on and present.

## Shorts

Contract `src/shorts/shortPlan.ts`. A fixed 22s-window Short that ends on the finish spoils and
underperforms — the model picks a real moment instead.

- **`shortsByHand`** (Settings → Publishing, default **off**): the session cuts every Short by
  hand instead of the pipeline's pick-and-render. On, the chain skips its own pick/render step for
  the Short and the long-form uploads at its slot without waiting on either. **The pick after
  export still runs** (`ensurePick`) — auto-hooks is due 6h after a pick and needs the model's
  title hooks; the pick's window becomes only a hint for where the Short is. `npm run short:hand
  -- <matchId> <file.mp4> --hook "<hook>" --from <sec> --to <sec> --pov left|right [--note]`
  (`src/shorts/handShort.ts`) validates first (`checkHandShort`: 1080x1920 h264+aac ≤60s, hook
  passes `hookProblem` — refused outright, never a warning, unlike a typed dashboard hook — no
  blocked player, not already on the channel), then writes `short-<id>.mp4` +
  `.title.txt`/`.description.txt` + `short-<id>.hand.json`, indistinguishable from a rendered
  Short to `uploadTextFor`. Until that pair exists the chain just logs "waiting for the hand-made
  Short" (never a failure). `noShort`/a blocked player still mean no Short either way. Off is
  today's pick→render→upload-video→upload-short chain, byte for byte.
- **A model watches the whole match and picks the moment** (`src/shorts/videoPick.ts`,
  `pickShortMoment`): a 2fps proxy, /watch's stills/transcripts per player (needs `GROQ_API_KEY`),
  then Antigravity (`agy`, `gemini-3.8-flash-high`, `--sandbox`, never
  `--dangerously-skip-permissions`). Answer: a continuous 12–60s window
  (`SHORT_MIN_MS`/`SHORT_MAX_MS`), a focus side, a hook suggestion, a one-line why (operator's
  eyes only — can exaggerate); validated for bounds and `rtaAtStart` within ±2s. One retry on
  empty answer, then the timeline heuristic (`shortMoment.ts`) stands in. Pick is
  `short-<id>.pick.json`. Also proposes the long-form's title hook (`titleHooks`, up to 3) from
  the operator's own past saved hooks as style examples — each must pass `hookProblem` or is
  dropped; a rejected window's title hooks go with it.
- **No Short renders and nothing uploads before the operator saves the hooks**
  (`generateShort.ts`, `youtubeUpload.ts` `hookRefusal`, every render path): Short's hook is its
  own field (`short-<id>.hook.txt`); long-form's title hook is the edited title. Saving both
  (`PUT /api/shorts/hooks/:id`) starts the chain (`src/dashboard/shortFlow.ts`): render Short,
  upload long-form at its slot, upload Short 18h later. A hook changed before upload re-renders;
  after upload hooks lock. "No Short for this one" lets the long-form go alone.
- **On screen** (`remotion/Short.tsx`): hook 4s, race captions (a leader may be named mid-race,
  never the result), running clock, off-focus POV at -12dB, a closing card ("WHO TOOK IT? FULL
  MATCH ON THE CHANNEL" if the window ends before decided, else "FULL MATCH ON THE CHANNEL").
  Title is `<hook> | <left> vs <right>` with `titleName` (Skycrab, lowkey) + `#mcsr #minecraft`.
- **`deathKind`** (`src/pipeline/matchScore.ts`) is the one reading of `death_spawnpoint`: a
  hunger reset in every phase but the End, a real death in the End. `metrics.deaths` counts real
  deaths only; the model's prompt, captions/hook, heuristic, title chips and "N deaths" all follow
  it. `teaser.ts` keeps its own stricter reading (reads `death` only, never a reset).
- **A playoff game's nameplates show the seed, not the ladder rank.** A series is picked/cut from
  game 1's directory, clips from the picked game's. Auto-crop usually declines, and should —
  streamers' panels reach the frame edges.

## Dashboard

`src/` is read at boot; `public/` served from disk per request. After merging server changes,
`POST /api/restart-when-idle` (below) — a hand `docker restart mcsr-dashboard` only when nothing
uploads. Client-only changes need just a reload.

- **Restart only when idle** (`src/dashboard/restartWhenIdle.ts`): `POST /api/restart-when-idle`
  arms, `DELETE` cancels, `GET` reports. `idle()` checks a pipeline render, an export, a Short
  render, the pick queue, the publish chain, an upload, a `.upload-session-*.json`, an NAS copy,
  and the time before `nightlyRenderHourUtc`; idle, it runs `npx tsc --noEmit` then
  `process.exit(0)`, and tini brings it back on the new code. **A docker restart must never be
  issued while a chain uploads** — a manual restart once cut a Grand Final upload at 30%.
- **Two screens, one bar**: list and match, four list tabs as the only navigation. Match screen =
  head + four groups in pipeline order: **Now** (steps, sync warning, Save), **Check** (final
  video, sync check/edit), **Package** (thumbnail, splits, title & description), **Publish**
  (YouTube panel, publish kit, checklist, Manage fold). Now's steps (`GET /api/shorts/plan/:id`):
  Video, Pick, Hooks (locked once uploaded), Short (auto-renders once hooks saved, skipped if
  `noShort`), Video up, Short up (18h later). Rendered rows are two lines: names+id, then one
  state line (`waiting for hook`, `scheduled`, `published`, `in progress · <stage>`, `failed`).
- **Suggestions** (`src/dashboard/suggest.ts`): cached in `.suggest-cache.json` (`CACHE_VERSION`
  4), rescanned periodically; one card per pair across close/chaos/`known` buckets, capped one
  slot per player too, not just per pair (`suggestKnownSlots`, default 4).
- **Favourite players, then known** (`tierFor`; `favouritePlayers` Settings tab, default
  doogile/Feinberg/Infume/Pinne/lowk3y_/silverrruns; edcr is the operator's call). Order: favourite → known → neither,
  then expiring → audience → popularity. Known: a favourite, a measured draw ≥ `KNOWN_DRAW_MIN`
  (0.6), or Twitch followers (`knownFollowerThreshold` 10,000). **No chaos/closeness, seed, rank
  or elo term — only tier, audience and recency decide the order.** `learnedDraw`/
  `recordPaceBoostSec` (Settings tab, both default **off**) reorder by real/near-record stats
  without naming/implying the winner; off is today's order.
- **Blocked players** (`blockedPlayers`, Settings tab, default `["Aquacorde", "BeefSalad"]`;
  `isBlockedPlayer`/`blockedIn`, `src/config.ts`, whole-string, case-insensitive): a runner who
  withdrew permission for their footage. `blockedOnDisk`/`hasBlockedPlayer`
  (`src/dashboard/matchStatus.ts`, `src/youtube/youtubeUpload.ts`) check the POV clips, the saved
  chats (`chat-<nick>.json`) **and** the title's "A vs B" pair — not clips alone, so a match
  archived off disk is still caught (the Studio worker's `realIsBlocked` and `finishOnYouTube`'s
  retry ticks share this check). A blocked match: dropped from the suggestion pool even if
  already in it, never shown however stale the cache, **never rendered by the nightly even if
  queued — the block outranks the queue, the only gate that does**, never "worth rendering
  today", never uploaded (long-form or Short), never gets hooks saved, never rendered by `npm run
  short`/`short:hand` even by hand, never a past-hook style example. `finishOnYouTube` carries the
  refusal to Adopt/Finish/nightly-retry alike; Adopt also refuses before `videos.update`;
  `POST /api/render` and `POST /api/series/:id/render` refuse before the run starts; `runPipeline`
  itself refuses right after the match fetch, so `npm run batch`/`generate-project` and the TUI do too.
- **Rival posts** (`rivalChannelHandle` default `mcsrmatches`): its public feed, never our token;
  matched to cards by pair/date; a posted match sorts after fresh ones.
- **Hook chips** (`src/pipeline/hooks.ts`) lead with the match's stake (margin, lead change,
  death), nickname/rematch chips after. A typed hook reusing another player's nickname warns but
  always saves; any check on a typed hook is a warning, never a refusal ("it should just be a
  suggestion"). Chip-truth, pinned by fixtures: the swing chip reads an actually held-and-lost
  lead (`metrics.splits`), not the raw step that also fires on a widening lead; lead-change is the
  numberless "Does the lead ever settle?" (excludes off-panel splits and the dragon); "not a
  single death" counts every death-screen entry, not just real deaths; the DNF fallback never
  says "reached" the dragon, only **killed**. A joined series' chips read the game that actually
  decided it, not game 1's. `midRollCtaAtSec` (Settings → Publishing, default 90, null=none)
  shows SUBSCRIBE for `midRollCtaSec` (4)s at the first split. `titleNames` (default
  `{ Pinne: "Skycrab", lowk3y_: "lowkey" }`) spells two players the broadcast's way, title only.
- **`nightlyUpload`** is `"scheduled"` (**not writable from Settings**): once hooks are saved the
  chain uploads private, scheduled for the next free slot (19:00 UTC ranked / 23:00 series) or
  the kit's Publish-at time, Short 18h later. `"private"` = no publish time; `"off"` = chain stops
  after render. Picking the free slot and claiming it is one serialized step (`claimSlot`) so
  concurrent chains never collide on an hour.
- **Auto-hooks** (`autoHooksAfterHours`, Settings → Publishing, default **null=off**): a match
  whose hooks go unsaved this many hours after its pick gets the best title hook passing
  `hookProblem`+`spoilsTheResult` (model's, else a chip) and a Short hook the same way, upper-cased
  to house style, then the chain runs as if Save had been pressed. Due: readable pick, unsaved,
  not hidden, neither video on channel, not blocked, export not stale, series joined, nothing
  already running. No survivor: nothing saved, `hooks` step fails, reaching Needs-you. Logs to
  `autoHooks` in `short-<id>.status.json`.
- **Thumbnails** (`remotion/Thumbnail.tsx`): two big figures, name-only plates, seed type above
  the VS, no rating/seed/placement text. Four pose pairs; `thumbnailRotatePoses` (default off)
  rotates by match id. **"cheering-relaxing" is excluded from every automatic pick**
  (`RESULT_LOOKING_POSE_KEY`, reads as the result) — operator pick only. `playoffThumbnailStyle`
  is **not wired** into any render yet.
- **Re-render a match's thumbnails beside the live set, never over it**
  (`src/thumbnails/rerender.ts`, `src/youtube/thumbnailSwap.ts`, `src/dashboard/thumbnailRoutes.ts`,
  `src/dashboard/busy.ts`): every variant drawn again into `thumbnail-new/`; live files
  (`thumbnail.png`, the manifest) change only on an operator press — "Use this" for a match not
  on the channel, "Put on YouTube" / "Undo on YouTube" for one that is. Blocked players and the
  cheering-relaxing exclusion apply the same as everywhere else. A re-render or a pending put
  counts as busy for `restart-when-idle` and the nightly, same as a render or an export.
- **`videos.insert` is the only call the audit gated.** `playlistItems.insert`, `thumbnails.set`,
  `commentThreads.insert`, `videos.update` are all inside `force-ssl` scope, so **Finish on
  YouTube** repairs a Studio upload too — but leaves the thumbnail alone on a video whose variant
  nobody confirmed here. **`videos.update` replaces the whole part it is given** — `addTags`
  reads the snippet and sends it back whole (omitting description would blank it) and only ever
  adds tags; `reschedule` sends `status` back whole the same way; both refuse to write if the
  read returns no video.
- **Adopt a Studio draft** (`POST /api/youtube/adopt/:id`): writes title/description/tags via
  `videos.update` onto a video pasted by id, then runs finish steps. Not behind
  `youtubeUploadEnabled`. Refuses: malformed id, an id already recorded for another match **or as
  any match's Short**, a video ≤3 min, a title still reading `<HOOK>`, a non-pairing description,
  no `chosenBy: "operator"` thumbnail variant, a video on someone else's channel, **a blocked
  player**.
- **Upload** refuses a title still containing `<HOOK>`; adds the video to the season, a matchup
  and a player playlist. **`playlists.insert` caps ~a dozen per rolling 24h** (429) — the
  nightly's `retryFailedPlaylists` tick presses again, no operator action needed. A published
  long-form queues an NAS copy (see NAS).
- **Settings tab** (`src/dashboard/settings.ts`): writes `mcsr-vid.config.json` atomically,
  applies live, validated through `validateOverrides`. **`youtubeUploadEnabled`, `nightlyUpload`
  and `studioAutomation` are deliberately not writable here** — all three stay a deliberate edit
  on the box; the panel only reports them.
- **Publish kit** (`GET /api/publishkit/:id`): copy buttons for title, publish slot
  (`publishHourUtc` 19:00 UTC ranked / `seriesPublishHourUtc` 23:00 series, `seriesPairGapDays` 3
  apart), description, tags, Short title/description, a spoiler-free pinned comment, community
  post, a per-player DM. Publish-at is editable — slot rules are warnings, never refusals.
  **Publish checklist**: facts from disk + toggles in `publish.json`; Delete refuses while any job
  writes into the match directory.
- **Nightly** (`src/dashboard/nightly.ts`): at `nightlyRenderHourUtc` (default 3 UTC, null
  disables) renders the first eligible card, then the MP4, then queues the Short's pick — Short
  and upload wait for the operator's hooks. **A candidate also needs a known player** unless the
  operator queued it; a playoff pick always counts; the block list outranks the queue. **A test
  server arms its own nightly too** — any `PORT=… npm run dashboard` schedules against the same
  `/media`; kill it before the hour, or set `nightlyRenderHourUtc: null` for it. Its 15-minute
  tick (chain resume, auto-hooks, creator watch, experiments) runs only on 8080.
- **The experiment engine runs between-video A/B tests unattended** (`src/dashboard/experiments.ts`
  + `experimentsEvaluator.ts`): `.experiments.json` (hypothesis, arms, a day-by-day `schedule`,
  `result`/`verdict`/`decision`, atomic write, defensive read, never rewritten while corrupt; `"tc"`
  = Studio's Test & Compare, untouched). A tick before `nightlyRenderHourUtc` applies the day's
  `render`-tagged entry through `saveSettings` (real `SETTINGS` keys only); a `slot`-tagged entry
  coexists for a different experiment. A daily tick evaluates each running one (CTR: two-proportion
  z-test `|z| ≥ 1.96`; retention needs every video of one arm beating the other, 3+ with views a
  side; under 1,000 impressions is "inconclusive"); at `end` a winner with `adoptWinner` becomes the
  default, else the control arm is reapplied; two failed evaluations in a row sets `needsHuman`.
  `enrolVideos` (idempotent by `matchId`) fills `exp.videos` from each match's `experiment-arm.json`
  and matching `youtube.json` uploads.
- **Playoffs** (`src/playoffs/playoffs.ts`): bracket knows the series, not the games. **No
  surface prints a series score** — round/game number only, as much a spoiler as the result.
  `playoffsFirst` (default **false**) puts detected games ahead of suggestions. **A series is one
  video, game 1's directory is the series** (`src/playoffs/series.ts`): exports joined `ffmpeg -f
  concat -c copy` into `series-<g1>.mp4`, chapters name each game's world, never the seed or
  score; the join deletes the games' own exports (reversible).
- **Tonight's queue** (`.dashboard.json`) bypasses `nightlySkip` and the known-player gate — but
  **not** the block list. **Creator watch** (`creatorWatch`/`creatorWatchlist`, Settings tab,
  off/empty by default): a watched nickname's new match with both Twitch VODs goes to the
  **front** of tonight's queue (block list still wins); not in Needs-you.
- **The NAS** (`//192.168.0.240/homelab`, CIFS): `/archive` holds published matches (recoverable
  delete). `/home-media` is the whole share — **the operator's movies, music, backups; never
  touch them** — except `/home-media/mcsr-replayoffs/` (the pipeline's own folder: `vods/`,
  `research/`, `backups/`; at most 300 GB, every write logged to `ledger.jsonl`). **Transfers run
  only 03:00–08:00 Warsaw** (`inNasWindow`, DST-correct) — outside it, a copy defers to the next
  night's sweep. Free SSD space by archiving first, not by deleting.

## Telegram bot

One morning report at `telegramReportHourWarsaw` (config-file edit only, like `nightlyUpload`),
Europe/Warsaw, DST-correct; every slash command answers fresh. Runs inside the dashboard process
(`server.ts` → `startTelegramBot()`) over the Bot API's `fetch` directly (`src/telegram/bot.ts`) —
long-polling, no webhook.

- **Secrets**: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `/app/.env`. No token: nothing runs. A
  token with no chat id: `/start` reports the chat id to add. **Only one poller** — a test server
  (`PORT` ≠ 8080) never starts it; a 409 from `getUpdates` means another process is polling and
  this one backs off.
- **Claude Haiku is the brain, code is the facts.** `facts.ts` gathers every number/list/link
  deterministically; only TODAY's headline+to-do and `/ask`'s answer come from Claude via
  `src/telegram/claude.ts` (`runClaude`): `claude -p --model claude-haiku-4-5-20251001
  --output-format json --tools "" --strict-mcp-config --disable-slash-commands
  --no-session-persistence --setting-sources ""`, prompt on stdin, plain argv (never a shell). No
  project CLAUDE.md/hooks/plugins/user settings load. Env allow-list: `PATH`, `HOME`, `LANG`,
  `TMPDIR`, plus `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` if set — **never the Telegram
  token or any other secret**. **No viewer comment text or author name is ever put in a Claude
  prompt** (`/ask` included, and `handbook/knowledge/*.md` that `/ask` also reads) — only counts,
  titles, ids. The adapter never retries; a usage-limit answer reads exactly "usage limit reached
  — try again later" everywhere; any other failure falls back to `fallbackToday` with the reason
  shown.
- **The report is three messages**: the day (**Needs you** at top, then **Auto-saved hooks**,
  Claude's headline+to-do, Problems, overnight, health), the channel (counts, stats table, YPP
  countdown), the comments (grouped by video, capped to 4096 chars). HTML parse mode; every
  dynamic string through `escapeHtml`.
- **"Needs you"** (`gatherNeedsYou`, deterministic, "Nothing today." when empty): a failed
  `short-<id>.status.json` step; Studio signed-out/verify/wrong-channel; no long-form scheduled in
  48h; with `shortsByHand` on, a long-form due in 36h or public ≤3 days with no hand-cut Short; a
  public or scheduled long-form/Short title whose hook fails `hookProblem` (video id + problem,
  never the hook); a blocked runner in tonight's queue or as a recent comment's author; an `.experiments.json`
  `needsHuman` entry; the Studio worker's heartbeat over 90 min old or `sameErrorStreak` ≥3.
  `/needs` answers this section alone, fresh.
- **A link about one match opens that match** (`#match=<id>` in `public/app.js`). Dedupe is
  `.telegram.json` (atomic write) — a restart that missed 07:00 still sends before 10:00 Warsaw
  if today isn't recorded yet. **Every YouTube link the bot sends opens Studio, never the public
  watch page.** `/health` pings Claude for real (~30s); the dashboard container needs its own
  login (`claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN` in `/app/.env`) or every Claude call
  fails "auth".
- **Reports reach Telegram because they are sent, not by a hook**: write to a file, `npm run tg --
  send --md <file>`. A report = a finished task's end, a write-up, an artifact link — not a quick
  answer, a progress note, or a question to the operator. Every bot command is read-only — no
  uploads, renders or queue edits.
- Plain replies from the operator's chat are saved to `.telegram-inbox.jsonl`; `npm run tg -- inbox`
  prints them.

## Studio automation

Does what Studio has no API for: pinning, end screens, Test & Compare, related-video linking.
Gated by `studioAutomation` (not writable from Settings, a deliberate edit on the box, like
`nightlyUpload`/`youtubeUploadEnabled`). A separate Google account added as channel **Editor**
(not owner), 2FA on, is recommended — it keeps the owner account out of the blast radius of
anything Google's anti-abuse systems do to a container-run browser.

- **How it works** (`src/youtube/studioBrowser.ts`): a real, headed `google-chrome-stable` on
  Xvfb, login profile in the `studio-profile` volume. Automation connects with Playwright's
  **`chromium.connectOverCDP`** — **never `chromium.launch()`**, which stamps automation markers.
  **Nothing here ever types a password, answers 2FA, solves a CAPTCHA, or opens
  accounts.google.com on its own** — the operator signs in by hand over a remote screen whenever
  Google asks. `probe()` classifies the session (`ok`/`signed-out`/`verify`/`wrong-channel`) at
  the start of every job; **a `verify` or `signed-out` result is recorded as that attempt's error
  and chased no further until the operator logs in again — never retried in a loop.** The active
  channel is MCSR Replayoffs — switching is not a plain click, the switch is on the confirm
  dialog's **"Got it"** button.
- **Safety rails**: never types a password or touches 2FA; **never unpins, replaces, or removes a
  pin, end screen, related-video link or running Test & Compare set by hand** (each action checks
  for an existing one first, e.g. `pinComment` returns `"already-pinned"`). **One browser session
  at a time** (in-process lock plus the profile's own `SingletonLock`). **Human-paced**: random
  2–6s pauses, ~20 min ± 3 min between worker cycles. **Never runs 02:50–07:30 UTC by default**
  (`inBlackoutWindow`, derived live from `nightlyRenderHourUtc`) — Chrome and ffmpeg share the
  lab's four cores. Per-cycle caps: ≤3 end screens, ≤2 Test & Compare starts, ≤3 related links,
  ≤3 pins.
- **`.experiments.json`'s read-merge-write is serialized through a lockfile**
  (`withExperimentsLock`, `.experiments.json.lock`, stale after 30s) since the worker's cycles and
  a one-off CLI write it from separate processes; unguarded, concurrent writers crashed outright.
  The dashboard's own `src/dashboard/experiments.ts` doesn't take this lock, so a race there is
  still possible.
- **The worker plans a thumbnail Test & Compare on every new dashboard long-form itself**
  (`thumbnailTcTargets`, ≤2 a cycle): `npm run tc-thumbs` renders control + the most different
  non-result-looking pose (+ a caption of ≤6 chars when `tcCaption.ts` passes one); it starts on a
  later cycle. A running test is read once a UTC day; **Studio's "Results ready"/"Test finished"
  means done** (`readTestAndCompare` + `parseTcReport` read the report's watch-time shares and
  winner; `setExperimentChecked` records `watchTimeShare` per arm and "<arm> wins: a% vs b%").
  End screens get the editor's starter layout ("1 video, 1 subscribe") when the video has none.
- **The worker never sets a Test & Compare winner itself** — `"done"` only records what Studio's
  own page already shows; `"needsHuman"` lands on anything it couldn't get past — a Save with no
  "Changes saved" too, an error that leaves the experiment planned, never "started". Every title is
  checked before any page opens (`titleTestProblem`: `hookProblem` incl. `hookLabelProblem`,
  `spoilsTheResult`, 100-char ceiling).
- **The worker's own gate is `opts.enable` (CLI `--enable`, or env `STUDIO_WORKER=1`) OR'd with
  `config.studioAutomation`** — not the dashboard flag alone (the dashboard container has no
  Chrome). A supervisor (`scripts/studio-worker.sh`) restarts `npm run -s studio -- worker
  --enable` 60s after any exit, pidfile refuses a second start: `nohup bash
  /app/scripts/studio-worker.sh >/dev/null 2>&1 &`
- **Related video linking** (`linkRelatedVideo`) links a Short to its long-form, no privacy
  filter either side. **The worker also pins** (`pinTargets`): every PUBLIC, unblocked long-form
  whose channel comment has posted and whose pin isn't done, capped at `MAX_PINS_PER_CYCLE` (3)
  after the day's skips (`pinsThisCycle`); end screens skip a blocked match too. Shares the one
  `finished.pin` ledger field with the dashboard's own gated pin path. Drive all of this with
  `npm run studio --` (see Commands).

## Clips (prototype)

For a video that is not a match — a stream statement, a reaction. `remotion/ClipFrame.tsx` is the
reusable frame (title band, 16:9 window, nameplate, MC/SR badge — the thumbnail/overlay look).
`npm run clip` gets the source (yt-dlp or a local file), renders the frame, composites to
`<mediaDir>/clips/<slug>/clip-<slug>.mp4` — **nothing here uploads or posts anywhere**. `clips/`
is non-numeric, so every `mediaDir` scan (`/^\d+$/`) skips it.

## Chat replay (prototype)

`src/api/twitchChat.ts` fetches a VOD's chat via Twitch's web GQL persisted query, paging by
**offset** (the cursor fails Twitch's integrity check without a browser token). Saved after
`download-vods`; the Short scorer reads it. `remotion/ChatPanel.tsx` renders it, not yet wired
into `src/pipeline/pipeline.ts`.

## Session preflight

`scripts/preflight.sh` runs at session start, always exits 0, prints one line when fine. Fix
anything it flags (no GitHub credentials, a read-only PAT, an expiring token) first.

## Known pitfalls

- **Season vs career stats**: `pickStats` (`src/pipeline/overlayProps.ts`) falls back to career
  totals only when the season bucket has no ranked games (labelled CAREER) — don't "fix" away.
- **A private room's two seats are ordered by uuid** (`withoutGhostPlayers`) — everything
  left/right hangs off `match.players`; ranked matches keep the API's order.
- **Elo must come from the match, not the user** — use `eloAtMatchStart()` everywhere. **Props
  functions are async** (`computeOverlayProps`/`computeThumbnailProps`) — a missing `await`
  renders a pending promise as player data.
- **Never import `Overlay.tsx` from Node code** — `import "./overlay.css"` crashes outside
  webpack; shared geometry is in `remotion/layout.ts`. **MLT silently drops ProRes 4444's alpha**
  — VP9 `yuva420p` is the only alpha format MLT composites; decode with `-c:v libvpx-vp9` when
  spot-checking.
- **Timeline zero is the countdown's first second** (`ANCHOR_SEC`, `src/pipeline/kdenliveProject.ts`):
  match start is at 10s on the timeline. **The finished MP4 is not the timeline** since
  `export:fast` cuts `headTrimSec` off the front — read `exportMatchStartSec(dir, id)` (10 without
  a record), or a series' `series.json` (`matchStartSec`/`gameMatchStarts`), never assume 10s on
  the export itself. The sync editor and stills are still timed on the timeline, pre-cut.
- **`exportUpscale1440`** (default off): scales the composited 1080p frame to 2560x1440 right
  before encoding; off keeps the filter graph byte-for-byte unchanged. A series needs every game
  at the same setting — `assembleSeries` refuses to mix resolutions.
- **When the detector is unsure, a human settles it** (`GET/PUT /api/sync/:id`,
  `src/pipeline/syncEdit.ts`): saving stamps `source: "manual"`, `confidence: 1`, so a re-render
  keeps the hand fix instead of re-running the detector. Only clip placement changes — the fix is
  `export:fast` (~10 min), not a re-render, and **not optional**: a sync.json correction after
  export leaves the published video out of sync until re-exported. `exportStale` refuses
  Upload/nightly/adopt with one line until re-encoded.
- **A Twitch archive outlives the stream by 14 days** (60 for partners), chat too —
  `withDiscoveredVods` caches what it finds to `vods.json`; `npm run download-vods -- <id>`
  secures a match ahead of render. **Every consumer places clips from `sync.json`**
  (`src/pipeline/syncFile.ts`) — without it, `export:fast`/the Short fall back to
  `config.preRollSec` and run early; `npm run sync-status` backfills.
- **Sync reads the picture, and only the picture** (`src/pipeline/countdownDetect.ts`,
  `detectMatchStartAny`): the countdown digit (works in a private room, no camera freeze needed)
  and the 10s camera freeze; no audio fallback (removed — too often wrong). Prefer the detector's
  reading when confident; the hand editor is for a clip it cannot read (its own anchor is coarse
  — ±1s of the true 0:00).
- **The intro card is a versus screen** (`remotion/Intro.tsx`): every animated element positions
  via left/top in CSS, never a CSS `transform`. No head-to-head on a playoff game; country flags
  render as tofu (cosmetic). **tini is PID 1**; if `ps -eo stat | grep -c ^Z` climbs, wrap in
  `python3 scripts/reap.py`.
- **`ss` is there; `lsof`/`fuser` are not** — `ss -tlnp | grep <port>` names the real listener,
  which a `ps`-found PID is not always. **The playoffs board lives inside `#suggestions`, rows
  carry `.sugg`** — match `#suggestions > .sugg`, or a check waits forever on a hidden fold.
- **A failure reports under the control that caused it** (`failAt`, `public/app.js`) —
  `clearFailAt` at the start of an action, report after a repaint, not before. **No Clipboard API
  on the lab's dashboard** (plain http) — `copyText` falls back to `document.execCommand("copy")`
  and returns whether it worked; never mark "Copied" without checking.
- **A cut-short upload resumes its own session, never trusts a record.** A restart mid-upload is
  settled through `resumeUpload`'s `resumeOnly` (never falls through to a second upload); no
  session + a `source: "dashboard"` record is trusted done; anything else fails the step, naming
  Studio.
- **Verify visual changes by rendering** (`npm run still`, then read the PNG). Run
  `npm run test:unit` after any edit, `npm test` (drives Chromium+ffmpeg) after touching rendering
  or asset generation; `test:unit` runs on `DEFAULTS` so a Settings-tab switch can't break it.
- **Generated projects carry `<mlt root>`** with every resource relative to it, so a lab-rendered
  project opens on the desktop too.

## Version control

Long-lived branches are normal. Before concluding a feature doesn't exist, check `git branch -a`,
`git worktree list` and the remote. Sessions run concurrently in `.claude/worktrees/`: check for
another session's uncommitted work before staging, and **never `git add -A` on a shared tree.**

## Branding

One pixel-art Minecraft identity across overlay, thumbnails, channel art and reports:

- **Font:** Monocraft (`remotion/assets/fonts/`), `--pixel-font` in `remotion/overlay.source.css`.
- **Palette:** custom properties at the top of `remotion/overlay.source.css` (`--panel` …
  `--muted`) — don't invent new colours for thumbnails, channel art or docs.
- **Badge:** the replay ring + MC/SR monogram, defined once in `remotion/pixelBadge.ts`, drawn by
  `<PixelBadge />` — change it there, never by re-inlining SVG; must render after its siblings in
  `Overlay.tsx` or the header bar paints over it.
- **The overlay wears the thumbnail's look**: mid-value crimson/warped split with checker, each
  name/head on a thumbnail plate (`.plate`), hard pixel shadows only (no blur, none past a band's
  edge). Matches rendered before this keep the old look.
- **Channel art:** `branding/logo.png` + `banner.png` from `branding/generate_brand_assets.py`
  (`branding/README.md`).
- **Brand and launch plan:** https://claude.ai/code/artifact/82c863d6-1bf5-4e01-b679-a2a3c40fcc80
