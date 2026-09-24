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
  thumbnail. The upset hook is a question (`Can the 1789 take down the 2080?`).
- **The YouTube API compliance audit cleared on 15 Sept 2026** ("completed your review and don't
  require any further actions"; submitted 7 Sept, round-2 recording 14 Sept — the reply texts are
  `handbook/api-review/`). `videos.insert` is allowed; `youtubeUploadEnabled` is true on
  the lab and the dashboard uploads. `nightlyUpload` is `"scheduled"` since 22 Sept 2026 (the
  operator's edit — it changes what a nightly render does). Google may re-review: keep every API call
  inside what the recording showed (own channel, own data, nothing shown to anyone else).
- Nothing irreversible without the operator: deletions, retitles on the live channel, config
  that changes what a nightly render does.

## Layout

`src/` is grouped by what the code is for; a module's folder is the first thing its path says.

| Folder | What lives there |
| --- | --- |
| `src/api/` | The outside services read: MCSR Ranked (`mcsrApi.ts`, `types.ts`), Twitch (`twitch.ts`, `twitchChat.ts`), avatar renders. |
| `src/pipeline/` | A match to a finished video: fetch, VOD download/discovery, sync (`countdownDetect.ts`, `sync.ts`, `syncFile.ts`, `syncEdit.ts`), the overlay (`overlayProps.ts`, `overlayRender.ts`, `splitStates.ts`), the Kdenlive project and `export:fast`, and the text it writes (`title.ts`, `description.ts`, `hooks.ts`, `chapters.ts`). `pipeline.ts` is the stage runner. |
| `src/thumbnails/` | The variant strip and its manifest. |
| `src/shorts/` | The moment scorer, the reasoner, the vertical render, `generateShort.ts`. |
| `src/playoffs/` | The bracket and its games (`playoffs.ts`), a series as one video (`series.ts`, `seriesCli.ts`). |
| `src/youtube/` | The Data API client and auth, upload records, the upload itself, the channel pairing, the publish slot. |
| `src/dashboard/` | The web server (`server.ts`, one dispatch chain), its route groups (`youtubeRoutes`, `exportRoutes`, `shortsRoutes`, `syncRoutes`), the match screen's payload (`matchMeta.ts`), jobs, the nightly, suggestions, the shelf (hidden/queue/checklist), the publish set. |
| `src/cli/` | Entry points nothing else imports: batch, status, score, chat, bench, the TUI. |
| `src/` root | `config.ts`, `cliArgs.ts`, `errorText.ts`, and the tests that cut across folders. |

Tests sit beside what they test (`foo.test.ts` next to `foo.ts`); fixtures are `src/fixtures/`.
`remotion/` is the compositions; `public/` the dashboard's browser files; `scripts/` the
browser checks and the small build/preflight helpers; `docs/` the GitHub Pages site (not repo
docs — see the root `README.md`).

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
| `npm run pick -- <matchId \| all> [--force]` | Ask the model for the Short's moment (see Shorts): prints the prompt size, the model's raw answer, any validation failure and the pick. Without `--force` a pick newer than the export is kept. |
| `npm run bench -- <Composition> [--frames=N] [--codec=] [--pixelFormat=] [--concurrency=N]` | Render throughput for one composition. Measure before claiming a render change is faster. |
| `npm run retention -- <videoId>… [--days=90]` | The audience retention curve per video (Analytics API `audienceWatchRatio` by `elapsedVideoTimeRatio`), printed at every tenth. Measured 22 Sept 2026: 16–22 points go between 3% and 10% of the video — the first minute after the intro, the least eventful stretch of a run — then a slow drift; the finish lifts the curve again. |
| `npm run config:example` | Rewrites `mcsr-vid.config.example.json` from `DEFAULTS` in `src/config.ts`, so the example cannot drift (it had, by seven keys). Run it after adding a key. |
| `npm run analytics -- <videoId> [--traffic-sources] [--days N]` | YouTube Analytics via `~/.claude/skills/claude-youtube/` (outside the repo; token at `~/.claude/.tmp/youtube_oauth_token.json`). |
| `python3 scripts/reap.py <command…>` | Subreaper wrapper, only needed if zombies ever climb again (see Pitfalls). |
| `bash scripts/browser-checks/run-all.sh <url>` | Drives the dashboard in a real browser the way the operator does (24 Playwright checks, self-configuring from `/api/matches` and `/api/playoffs`). Point it at the real dashboard (`http://mcsr-dashboard:8080` from the Claude container), not just a local test server — four checks only ever exercised a secure origin and hid a broken Copy button for it. Needs `npx playwright install chromium` once and a server with real data. |

Lab timings for a 10-minute match: overlay render ~9 min, `export:fast` ~10 min, a Short in
seconds; a nightly render + Short takes ~12 min, ~21 min with the MP4.

## What the render produces

Almost nothing in the overlay moves, so the render is stills plus one strip (`src/pipeline/overlayRender.ts`):

- `overlay-top.png` — the identity/stats band, static. On a playoff game it carries the series
  dots (one hollow square per game needed, filled per game won, at the score the game started
  on) and the seed in the rank's place; `overlay-top-end.png` is the same band with the
  winner's dot filled, and `export:fast` switches to it at the run's end (`topEndAtSec`). The
  Kdenlive project does not know the second still.
- `overlay-splits-<n>.png` + `overlay-splits.json` — the meta+splits region (1440x346), one still
  per distinct state (`src/pipeline/splitStates.ts`). The manifest is written last and means "the render
  finished". The last state is the subscribe card (`postRollCta`, `ctaFrameOf`).
  `renderOverlay({ only: ["splits"] })` redoes just the stills in seconds.
- The first minute's **COMING UP card** is two more of those stills (`teaserFramesOf`): "COMING
  UP · AT 5:14 · THE LEAD CHANGES ON BLIND TRAVEL" in the meta column from `teaserAtSec` (10,
  Settings → Publishing, empty = none) after match start for `teaserSec` (5) — aimed at the
  16–22 points lost between 3% and 10% of the video. The moment is `src/pipeline/teaser.ts`,
  from `match.timelines` only: an unplanned death, else the lead change that overturned the
  biggest deficit, else a split under 2 s; never in the first minute or the last minute before
  the game is decided, and it names nobody. `death_spawnpoint` is the routine bed warp, not a
  death. A match led wire to wire with no death gets no card (4 of 9 checked, 24 Sept 2026); the
  mid-roll SUBSCRIBE wins an overlap.
- `overlay-timer.mp4` — the RTA column (480x346), the only thing rendered per frame.
- `overlay-intro.webm` — the 7 s intro card.

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
  A whole match costs ~1.5–5 min and ~80–140k tokens on the operator's subscription.
- **No Short renders and nothing uploads before the operator saves the hooks** (the gate is in
  `generateShort.ts`, `youtubeUpload.ts` `hookRefusal`, and every render path): the Short's hook
  is its own field, `short-<id>.hook.txt`, prefilled on the dashboard with the model's
  suggestion; the long-form's title hook is the edited title. Saving both
  (`PUT /api/shorts/hooks/:id`) starts the chain in `src/dashboard/shortFlow.ts`: render the
  Short, upload the long-form at its slot, upload the Short 18 h later. A hook changed before the
  upload re-renders; after the upload the hooks lock. "No Short for this one" lets the long-form
  go alone. `short-<id>.status.json` holds each step's state and errors.
- **On screen** (`src/shorts/shortRender.ts`, `remotion/Short.tsx`): the hook for 4 s
  (`SHORT_HOOK_SEC`), then captions from the race data (`raceCaptions`, `src/shorts/raceGap.ts`:
  "SILVERRRUNS 8 S UP AT THE EYES" — a leader may be named mid-race, never the result), a running
  clock in the top nameplate (YouTube's own UI covers the bottom ~20%), the off-focus POV lowered
  12 dB, and a closing card: "WHO TOOK IT? FULL MATCH ON THE CHANNEL" when the window ends before
  the match is decided, else "FULL MATCH ON THE CHANNEL" ("SERIES" for a series). The single-POV
  layout is a centre crop that keeps the crosshair and the hotbar.
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
  order is the point: **Check** (`#h-preview` final video · `#synccheck` · `#syncedit` fold) ·
  **Package** (`#h-hook` hook + `#save` + chips · thumbnails · Splits fold · Title & description
  fold) · **Publish** (`#h-youtube` YouTube panel, then `#h-publishkit`) · **After** (`#h-short`
  Short · Manage fold). On a desktop they are two columns (Check + After left, Package + Publish
  right); under 860 px one group is shown at a time (`.panel.on`), switched by the `.jump` bar in
  the bottom-bar slot — a tap `preventDefault`s the hash link and scrolls to the top: the group is
  the whole screen and the head above it is 70 px, and the hash scroll put the head, `#headwarn`
  with it, under the back bar on the very panels that hold Upload and Adopt. Re-selecting the
  match on screen (the strip's last-run link, a card's "Rendered · open") keeps the group that
  was open; a different match opens on Check. Any phone check that fills a Package or Publish
  control taps `.jump [data-panel=…]` first. The head is short on purpose — the match id,
  `#failure`, and `#headwarn` (the detector's confidence line plus a mirror of `#syncstale`, so
  leaving Check never hides the sync warning) — because the sync frames must start on the phone's
  first screen; `#checklist` (six fact pills hidden by CSS, all ten still in the DOM —
  hook-flow-check reads its text) sits at the bottom of Publish, since every pill left on view is
  a post-upload tick. `#preview .previewmeta` is one row for the same reason (the file name gets
  the ellipsis; the Short's `.previewmeta` lines still wrap). `#run`/`#stop` are the head's primary button for an unrendered match and live in
  the Manage fold (with `#mhide`, `#mdel`, the outputs table) once it is rendered; `armStop`
  opens that fold. `#save` sits beside the hook field and typing into `#hook` writes "not saved"
  into `#savedmsg`. The kit's description + tags are one more fold; its "after the upload" fold
  opens itself once `kit.videoUrl` exists.
- **Rendered rows are two lines**: names + id, then one state line naming the next action
  (`ready — check · pick · upload`, `@mcsrmatches posted 1d ago`, `in progress · overlay`,
  `published`). Deleted, not folded: the stage pips and their legend, the list's order line, the
  suggestions' bucket legend, the head's jump-link row, the old Re-run at the top of a rendered
  match, `#hostmeta` on phones. "Render only" is a text link in a suggestion card's links row
  (`a[data-act="render"]`, same handler); the button row is Render + Short + MP4 · Queue · Dismiss.
- **The touch-target block fires on `pointer: coarse` OR `max-width: 860px`.** Playwright's
  Chromium drops the coarse-pointer emulation after a full-page screenshot on a mobile context,
  so a width-only measurement of a phone page found 28 px inputs the real phone never shows; the
  width clause makes the 44 px targets a fact of the layout rather than of the emulation.
- **Suggestions** (`src/dashboard/suggest.ts`, `src/dashboard/suggestPresent.ts`): scored candidates, cached in
  `<mediaDir>/.suggest-cache.json`; bumping `CACHE_VERSION` re-fetches everything on the next
  scan (~340 MCSR API calls against 500/10 min). Scanned at boot, every `suggestCacheTtlMin`
  (30) for new matches, before the nightly picks, and fully on the `rescan` link.
- **Rival posts** (`src/dashboard/rivalPosts.ts`): the competitor's (`rivalChannelHandle`, default
  `mcsrmatches`) last 50 uploads, matched to cards by nickname pair, date and run length (their
  video is the run plus a few seconds; a post of the wrong length is another match of the same
  pair). A posted match sorts after the fresh ones, in the nightly's order too.
- **Hook chips** (`src/pipeline/hooks.ts`) put rivalry framing first: the audit measured rivalry hooks at
  9.36% CTR against 2.25% for descriptive ones. A playoff game's chips are its seeds, in words
  ("Can the LCQ take down the 7th seed?", "The 7th seed vs the LCQ") in place of the ladder-rank
  chip — a bracket has its own order, and a `#` in a hook is a hashtag on the Short's title.
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
  and the Short 18 h later (`"private"`: no publish time; `"off"`: the chain stops after the
  render). The nightly itself never uploads any more. Still not writable from the Settings tab.
- **A playoff game's thumbnails can carry the tournament** (`playoffThumbnailStyle`, in the
  Settings tab; `remotion/Thumbnail.tsx` `playoff`): "bracket" puts the round in the band, the
  seed where the rating was and "Best of 5" under the VS; "trophy" grows the band for a gold
  PLAYOFFS wordmark and frames the body. Default "plain" — the operator picks from the renders
  in the 22 Sept report. A ranked match is never framed.
- **Thumbnails are plain poses, no text** (`src/thumbnails/thumbnailVariants.ts`): four pairs from
  `thumbnailVariants`, the first (`walking`/`crossed`) is the auto default, `default`/`default`
  is both players straight on. The hooked-twin machinery (`hookText`, `-hook` keys,
  `POST /api/thumbnails/:id/rerender`) is still in the code but the pipeline no longer asks for
  it and the panel hides hooked stills — the operator took the text off on 18 Sept 2026. The
  hook stays on the title and the Short. The checklist's thumbnail pill ticks on
  `chosenBy: "operator"` in the manifest — a rendered variant is not a chosen one.
- **The audit blocks `videos.insert`, not the rest.** `playlistItems.insert`, `thumbnails.set`,
  `commentThreads.insert` and `videos.update` are all inside the token's `force-ssl` scope and are
  unaffected, so **Finish on YouTube** repairs a Studio upload today: playlists, the pinned comment
  and the tags. It leaves the thumbnail alone on a video uploaded elsewhere whose variant nobody
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
  gates. Re-adopting the *same* video carries the finish ledger forward — that ledger is the only
  thing between a second press and a second pinned comment, which `postComment` does not
  de-duplicate.
- **A record's `privacyStatus` is from upload time and is never updated**, so the comment step
  re-reads the live status before it skips: a draft adopted while private and published an hour
  later would otherwise carry "private" for ever and never get its first comment. The comment
  still cannot go up while the video really is private, so a scheduled video needs one more press
  of **Finish on YouTube** after it goes public.
- **`videos.update` replaces the part it is given.** `addTags` (`src/youtube/youtube.ts`) reads the snippet
  and sends it back whole — a `part=snippet` write that omits the description blanks it on a
  published video. It only ever adds tags, so a tag typed in Studio survives, and it refuses to
  write at all if the read returns no video. This is the project's only `videos.*` write, it is
  operator-pressed, and it is not the call the audit gates.
- **Upload** sends `match-<id>.tags.txt` and refuses a title still containing `<HOOK>`; it adds
  the video to the season playlist (`PLHG-jSA-dWDo`), a per-matchup and a per-player playlist
  (`src/youtube/youtube.ts`; ids remembered per process because YouTube's list is eventually consistent).
  A matchup playlist is created on a pair's *second* video, with the first added alongside
  (22 of 28 playlists held one video on 22 Sept 2026). The Season 11 playoffs playlist exists
  (`PLBtNy46ii7uU`). A Short's description gains "the whole match: https://youtu.be/<id>" at
  upload time, once the long-form's id is in `youtube.json`.
  **YouTube caps `playlists.insert` at about a dozen per rolling 24 h** (429 RATE_LIMIT_EXCEEDED;
  measured 15–16 Sept 2026): the step records the refusal in the ledger and the nightly's tick
  presses again (`retryFailedPlaylists`), so a cap line in the panel needs no press from anyone.
  **A Studio upload is recognised without a tick** (`src/youtube/channelUploads.ts`): the channel's
  videos are paired to matches by the `/matches/<id>` segment in the pasted description; the
  YouTube panel's "check the channel" link lists the channel at once. The manual `uploaded`
  tick is the fallback for a video with no match link.
- **Settings tab** (`src/dashboard/settings.ts`, `GET`/`PUT /api/settings`): the handful of config keys worth
  changing without an ssh session. It writes `mcsr-vid.config.json` atomically and applies to the
  live `config` object, so nothing needs a restart — `scheduleNightly` reads the hour from `config`
  on every arm and the route re-arms it when that key moves, or the setting would lie. The file is
  read fresh and merged, so a hand-edited key the panel does not know about survives a save, and
  the merged object goes through `validateOverrides` — the loader's own function — so the panel
  cannot write a file that then fails to boot. **`youtubeUploadEnabled` and `nightlyUpload` are
  deliberately not writable here**: one switches the live channel's upload path, the other what
  a nightly does with its MP4, so they stay a deliberate edit on the box and the panel only
  reports them. Add a key by
  adding a `SettingField` to `SETTINGS`; the panel and both tests derive from that list.
- **Publish kit** (`GET /api/publishkit/:id`): copy buttons for the title, the publish slot
  (`publishHourUtc`, default 19:00 UTC, the competitor's measured hour; a series video takes
  `seriesPublishHourUtc`, 23:00, its own slot — the test is the day *and* the hour, so the two
  kinds never push each other a day out — `src/youtube/publishSlot.ts`), description, tags, the
  Short's title/description, a pinned comment, a community post, and a DM per player. When
  `pullSource` is set it opens with an rsync *pull* the operator's PC runs (`src/dashboard/publishSet.ts`;
  the lab host's path, not the container's `/media`) — pull, not push, because the image has no
  ssh client and the PC already reaches the lab. `GET /api/export/bundle/:id` is the same
  publish set as one `.tar`.
- **Publish checklist**: facts from disk plus manual toggles in `<mediaDir>/<id>/publish.json`
  (`src/dashboard/matchShelf.ts`). The Rendered tab counts exported-and-not-uploaded and is ordered by what
  to publish next.
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
  strip's `Run now` is the same path, as is a card's "Render + Short + MP4".
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
  `series.json` beside it names the games and their lengths. **The join deletes the games'
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
  starts, and skips one that is processed, hidden or gone from the list.
- `docs/` is the GitHub Pages site (`mcsr.sezamki.site`: the OAuth homepage, privacy and terms
  pages Google checks). `deploy/mcsr-claude.service` is the lab's systemd user unit for the
  Claude container. Only `~/.claude` is a persisted volume in that container: save loose ends
  inside the repo.

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
  Both paths are pinned by `src/overlayProps.test.ts`; don't "fix" the fallback away.
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
  start lands at exactly 10 s. A clip whose match start is later than the anchor must be pushed
  into its own head, not un-blanked — the wrong fix renders perfectly and slides the overlay late.
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
- **The intro card's centre block must sit above the VS badge**: `.intro-player` positions the
  columns with a `transform` that `PlayerCard`'s inline transform replaces, so the names sit at
  y≈790 and anything under the badge collides with them.
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
- **Country flags render as tofu** without a colour-emoji font (cosmetic, intro card).
- **Verify visual changes by rendering** (`npm run still`, then read the PNG).
- **`npm run test:unit` after any edit; `npm test` after touching rendering or asset
  generation** — the full run adds the three tests that drive Chromium and ffmpeg. The
  PostToolUse hook's `prettier` + `tsc --noEmit` covers per-edit mistakes.
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
  render after its siblings or the header bar paints over it.
- **Channel art:** `branding/logo.png` + `banner.png` from `branding/generate_brand_assets.py`
  (`branding/README.md`).
- **Brand and launch plan:** https://claude.ai/code/artifact/82c863d6-1bf5-4e01-b679-a2a3c40fcc80
