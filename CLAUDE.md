# mcsr-vid

Full rationale and history per feature: `handbook/claude-md-reference.md`. Read the matching section before changing that feature.

Turns an MCSR Ranked match id into a synced, split-timer-overlaid video (`fetch-match` →
`download-vods` → `validate-sync` → `render-overlay` → `generate-project` / `export:fast`), plus
thumbnails and a Short, published to **MCSR Replayoffs**.

## House rules

- **Match footage is never cut.** Only two regions are editable, both automated: before the match,
  and the tail (`ANCHOR_SEC`, `src/pipeline/postRoll.ts`; tail ≤ `postRollSec` = 30s, cut earlier
  where the winner goes quiet, never under 15s).
- Each POV's audio leans toward its side (`povAudioPan`, default 0.7) in `export:fast` only; the
  Kdenlive MLT mix stays centred. The Short lowers the off-focus POV 12dB instead (`focus`).
- **Nothing names the winner**: no result line in descriptions, no winner in a hook or thumbnail.
  The upset hook is a question; a runner named at the End spoils.
- **No runner nickname, label or epithet but the operator's own** (`runnerNicknames`: "NICK vs
  NICK" only when both runners have one; nothing invents one; `hookLabelProblem`,
  `src/pipeline/hooks.ts`; `hookProblem`'s `players` arg, `src/shorts/videoPick.ts`; `withHook`,
  `src/pipeline/title.ts`). A word on the short denied list (`HOOK_DENIED_LABELS`, deliberately
  not exhaustive) is refused outright; a fresh "X vs Y" must name the match's own two players
  (API, `titleNames` or the operator's own `runnerNicknames` spelling) or it is a label too. A
  model's proposal and a carried `hookText` fail closed on a label the same way `hookProblem`
  does (a carried value is checked for labels only). Only the operator's own **typed** hook
  always saves: the problem lands as a warning in `saveWarnings`, never a refusal.
- **No seed, rank or elo in hooks or hook suggestions, and none in what orders the match
  suggestions** (a suggestion card's story line may still show rank/elo to the operator).
- **No DNF match** (nobody finished; `matchIsDnf`): never suggested, rendered, given hooks or
  posted, queued or not — except playoff games, always posted as is.
- **The YouTube API compliance audit has cleared** (`handbook/api-review/`); it gates only
  `videos.insert`. `youtubeUploadEnabled` is true, `nightlyUpload` is `"scheduled"`. Keep every
  API call inside what the recording showed: **own channel, own data, nothing shown to anyone
  else.** Google may re-review.
- Nothing irreversible without the operator: deletions, retitles on the live channel, config that
  changes what a nightly render does.
- **Studio automation stays inside the audit's own rule** too (see "Studio automation").

## Layout

| Folder | What lives there |
| --- | --- |
| `src/api/` | MCSR Ranked (`mcsrApi.ts`, `types.ts`), Twitch (`twitch.ts`, `twitchChat.ts`), avatar renders. |
| `src/pipeline/` | Match to finished video: fetch, VODs, sync (`countdownDetect.ts`, `sync.ts`, `syncFile.ts`, `syncEdit.ts`), overlay (`overlayProps.ts`, `overlayRender.ts`, `splitStates.ts`), Kdenlive project, `export:fast`, text (`title.ts`, `description.ts`, `hooks.ts`, `chapters.ts`); `pipeline.ts` runs the stages. |
| `src/thumbnails/` | The variant strip and its manifest. |
| `src/shorts/` | The model's pick (`videoPick.ts`, `watchPov.ts`, `pickCli.ts`), heuristic fallback, reasoner, vertical render, `generateShort.ts`, `handShort.ts`. |
| `src/playoffs/` | Bracket and games (`playoffs.ts`), a series as one video (`series.ts`, `seriesCli.ts`). |
| `src/youtube/` | Data API client and auth, upload records and upload, channel pairing, publish slot, Studio automation (`studioBrowser.ts`, `studioActions.ts`, `studioWorker.ts`). |
| `src/dashboard/` | Web server (`server.ts`), route groups (`youtubeRoutes`, `exportRoutes`, `shortsRoutes`, `syncRoutes`), match screen payload (`matchMeta.ts`), jobs, nightly, suggestions, the shelf (hidden/queue/checklist), publish set, experiments. |
| `src/telegram/` | `bot.ts`, report (`facts.ts`, `report.ts`), Claude CLI adapter (`claude.ts`), `/ask` (`knowledge.ts`), schedule (`schedule.ts`), `commands.ts`, dedupe state (`state.ts`), `index.ts`, `tgCli.ts`. |
| `src/clips/` | Standalone clips: `clipCli.ts` (+ `clipArgs.ts`) behind `npm run clip`. |
| `src/cli/` | Entry points nothing imports: batch, status, score, chat, bench, retention, the TUI. |
| `src/` root | `config.ts`, `cliArgs.ts`, `errorText.ts`, cross-folder tests. |

Tests sit beside what they test (`foo.test.ts` next to `foo.ts`); fixtures are `src/fixtures/`.
`remotion/` is the compositions; `public/` the dashboard's browser files; `scripts/` browser
checks and build/preflight helpers; `docs/` the GitHub Pages site (repo docs: root `README.md`).

## Commands

Use the script, don't reconstruct the shell line. Extra arguments go after `--`.

| Script | What it does |
| --- | --- |
| `npm run dashboard` | The web dashboard (`PORT`, default 8080). |
| `npm start` | The terminal UI (`src/cli/tui.tsx`). |
| `npm run still -- <Composition> <out.png> [--frame=N] [--props=p.json]` | One Remotion frame to PNG (rebuilds overlay CSS first): the fast visual check. Ids in `remotion/Root.tsx`. |
| `npm run validate-project -- media/<id>/match-<id>.kdenlive` | Loads the MLT XML through MLT. Exit 0 = parses; missing media still passes. |
| `npm run export:fast -- <matchId> [--cpu] [--seconds=N] [--full-tail]` | One ffmpeg pass (Intel VAAPI), no Kdenlive. `--seconds` writes smoke test `smoke-<id>.mp4`, never the real final. |
| `npm run export:nvenc -- media/<id>/match-<id>.kdenlive [out=N]` | melt + `h264_nvenc`. Needs an NVIDIA GPU; the lab has none. |
| `npm run short -- <matchId> [--at=<ms>] [--seconds=N]` | Vertical Short from the pick's window. Refuses without the hook (`short-<id>.hook.txt`), once on YouTube, or while `shortsByHand` is on. |
| `npm run short:hand -- <matchId> <file.mp4> --hook "<hook>" --from <sec> --to <sec> --pov left\|right [--note]` | Registers a hand-cut Short (`shortsByHand`); see Shorts. |
| `npm run series -- <matchId \| all> [--join-only]` | Renders every game missing an export, joins into `series-<g1>.mp4`. Nightly cannot see a run here. |
| `npm run sync-status -- [matchId]` | Where a match's POV clips sit; writes `sync.json` if missing. No id: lists all, writes nothing. |
| `npm run chat -- <matchId>` | Fetch both players' Twitch chat for a match that saved none. |
| `npm run clip -- <twitch url \| file> [--from=HH:MM:SS --to=HH:MM:SS] --title="…" --speaker="…" --when="…" --credit="…" [--slug=…] [--seconds=N]` | A standalone clip, not a match; see Clips. |
| `npm run tg -- report --dry-run` | Morning report printed, nothing sent. **Prints real viewer comment text**: prefer `cmd "/needs"` / `"/ypp"` / `"/stats 7d"`. `send --md <file>` sends to the operator; `whoami` prints chat ids. |
| `npm run x -- post <id> [--dry-run] \| auto \| status` | One X post; see X posts. |
| `npm run pick -- <matchId \| all> [--force] [--dry-run]` | Ask the model for the Short's moment. `--dry-run` asks afresh and writes nothing; refuses (exit 1) only when the proxy or a /watch cache would have to be made first. |
| `npm run bench -- <Composition> [--frames=N] [--codec=] [--pixelFormat=] [--concurrency=N]` | Render throughput; measure before claiming a render change is faster. |
| `scripts/seed-icons/icons.sh [TYPE…]` | Re-render thumbnail seed-type icons. |
| `npm run retention -- <videoId>… [--days=90]` | Audience retention per video, per decile. |
| `npm run config:example` | Rewrites `mcsr-vid.config.example.json` from `DEFAULTS`; run after adding a config key. |
| `npm run analytics -- <videoId> [--traffic-sources] [--days N]` | YouTube Analytics via `~/.claude/skills/claude-youtube/`. |
| `bash scripts/agy-task.sh <name> <prompt-file> [model]` | Hand an easy task to agy (Gemini) in a worktree; review the diff and commit yourself. |
| `python3 scripts/reap.py <command…>` | Subreaper wrapper (tini is PID 1) if zombies climb. |
| `[SCRATCH=1] bash scripts/browser-checks/run-all.sh <url>` | 26 Playwright checks in a real browser: read-only against the real dashboard; the four that write run only with `SCRATCH=1`, against the stub or a scratch server. |
| `npm run tc-thumbs -- <matchId…>` | A Test & Compare thumbnail set per match in `<id>/tc/` (control, most-different pose, caption). |
| `npm run studio -- probe \| pin <id> [--dry-run] \| login \| worker [--once] [--dry-run] [--enable] \| tc-plan <plan.json> \| related <id> <id> \| link-related <shortId> <longFormId> [--dry-run]` | Studio browser automation CLI. |

Lab timings (10-minute match): overlay ~9 min, `export:fast` ~10 min, a Short seconds; nightly
~12 min, ~21 with the MP4.

## What the render produces

Almost nothing moves, so the render is stills plus one strip (`src/pipeline/overlayRender.ts`):

- `overlay-top.png`: identity/stats band, static; a playoff game shows series dots and seed in the
  rank's place. `overlay-top-end.png` adds the winner's dot; `export:fast` switches at `topEndAtSec`.
- `overlay-splits-<n>.png` + `overlay-splits.json`: the meta+splits region, one still per distinct
  state (`src/pipeline/splitStates.ts`); the manifest, written last, means "render finished". Last
  state is the subscribe card (`postRollCta`, `ctaFrameOf`); `ctaReason` (Settings → Publishing,
  ≤24 plain-ASCII chars, empty = bare card) shows above SUBSCRIBE.
  `renderOverlay({ only: ["splits"] })` redoes just these in seconds.
- **COMING UP card** (`teaserFramesOf`): from `teaserAtSec` (default 10, Settings → Publishing,
  empty = none) for `teaserSec` (5). Moment from `src/pipeline/teaser.ts`, `match.timelines`
  only; never in the first/last minute, names nobody, reads `death` only (never a hunger reset).
- **Explain the moves** (`explainMovesSec`, default **null = off**): the first time either player
  reaches one of six `MILESTONES` splits, the meta column says why (`MOVE_LINES`,
  `src/pipeline/explainMoves.ts`); names nobody; a card waits out an overlap, none reaches the finish.
- `overlay-timer.mp4`: the RTA column, the only thing rendered per frame.
- `overlay-intro.webm`: the versus-screen intro (`remotion/Intro.tsx`), `introSec` long (Settings →
  Publishing, 2–7, default 7). Lies *over* the frozen countdown, never moves the timeline anchor.
  `export:fast` cuts `7 - introSec` off the countdown head (`headTrimSec`), so match start lands at
  `introSec + 3`s (default 0:10); Kdenlive stays at 0:10.
- `overlay-countdown-teaser.png`: COMING UP line across both POVs (`countdownTeaser`, default off,
  needs a teaser moment); `export:fast` shows it from card end to match start.
- **Retention opening** (x5; `introStats`, `stakesLine`, `explainMovesStyle` panel|banner,
  `gapChips`, `coldOpenSec`; all default off): big lines over the frame (`src/pipeline/banners.ts`),
  naming nobody. The cold open (`src/pipeline/coldOpen.ts`) is planned at export, joined in front
  (`-c copy`) when the hooks are saved, `final-<id>.base.mp4` kept until upload; it shifts
  `matchStartSec`.

## Shorts

Contract `src/shorts/shortPlan.ts`. The model picks a real moment; a fixed window ending on the
finish spoils and underperforms.

- **`shortsByHand`** (Settings → Publishing, default **off**): the session cuts every Short by hand.
  On, the chain skips its own pick/render for the Short and the long-form uploads at its slot
  without waiting. **The pick after export still runs** (`ensurePick`; auto-hooks needs its title
  hooks); its window is only a hint. `npm run short:hand` (`src/shorts/handShort.ts`) validates
  first (`checkHandShort`: 1080x1920 h264+aac ≤60s; hook passes `hookProblem`, refused outright,
  never a warning, unlike a typed dashboard hook; no blocked player; not already uploaded from
  here — `youtube-short.json`), then writes `short-<id>.mp4` + `.title.txt`/`.description.txt` +
  `short-<id>.hand.json`, which `uploadTextFor` reads like a rendered Short. Until then the chain
  logs "waiting for the hand-made Short" (never a failure). `noShort`/a blocked player still mean
  no Short.
- **A model watches the whole match and picks the moment** (`src/shorts/videoPick.ts`,
  `pickShortMoment`): a 2fps proxy, /watch's stills/transcripts per player (needs `GROQ_API_KEY`),
  then Antigravity (`agy`, `gemini-3.8-flash-high`, `--sandbox`, never
  `--dangerously-skip-permissions`). Answer: a continuous 12–60s window
  (`SHORT_MIN_MS`/`SHORT_MAX_MS`), a focus side, a hook suggestion, a one-line why (operator's eyes
  only); validated for bounds and `rtaAtStart` within ±2s. One retry on an empty answer, then the
  timeline heuristic (`shortMoment.ts`). Pick is `short-<id>.pick.json`. It also proposes up to 3
  long-form title hooks (`titleHooks`) styled on the operator's past saved hooks; each must pass
  `hookProblem` (a word-list spoiler/label/seed check: catches the usual result verbs, not every
  paraphrase) and fit the title's `hookMax`, which the prompt states, or is dropped — the
  operator's Save is the real gate. A rejected window drops its title hooks too.
- **No Short renders and nothing uploads before the operator saves the hooks**
  (`generateShort.ts`, `youtubeUpload.ts` `hookRefusal`, every render path). The Short's hook is
  `short-<id>.hook.txt`; the long-form's is the edited title. Saving both
  (`PUT /api/shorts/hooks/:id`) starts the chain (`src/dashboard/shortFlow.ts`): render Short,
  upload long-form at its slot, Short 18h later. A hook changed before upload re-renders; after
  upload hooks lock. "No Short for this one" lets the long-form go alone.
- **On screen** (`remotion/Short.tsx`): hook 4s, race captions (a leader may be named mid-race,
  never the result), running clock, off-focus POV at -12dB, closing card ("WHO TOOK IT? FULL MATCH
  ON THE CHANNEL" if the window ends undecided, else "FULL MATCH ON THE CHANNEL"). Title:
  `<hook> | <left> vs <right>` with `titleName` (Skycrab, lowkey) + `#mcsr #minecraft`.
- **`deathKind`** (`src/pipeline/matchScore.ts`) is the one reading of `death_spawnpoint`: a hunger
  reset in every phase but the End, a real death in the End. `metrics.deaths` counts real deaths
  only; the prompt, captions/hook, heuristic, title chips and "N deaths" follow it (`teaser.ts`
  stays stricter, above).
- **A playoff game's nameplates show the seed, not the ladder rank.** A series is picked/cut from
  game 1's directory, clips from the picked game's.

## Dashboard

`src/` is read at boot; `public/` is served from disk per request (client-only changes need just a
reload). After merging server changes, `POST /api/restart-when-idle`.

- **Restart only when idle** (`src/dashboard/restartWhenIdle.ts`): `POST /api/restart-when-idle`
  arms, `DELETE` cancels, `GET` reports. `idle()` checks a render (pipeline or Short), an export,
  the pick queue, the publish chain, an upload, a `.upload-session-*.json` under a day old, an NAS
  copy and the time before `nightlyRenderHourUtc`; idle, it runs `npx tsc --noEmit`, then exits
  and tini brings it back on the new code. **A hand `docker restart mcsr-dashboard` must never be
  issued while a chain uploads.**
- **Two screens, one bar**: list and match; four list tabs are the only navigation. The match
  screen groups **Now**, **Check**, **Package**, **Publish**. Now's steps
  (`GET /api/shorts/plan/:id`): Video, Pick, Hooks (locked once uploaded), Short (skipped if
  `noShort`), Video up, Short up.
- **Suggestions** (`src/dashboard/suggest.ts`): cached in `.suggest-cache.json` (`CACHE_VERSION`
  5), rescanned periodically; one card per pair across close/chaos/`known` buckets, and the known
  bucket caps one slot per player too (`suggestKnownSlots`, default 4).
- **Favourite players, then known** (`tierFor`; `favouritePlayers` Settings tab, default
  doogile/Feinberg/Infume/Pinne/lowk3y_/silverrruns/edcr). Order: favourite → known → neither, then
  expiring → close → audience → popularity. Known: a favourite, a measured draw ≥
  `KNOWN_DRAW_MIN` (0.6), or Twitch followers ≥ `knownFollowerThreshold` (10,000). No-names
  never render; mixed weekly; close/sub-8 reorder, never a hook.
  `learnedDraw`/`recordPaceBoostSec` (Settings tab, both default **off**) reorder by
  real/near-record stats without naming or implying the winner.
- **Blocked players** (`blockedPlayers`, Settings tab, default `["Aquacorde", "BeefSalad"]`;
  `isBlockedPlayer`/`blockedIn`, `src/config.ts`, whole-string, case-insensitive): runners who
  withdrew permission for their footage. `blockedOnDisk`/`hasBlockedPlayer`
  (`src/dashboard/matchStatus.ts`, `src/youtube/youtubeUpload.ts`) check the POV clips, saved chats
  (`chat-<nick>.json`) **and** the title's "A vs B" pair, so a match archived off disk is still
  caught (the Studio worker's `realIsBlocked` shares this check).
  A blocked match leaves the suggestion pool even if already in it, never shown however stale the
  cache; **never rendered by the nightly even if queued (the block is the only gate that
  outranks the queue)**; never "worth rendering today", never uploaded (long-form or Short), never
  given saved hooks, never rendered by `npm run short`/`short:hand` even by hand, never a past-hook
  style example. `finishOnYouTube` carries the refusal to Adopt/Finish/nightly-retry alike; Adopt
  also refuses before `videos.update`; `POST /api/render` and `POST /api/series/:id/render` refuse
  before the run starts; `runPipeline` refuses right after the match fetch, so
  `npm run batch`/`generate-project` and the TUI do too.
- **Rival posts** (`rivalChannelHandle`: `mcsrmatches`, `mcsr-vault`): public feeds, no token;
  "this match" (id, else pair/date) sorts after fresh ones, "this pair" only shows.
- **Hook chips** (`src/pipeline/hooks.ts`) are never about what happens in the match — no
  margin, lead, death or pace — only the setting, a forfeit and a real head-to-head rivalry; a
  close finish (under 1s) is the one case a number still shows (`titleEventProblem`). A title
  hook is `titleOptions.ts`'s own first option: the operator's `runnerNicknames` pair when both
  players have one, else a title-only model call (no video), else a chip. A joined series' chips
  read the game that decided it, not game 1's. `midRollCtaAtSec`
  (Settings → Publishing, default 90, null = none) shows SUBSCRIBE for `midRollCtaSec` (4)s at the
  first split. `titleNames` (default
  `{ Pinne: "Skycrab", lowk3y_: "lowkey" }`) spells two players the broadcast's way, title only.
- **`nightlyUpload`** is `"scheduled"` (**not writable from Settings**): once hooks are saved the
  chain uploads private, scheduled for the next free slot (19:00 UTC ranked / 23:00 series) or the
  kit's Publish-at time, Short 18h later. `"private"` = no publish time; `"off"` = chain stops after
  render. Picking and claiming the free slot is one serialized step (`claimSlot`), so concurrent
  chains never collide on an hour.
- **Auto-hooks** (`autoHooksAfterHours`, Settings → Publishing, default **null = off**): a match
  whose hooks go unsaved this many hours after its pick gets `titleOptions.ts`'s own first title
  option and a Short hook the dashboard's own first offer, both upper-cased, then the chain runs
  as if Save were pressed. Due: readable pick, unsaved, not hidden, neither video on channel, not
  blocked, export not stale, sync sound or hand-set, series joined, nothing already running. No
  survivor: nothing saved, the `hooks` step fails into Needs-you. Logs to `autoHooks` in
  `short-<id>.status.json`.
- **Thumbnails** (`remotion/Thumbnail.tsx`): two big figures, name-only plates, seed type above the
  VS, no rating/seed/placement text. Four pose pairs; `thumbnailRotatePoses` (default off) rotates
  by match id. **"cheering-relaxing" is excluded from every fresh automatic pick**
  (`RESULT_LOOKING_POSE_KEY`, reads as the result); operator pick only.
  `playoffThumbnailStyle` is **not wired** into any render yet.
- **Re-render a match's thumbnails beside the live set, never over it**
  (`src/thumbnails/rerender.ts`, `src/youtube/thumbnailSwap.ts`, `src/dashboard/thumbnailRoutes.ts`,
  `src/dashboard/busy.ts`): variants render into `thumbnail-new/`; live files
  (`thumbnail.png`, the manifest) change only on an operator press ("Use this" off the channel,
  "Put on YouTube" / "Undo on YouTube" on it). Blocked players and the cheering-relaxing exclusion
  apply as everywhere. A re-render or pending put counts as busy for `restart-when-idle` and the
  nightly.
- **`videos.insert` is the only call the audit gated.** `playlistItems.insert`, `thumbnails.set`,
  `commentThreads.insert`, `videos.update` are inside `force-ssl` scope, so **Finish on YouTube**
  repairs a Studio upload too, but leaves the thumbnail alone on a video whose variant nobody
  confirmed here. **`videos.update` replaces the whole part it is given**: `addTags` reads the
  snippet and sends it back whole (omitting description would blank it) and only ever adds tags;
  `reschedule` does the same with `status`; both refuse to write if the read returns no video.
  `youtubeUploadEnabled` gates starting an insert; a session begun while it was on is still
  finished by `resumeUpload` after a restart.
- **Adopt a Studio draft** (`POST /api/youtube/adopt/:id`): writes title/description/tags via
  `videos.update` onto a video pasted by id, then runs finish steps. Not behind
  `youtubeUploadEnabled`. Refuses: malformed id, an id already recorded for another match **or as
  any match's Short**, a video ≤3 min, a title still reading `<HOOK>`, a non-pairing description,
  no `chosenBy: "operator"` thumbnail variant, someone else's channel, **a blocked
  player**.
- **Upload** refuses a title still containing `<HOOK>`; adds the video to the season, a matchup and
  a player playlist. **`playlists.insert` caps ~a dozen per rolling 24h** (429); the nightly's
  `retryFailedPlaylists` tick retries on its own. A published long-form
  queues an NAS copy.
- **Settings tab** (`src/dashboard/settings.ts`): writes `mcsr-vid.config.json` atomically, applies
  live, validated through `validateOverrides`. **`youtubeUploadEnabled`, `nightlyUpload` and
  `studioAutomation` are deliberately not writable here**: edit them on the box; the panel only reports them.
- **Publish kit** (`GET /api/publishkit/:id`): copy buttons for title, publish slot
  (`publishHourUtc` 19:00 UTC ranked / `seriesPublishHourUtc` 23:00 series, `seriesPairGapDays` 3
  apart), description, tags, Short title/description, spoiler-free pinned comment, community post,
  per-player DM. Publish-at is editable; slot rules are warnings, never refusals.
  **Publish checklist**: facts from disk + toggles in `publish.json`; Delete refuses while any job
  writes into the match directory.
- **Nightly** (`src/dashboard/nightly.ts`): at `nightlyRenderHourUtc` (default 3 UTC, null
  disables) renders the first eligible card, then the MP4, then queues the Short's pick; Short and
  upload wait for the operator's hooks. **A candidate also needs a known player** unless the
  operator queued it; a playoff pick always counts; the block list outranks the queue. Chains
  skip repeats; chain, coverage and fast-track share one night cap (`renderBudget.ts`:
  `nightlyMaxRenders` + 1 per Telegram veto in 24 h). **A test server arms its own
  nightly too**: any `PORT=… npm run dashboard` schedules against the same `/media`; kill it
  before the hour, or set `nightlyRenderHourUtc: null` for it. Chain resume, YouTube retries and
  the 15-minute tick run only on 8080.
- **The experiment engine runs between-video A/B tests unattended** (`src/dashboard/experiments.ts`
  + `experimentsEvaluator.ts`) from `.experiments.json` (atomic write, never rewritten while
  corrupt; `"tc"` = Studio's Test & Compare, untouched). A tick before `nightlyRenderHourUtc`
  applies the day's `render`-tagged entry through `saveSettings` (real `SETTINGS` keys only; a
  `slot`-tagged entry can coexist). A daily tick evaluates each per video, ≥8 a side (thresholds in
  the handbook); at `end` a winner with `adoptWinner` becomes the default, else the control arm is
  reapplied; failed evaluations on two consecutive UTC days set `needsHuman` (a day with no
  evaluation restarts the count).
- **Playoffs** (`src/playoffs/playoffs.ts`): the bracket knows the series, not the games. **No
  surface prints a series score**: round/game number only. `playoffsFirst` (default **true**) puts
  detected games ahead of suggestions. **A series is one video; game 1's directory is the series**
  (`src/playoffs/series.ts`): exports joined with `ffmpeg -f concat -c copy` into
  `series-<g1>.mp4`; chapters name each game's world, never the seed or score; the join deletes the
  games' own exports (reversible).
- **Tonight's queue** (`.dashboard.json`) bypasses `nightlySkip` and the known-player gate, but
  **not** the block list. **Creator watch** (`creatorWatch`/`creatorWatchlist`, Settings tab,
  off/empty by default): a watched nickname's new match with both Twitch VODs goes to the **front**
  of tonight's queue (block list still wins); not in Needs-you.
- **X posts** (`src/x/`; `xAutoPost`, config file only, off): the tick posts a public long-form's
  hand-cut Short + link, ≤1 a UTC day (`x.json`); blocked/spoiler/label refused. Keys: `X_*` in `.env`.
- **The NAS** (`//192.168.0.240/homelab`, CIFS): `/archive` holds published matches (recoverable
  delete). `/home-media` is the whole share, **the operator's movies, music and backups: never
  touch them**, except `/home-media/mcsr-replayoffs/` (the pipeline's own: `vods/`, `research/`,
  `backups/`; at most 300 GB, every write logged to `ledger.jsonl`). **The dashboard's transfers
  run only 03:00–08:00 Warsaw** (`inNasWindow`, DST-correct); outside it an automatic copy defers
  to the next night's sweep. `npm run archive -- <id>` is a hand copy that runs at once; run it
  inside the window. `freeLocalCopies` frees a public-48h+ file; `spaceAlarmGb` flags low disk.

## Telegram bot

One morning report at `telegramReportHourWarsaw` (config-file edit only, like `nightlyUpload`),
Europe/Warsaw, DST-correct; every slash command answers fresh. Runs inside the dashboard process
(`startTelegramBot()`, `src/telegram/bot.ts`), long-polling, no webhook.

- **Secrets**: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `/app/.env`. No token: nothing runs; no
  chat id: `/start` reports it. **Only one poller**: a test server
  (`PORT` ≠ 8080) never starts it; a 409 from `getUpdates` (another poller) makes this one
  back off.
- **Claude Haiku is the brain, code is the facts.** `facts.ts` gathers every number/list/link
  deterministically; only TODAY's headline+to-do and `/ask`'s answer come from Claude via
  `src/telegram/claude.ts` (`runClaude`): `claude -p` on Haiku with no tools, MCP, slash commands,
  session persistence or setting sources (exact argv in the handbook), prompt on stdin, plain argv
  (never a shell). Env allow-list: `PATH`,
  `HOME`, `LANG`, `TMPDIR`, plus `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` if set; **never the
  Telegram token or any other secret**. **No viewer comment text or author name is ever put in a
  Claude prompt** (`/ask` included, and the `handbook/knowledge/*.md` it reads); only counts,
  titles, ids. The adapter never retries; a usage-limit answer reads exactly "usage limit reached
  — try again later" everywhere; any other failure falls back to `fallbackToday` with the reason.
- **The report is three messages**: the day (**Needs you** first, then **Auto-saved hooks**,
  Claude's headline+to-do), the channel, the comments (capped to 4096 chars). HTML parse mode; every dynamic string through `escapeHtml`.
- **"Needs you"** (`gatherNeedsYou`, deterministic, "Nothing today." when empty): a failed
  `short-<id>.status.json` step; Studio signed-out/verify/wrong-channel; no long-form scheduled in
  48h; with `shortsByHand` on, a long-form due in 36h or public ≤3 days with no hand-cut Short; a
  public or scheduled title whose hook fails `hookProblem` (video id + problem,
  never the hook); a blocked runner in tonight's queue or as a recent comment's author; an
  `.experiments.json` `needsHuman` entry; the Studio worker's heartbeat over 90 min old or
  `sameErrorStreak` ≥3. `/needs` answers this section alone, fresh.
- **A link about one match opens that match** (`#match=<id>` in `public/app.js`). Dedupe is
  `.telegram.json` (atomic write); a restart that missed 07:00 still sends before 10:00 Warsaw if
  today isn't recorded. **Every YouTube link the bot sends opens Studio, never the public watch
  page.** `/health` pings Claude for real (~30s); the dashboard container needs its own login
  (`claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN` in `/app/.env`) or every Claude call fails
  "auth".
- **Reports reach Telegram because they are sent, not by a hook**: write a file, then
  `npm run tg -- send --md <file>`. A report is a finished task's end, not a quick answer, a
  progress note or a question. Every bot command is read-only except title-picker/veto/fast-track
  buttons (operator's chat). Plain replies from the operator's chat land in
  `.telegram-inbox.jsonl`; `npm run tg -- inbox` prints them.

## Studio automation

Does what Studio has no API for: pinning, end screens, Test & Compare, related-video linking. Gated
by `studioAutomation` (not writable from Settings).

- **How it works** (`src/youtube/studioBrowser.ts`): a real, headed `google-chrome-stable` on Xvfb,
  login profile in the `studio-profile` volume. Playwright attaches with
  **`chromium.connectOverCDP`**, **never `chromium.launch()`**. **Nothing here ever types a password, answers 2FA, solves a CAPTCHA, or opens
  accounts.google.com on its own**; the operator signs in by hand whenever Google asks. `probe()`
  classifies the session (`ok`/`signed-out`/`verify`/`wrong-channel`) at the start of every job;
  **a `verify` or `signed-out` result is that attempt's error, chased no further until the
  operator logs in again, never retried in a loop.**
- **Safety rails**: **never unpins, replaces, or removes a pin, end screen, related-video link or
  running Test & Compare set by hand** (each action checks for an existing one first). **One browser
  session at a time** (in-process lock plus the profile's own `SingletonLock`; `killOnExit` kills
  `start()`'s own Chrome/Xvfb on an uncaught exit, not a SIGKILL). **Human-paced**: random 2–6s
  pauses, ~20 min ± 3 min between worker cycles. **Never runs 02:50–07:30 UTC by default**
  (`inBlackoutWindow`, derived live from `nightlyRenderHourUtc`). Per-cycle caps: ≤3 end screens,
  ≤2 Test & Compare starts, ≤3 related links, ≤3 pins.
- **`.experiments.json`'s read-merge-write is serialized through a lockfile**
  (`withExperimentsLock`, `.experiments.json.lock`, stale after 30s). The dashboard's
  `src/dashboard/experiments.ts` skips it, so a race is still possible.
- **The worker plans a thumbnail Test & Compare on every new dashboard long-form**
  (`thumbnailTcTargets`, ≤2 a cycle; `npm run tc-thumbs` renders control + the most different
  non-result-looking pose + a ≤6-char caption if `tcCaption.ts` passes one) and starts it on a
  later cycle. A running test is read once a UTC day; **Studio's "Results ready"/"Test finished"
  means done** (`readTestAndCompare`, `parseTcReport`). **A new end screen: same-rivalry layout**
  (`addRivalryEndScreen`), else starter ("1 video, 1 subscribe").
- **A video with a title test gets no thumbnail test** (`titleTcTargets`; `ab-report` reads it).
- **The worker never sets a Test & Compare winner itself**: `"done"` records what Studio shows;
  `"needsHuman"` marks what it couldn't get past; an error leaves the experiment planned. An
  earlier experiment's finished report is not adopted (`adoptsExistingTest`): the start clicks
  New test. Titles are checked before a page opens (`titleTestProblem`: `hookProblem`,
  `hookLabelProblem`, `spoilsTheResult`, 100 chars).
- **The worker's own gate is `opts.enable` (CLI `--enable`, or env `STUDIO_WORKER=1`) OR'd with
  `config.studioAutomation`**, not the dashboard flag alone. A supervisor
  (`scripts/studio-worker.sh`) restarts `npm run -s studio -- worker --enable` 60s after any exit;
  its pidfile refuses a second start:
  `nohup bash /app/scripts/studio-worker.sh >/dev/null 2>&1 &`
- **Related video linking** (`linkRelatedVideo`) links a Short to its long-form, no privacy filter
  either side. **The worker also pins** (`pinTargets`): every PUBLIC, unblocked long-form whose
  channel comment has posted and whose pin isn't done, capped at `MAX_PINS_PER_CYCLE` (3) after the
  day's skips (`pinsThisCycle`); end screens skip a blocked match too, and for the day a video
  with no editor (`endScreensThisCycle`). Shares one `finished.pin` field with the dashboard's pin
  path.

## Clips (prototype)

A video that is not a match (`remotion/ClipFrame.tsx`): `npm run clip` writes
`<mediaDir>/clips/<slug>/clip-<slug>.mp4`; **nothing here uploads or posts anywhere**; every
`mediaDir` scan (`/^\d+$/`) skips `clips/`.

## Chat replay (prototype)

`src/api/twitchChat.ts` fetches a VOD's chat (Twitch web GQL, paging by **offset**), saved after
`download-vods`; the Short scorer reads it. `remotion/ChatPanel.tsx` renders it, not yet wired
into `src/pipeline/pipeline.ts`.

## Session preflight

`scripts/preflight.sh` runs at session start (always exits 0, one line when fine); fix what it
flags (no GitHub credentials, a read-only PAT, an expiring token) first.

## Known pitfalls

- **Season vs career stats**: `pickStats` (`src/pipeline/overlayProps.ts`) falls back to career
  totals only when the season bucket has no ranked games (labelled CAREER); don't "fix" it away.
- **A private room's two seats are ordered by uuid** (`withoutGhostPlayers`); everything
  left/right hangs off `match.players`; ranked matches keep the API's order.
- **Elo must come from the match, not the user**: `eloAtMatchStart()` everywhere. **Props
  functions are async** (`computeOverlayProps`/`computeThumbnailProps`); a missing `await` renders
  a pending promise as player data.
- **Never import `Overlay.tsx` from Node code**: `import "./overlay.css"` crashes outside webpack;
  shared geometry is in `remotion/layout.ts`. **MLT silently drops ProRes 4444's alpha**: VP9
  `yuva420p` is the only alpha format MLT composites; decode with `-c:v libvpx-vp9` to spot-check.
- **Timeline zero is the countdown's first second** (`ANCHOR_SEC`, `src/pipeline/kdenliveProject.ts`):
  match start is at 10s on the timeline. **The finished MP4 is not the timeline** (`export:fast`
  cuts `headTrimSec` off the front): read `exportMatchStartSec(dir, id)` (10 without a record) or a
  series' `series.json` (`matchStartSec`/`gameMatchStarts`), never assume 10s on the export. The
  sync editor and stills are timed on the timeline, pre-cut.
- **`exportUpscale1440`** (default off): scales the composited frame to 2560x1440 just before
  encoding; off keeps the filter graph byte-for-byte unchanged. `assembleSeries` refuses to mix
  resolutions across a series.
- **When the detector is unsure, a human settles it** (`GET/PUT /api/sync/:id`,
  `src/pipeline/syncEdit.ts`): saving stamps `source: "manual"`, `confidence: 1`, so a re-render
  keeps the hand fix. Only clip placement changes, so the fix is `export:fast` (~10 min), not a
  re-render, and **not optional**: a sync.json correction after export leaves the published video
  out of sync until re-exported. `exportStale` refuses Upload/nightly/adopt until re-encoded.
- **A Twitch archive outlives the stream by 14 days** (60 for partners), chat too;
  `npm run download-vods -- <id>` secures a match ahead of render. **Every consumer places clips
  from `sync.json`** (`src/pipeline/syncFile.ts`); without it, `export:fast`/the Short fall back
  to `config.preRollSec` and run early; `npm run sync-status` backfills.
- **Sync reads the picture, and only the picture** (`src/pipeline/countdownDetect.ts`,
  `detectMatchStartAny`): the countdown digit (works in a private room) and the 10s camera freeze;
  no audio fallback. Prefer the detector's reading when confident; the hand editor is for a clip it
  cannot read (its anchor is ±1s).
- **The intro card is a versus screen** (`remotion/Intro.tsx`): animated elements position via
  left/top, never a CSS `transform`. No head-to-head on a playoff game.
- **`ss` is there; `lsof`/`fuser` are not**: `ss -tlnp | grep <port>` names the real listener,
  which a `ps`-found PID is not always. **The playoffs board lives inside `#suggestions`, rows
  carry `.sugg`**: match `#suggestions > .sugg`, or a check waits forever on a hidden fold.
- **A failure reports under the control that caused it** (`failAt`, `public/app.js`):
  `clearFailAt` at the start of an action, report after a repaint, not before. **No Clipboard API
  on the lab's dashboard** (plain http): `copyText` falls back to `document.execCommand("copy")`
  and returns whether it worked; never mark "Copied" without checking.
- **A cut-short upload resumes its own session, never trusts a record.** A restart mid-upload is
  settled through `resumeUpload`'s `resumeOnly` (never falls through to a second upload); no
  session + a `source: "dashboard"` record is trusted done; anything else fails the step, naming
  Studio — so does any failed resume with a Studio record on file; the session file
  stays for the next Retry. A blocked match's session is never resumed.
- **Verify visual changes by rendering** (`npm run still`, then read the PNG). Run
  `npm run test:unit` after any edit, `npm test` (Chromium+ffmpeg) after touching rendering or
  asset generation; `test:unit` runs on `DEFAULTS`, so a Settings-tab switch can't break it.
- **Generated projects carry `<mlt root>`** with every resource relative to it, so a lab-rendered
  project opens on the desktop too.

## Version control

Long-lived branches are normal. Before concluding a feature doesn't exist, check `git branch -a`,
`git worktree list` and the remote. Sessions run concurrently in `.claude/worktrees/`: check for
another session's uncommitted work before staging, and **never `git add -A` on a shared tree.**

## Branding

One pixel-art Minecraft identity across overlay, thumbnails, channel art and reports:

- **Font:** Monocraft (`remotion/assets/fonts/`), `--pixel-font` in `remotion/overlay.source.css`.
- **Palette:** custom properties atop `remotion/overlay.source.css` (`--panel` …
  `--muted`); don't invent new colours for thumbnails, channel art or docs.
- **Badge:** the replay ring + MC/SR monogram, defined once in `remotion/pixelBadge.ts`, drawn by
  `<PixelBadge />`; change it there, never by re-inlining SVG. It must render after its siblings in
  `Overlay.tsx` or the header bar paints over it.
- **The overlay wears the thumbnail's look**: mid-value crimson/warped split with checker, each
  name/head on a thumbnail plate (`.plate`), hard pixel shadows only (no blur, none past a band's
  edge).
- **Channel art:** `branding/logo.png` + `banner.png` from `branding/generate_brand_assets.py`
  (`branding/README.md`).
- **Brand plan:** https://claude.ai/code/artifact/82c863d6-1bf5-4e01-b679-a2a3c40fcc80
