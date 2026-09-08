# mcsr-vid

Pipeline that turns an MCSR Ranked match ID into a synced, split-timer-
overlaid video (`fetch-match` → `download-vods` → `validate-sync` →
`render-overlay` → `generate-project`), plus a thumbnail generator. Output
is published to a YouTube channel, **MCSR Replayoffs**.

## Commands

Every command below was hand-rebuilt more than once in past sessions. Use the
script, don't reconstruct the shell line. Extra arguments go after `--`.

| Script | What it does |
| --- | --- |
| `npm run still -- <Composition> <out.png> [--frame=N] [--props=p.json]` | Render one Remotion frame to PNG — the fast visual check. Rebuilds overlay CSS first. Compositions: `MatchOverlay`, `OverlayTop`, `OverlayBottom`, `OverlayIntro`, `Thumbnail`. |
| `npm run validate-project -- media/<id>/match-<id>.kdenlive` | Load the generated MLT/Kdenlive XML through the MLT engine. Exit 0 = parses, exit 1 = malformed. |
| `npm run export:nvenc -- media/<id>/match-<id>.kdenlive [out=N]` | GPU-encode the timeline to `out/export.mp4` via `h264_nvenc`. Append `out=48` to render a short range instead of the whole video. |
| `npm run analytics -- <videoId> [--traffic-sources] [--days N]` | YouTube Analytics for a published video. |
| `npm run bench -- <Composition> [--frames=N] [--codec=] [--pixelFormat=] [--concurrency=N] [--out=path]` | Measure render throughput for one composition. Use it before claiming a render change is faster — every speed number in this file came from it. |
| `npm run short -- <matchId> [--pick=N] [--seconds=22]` | Pick the most watchable ~22s of a match and render a finished vertical MP4 (`short-<id>.mp4`) plus `short-<id>.title.txt` / `.description.txt`. Needs the VODs already downloaded. |
| `npm run export:fast -- <matchId> [--cpu] [--seconds=N] [--full-tail]` | Render the finished MP4 with one ffmpeg pass instead of melt — ~3.8x faster, no Kdenlive. `--seconds` renders a short range as a smoke test; `--full-tail` keeps the whole post-roll. |

Three things these scripts do **not** do:

- `validate-project` catches malformed XML only. It exits 0 on a project whose
  media files are all missing, so it is not a substitute for opening the result
  in Kdenlive.
- `export:nvenc` needs an NVIDIA GPU and writes to a fixed `out/export.mp4`.
  Check support with `ffmpeg -hide_banner -encoders | grep nvenc`. The lab has no NVIDIA GPU —
  use `export:fast` there, which uses the Intel VAAPI encoder.
- `export:fast` does not replace Kdenlive; it is the headless path. Open the `.kdenlive` when a
  match needs a human. Both place clips through `placeOnTimeline`, so they cannot drift.
- `analytics` shells out to `~/.claude/skills/claude-youtube/`, which lives
  outside this repo and needs an OAuth token at
  `~/.claude/.tmp/youtube_oauth_token.json`.

## What the render actually produces

Four overlay artifacts, not one video, because almost nothing in the overlay moves:

- `overlay-top.png` — the identity/stats band. Static for the whole match.
- `overlay-splits-<n>.png` + `overlay-splits.json` — the meta+splits region (1440x346), one still
  per distinct state. The splits table only changes on a split's reveal frame, so a match needs a
  handful of these rather than ~17k frames. `src/splitStates.ts` computes the change frames by
  asking `resolveSplitSide` what each frame looks like, so it cannot drift from the component.
  The manifest is written last and stands in for "the render finished".
- `overlay-timer.mp4` — the RTA column (480x346). **The only thing rendered per frame.**
- `overlay-intro.webm` — the 7s intro card.

The old single `overlay.mov` (1920x346 ProRes 4444, 3.9-5.7 GB a match) is gone. Measured on the
lab, the overlay render went from ~28.5 min to ~9 min for a 10-minute match.

## Shorts

`npm run short -- <matchId>` cuts a finished vertical MP4 from VODs the main pipeline already
downloaded. No Kdenlive project: a Short is 22 seconds of fixed layout with nothing to decide, so
an NLE would only insert a manual step into the one part of the pipeline that can be fully
automatic. Remotion renders two stills (the board, and the hook on its own frame so ffmpeg can
fade it), then one ffmpeg pass scales both POVs into their panes and lays the board over.

- **Which 22 seconds** is `src/shortMoment.ts`, scored entirely from `match.timelines` — no video
  decoding. It weights the payoff landing ~59% through the window (the 42k-view competitor Short
  is 21 s with its payoff at 9 s), a lead change, both players
  hitting the same milestone seconds apart, and something in the first two seconds so the opening
  is not dead air. On match 12730175 it picks the double death over the dragon kill, which is
  right. The weights are informed guesses; re-tune them against retention once Shorts exist.
- **Nothing on the board animates**, deliberately. As a 900-frame VP9 render it took ~10 minutes
  to produce 22 seconds of furniture; as two stills it takes seconds. The one thing that would
  animate — a live RTA counter — is a static "at 6:57" label instead, and neither reference
  channel runs a timer on their Shorts either.
- **The hook line is the title hook.** `resolveShortHook` (`src/shortHook.ts`) takes the edited
  title's hook if one was picked, else the first rivalry chip, else the per-moment line — burned
  in centred on the seam for 4 s, in the style measured on the 42k-view competitor Short. The
  Short's own title is that hook plus `#minecraft #mcsr`, unless the hook already carries a
  hash (`#7 vs #11`), in which case it stands alone so YouTube does not read four hashtags.
- **A Short follows every clean nightly render** (`nightlyRenderShort`, default on), so the
  morning has both halves of a match ready.
- **Auto-cropping the game window usually declines, and should.** Streamers whose chat and stat
  panels reach the frame edges have motion everywhere, so there is no game window to isolate
  (measured on both POVs of 12296170). `--top-crop=x,y,w,h` overrides it when you know the layout.

## Dashboard

`npm run dashboard` (port from `PORT`, default 8080). Server code in `src/` is read at boot;
`public/` is served from disk per request. So after pulling server changes the production
container needs `docker restart mcsr-dashboard`; a CSS/JS change is live on reload. In between,
the page is newer than its server: the nightly strip detects that (the old server answers
`/api/nightly` with its id-parser error) and says to restart, rather than echoing the error.

- **Suggestions** are scored candidate matches. Each card carries a story line built server-side
  (`src/suggestPresent.ts`): current rank, match-start elo, head-to-head record, Twitch followers,
  VOD expiry. Head-to-head costs one `getVersus` call per *newly scored* match and is pooled in
  `/media/.suggest-cache.json` (`CACHE_VERSION` in `src/suggest.ts`; bumping it makes the next
  scan re-fetch everything, ~340 MCSR API calls against 500/10 min).
- **Hook chips** (`src/hooks.ts`) put rivalry framing first — `Rematch: doogile leads 2-1`,
  `#4 vs #11`, `2050 vs 1850` — because the audit measured rivalry-framed titles at 9.36% CTR
  against 2.25% for descriptive ones, with no overlap. Descriptive chips are fallbacks.
- **Thumbnails carry a hook** (`hookText` in `ThumbnailProps`, recorded in `thumbnail.json`).
  The pipeline renders with the first hook suggestion; "Re-render with hook" in the detail panel
  (`POST /api/thumbnails/:id/rerender`) redoes all variants with the hook you typed. Verified
  legible at YouTube's 246x138 grid size; a render with no hook is byte-identical to before.
  The third configured variant is `hook: false` — a text-free control — so Studio's Test &
  compare can measure text vs no text; each `VariantRecord` records `hook`, and the Short
  reuses the manifest's `hookText` so both halves of a match say the same thing (rank chips
  read live rank, which drifted from `#3 vs #17` to `#3 vs #21` within an hour).
  The A/B tab groups impressions and CTR by variant *and* by text vs no text (`byHook` in
  `abTestPayload`, impression-weighted); videos whose manifest is missing land in `Unknown`.
- **Upload** sends the tags from `match-<id>.tags.txt` (written by the pipeline, see
  `buildTags` in `src/description.ts`) and refuses — server and client — any title still
  containing `<HOOK>`. After upload it adds the video to the season playlist *and* a
  per-matchup one (`matchupPlaylistTitle` in `src/youtube.ts`, seat- and case-independent).
  `findOrCreatePlaylist` remembers ids per process: YouTube's `playlists.list` does not show a
  playlist created a second earlier, and the back-to-back inserts made a duplicate on the live
  channel before this. The season playlist exists: `PLHG-jSA-dWDo`, all uploads to date.
- **Publish kit** under the YouTube panel (`GET /api/publishkit/:id`): copy buttons for the
  title (hook substituted), description, comma-joined tags with the 500-char count, the
  Short's title/description when `short-<id>.title.txt` exists, and a DM per player with the
  `youtu.be` link once uploaded. Nothing is stored; it is the manual Studio phase, pre-pasted.
- **Publish checklist** under the pipeline stages: five facts derived from disk, five manual
  toggles (`uploaded`, `Short uploaded`, `related link`, `end screen`, `players notified`) in
  `<mediaDir>/<id>/publish.json`. `uploaded` is also derived (youtube.json) — the tick exists
  because uploads go through Studio until the API audit clears. The Rendered tab counts
  matches that are exported and not uploaded (`Rendered (4 ready)`); rows say *ready to
  publish* / *published*; hidden matches are out of the count.
- **Dismiss** on a card hides a suggestion (`DELETE /api/suggestions/:id`); it leaves an
  undo line above the cards (`POST /api/suggestions/:id/restore`), which puts the row back at
  once if this process dismissed it and otherwise at the next scan.
- **Hide / delete** matches from the list; delete refuses while any job is writing into that
  directory and reports whether an archived copy exists (`src/matchShelf.ts`).
- **Nightly auto-render** (`src/nightly.ts`): at `nightlyRenderHourUtc` (default 3, i.e. 05:00
  in Poland; `null` disables) the server starts one render of the first eligible card *in the
  order the dashboard shows them* (`orderForDisplay`), skipping the night if a render is already
  running or fewer than two matches of disk remain, then renders that match's Short
  (`nightlyRenderShort`, default on) and encodes the finished MP4 with `export:fast`
  (`nightlyRenderExport`, default on; ~10 min on the lab's VAAPI, through exportRoutes' job
  table so the export panel and the delete guard see it) — the morning has a preview to watch
  and a file to upload, not a project. `nightlyNotifyUrl` gets a one-line POST on done / failed /
  aborted (an ntfy.sh topic URL works as-is). The Suggestions tab shows a strip — tonight's
  pick, the last run's outcome (`<mediaDir>/.nightly.json`), a `Run now` button — backed by
  `GET /api/nightly` and `POST /api/nightly/run`. "Render + Short + MP4" on a card is the same
  path (`POST /api/render/:id?short=1&export=1`); one poller settles all of it, so a job can
  never cut two Shorts.
- On phones (<= 860px) the list and the match are two screens with a back bar, not one column.
- There is a Playwright smoke script from the 2026-09-07 session in that session's scratchpad
  (`smoke.cjs http://host:port`); it is not in the repo because Playwright is not a dependency.

## What is and is not edited automatically

The match footage is never cut. That leaves two editable regions, and both are automated:

- **Before the match** — the thump anchor puts timeline zero on the ready-countdown, the intro
  plays over it, and gameplay starts at 10s. Nothing to trim by hand.
- **After the run** — `src/postRoll.ts` ends the video where the winner goes quiet *and* still,
  rather than after a flat `postRollSec`. Never closer than 15s to the finish.

Not attempted, and worth knowing why: cutting to the good part of a reaction needs to know what
is being said, and speech means a transcription pass per match on a four-core box.

## Session preflight

`scripts/preflight.sh` runs at session start (wired in `.claude/settings.json`) and prints one
line when everything is fine. It exists because three sessions were lost to environment state
rather than code: a container with no GitHub credentials, a read-only PAT that failed only at
push time, and expiring OAuth tokens.

It reports rather than blocks — always exits 0, every network call bounded by a timeout. When it
flags something, fix that before starting work; it is naming a thing that will otherwise surface
halfway through a merge or a render.

The YouTube half (`scripts/preflight-youtube.mjs`) actually spends the refresh token rather than
inspecting it, because that is the only way to know it still works. It also warns while a token
is *about* to die: an OAuth consent screen left in "Testing" gets refresh tokens that Google
expires after 7 days, which is invisible until the day it bites. That warning stops on its own —
a token still alive past day 8 proves the app is published, so it writes a marker and never asks
again.

Run it by hand any time with `bash scripts/preflight.sh`.

## Known Pitfalls

- **Season vs career stats.** `pickStats` (`src/overlayProps.ts:47`) uses the live
  season bucket and falls back to career totals *only* when that bucket has no
  ranked games — right after a rollover — and the overlay then labels itself
  CAREER. Both paths are intentional and pinned by `src/overlayProps.test.ts`;
  don't "fix" the fallback away. The original bug was showing ~5,000-game career
  numbers unlabelled.
- **Elo must come from the match, not the user.** `user.eloRate` is the rating
  *now*. Use `eloAtMatchStart()` (`src/overlayProps.ts:60`) everywhere — overlay,
  thumbnail and description — or the same match shows different numbers in
  different places.
- **Props functions are async.** `computeOverlayProps` (`src/overlayProps.ts:132`)
  and `computeThumbnailProps` (`src/thumbnailProps.ts:40`) both return promises; a
  missing `await` renders a pending promise as player data.
- **Never import `Overlay.tsx` from Node code.** It does `import "./overlay.css"`
  (`remotion/Overlay.tsx:3`), which only webpack resolves; under plain Node it is a
  hard `ERR_UNKNOWN_FILE_EXTENSION` crash. Shared geometry lives in
  `remotion/layout.ts` precisely for this — import from there, as `src/pipeline.ts`
  does.
- **MLT throws away ProRes 4444's alpha.** Silently — it composites the raw RGB instead. This
  made the intro's fade-in and wipe-out render as hard cuts in every export for months, invisible
  because the card is opaque for 6.15 of its 7 seconds. Measured at the fade-out, where the card
  is 11% opaque: ProRes gave back the card's own colour, while qtrle, png-in-mov and VP9
  `yuva420p` all blended correctly. **VP9 is the only alpha format Remotion emits that MLT
  composites**, so `overlay-intro.webm` and the Shorts board are VP9. When spot-checking one,
  note that ffmpeg's *native* vp9 decoder drops the alpha side-data — only `libvpx-vp9` reads it,
  so pass `-c:v libvpx-vp9` or the alpha will look missing when it is not.
- **ProRes is slow in Remotion for a reason that is not obvious.** Remotion can only stream
  frames into ffmpeg for h264/h265 (`canUseParallelEncoding`); with ProRes every frame is written
  to a temp PNG and read back with `-f image2`. Measured, that is ~1.9x on the timer strip. Use
  ProRes only where alpha is needed, and even then prefer VP9 (see above).
- **Timeline zero is the world-load thump, not the match start.** `ANCHOR_SEC`
  (`src/kdenliveProject.ts`) — every clip is placed so match start lands at exactly 10s, the
  intro plays over the ready-countdown, and the export opens on the footage. It used to be
  `max(every clip's pre-roll)` = 150s, so projects opened on 2.5 minutes of blank that had to be
  trimmed by hand. If you pin the anchor, you must also push each clip further into its own head
  — merely suppressing the resulting negative blank slides the overlay late, renders perfectly,
  and no in-point assertion can see it.
- **Sync reads the picture, not the audio.** MCSR opponents play separate worlds with their own
  microphones and music, so the two streams share almost no audio: measured on match 12296170,
  cross-correlation peaked at 0.03-0.13 and was 12-32s wrong in every window. What *is* shared is
  that both players are frozen through the 10s countdown, so match start is the end of a long
  still stretch — `src/countdownDetect.ts`, validated to 0ms on both POVs of that match against
  ground truth read off the countdown digits. `src/sync.ts` keeps the audio path only for footage
  the freeze heuristic cannot read.
- **The intro card's centre block must sit above the VS badge.** `.intro-player` positions the
  columns with a `transform`, but `PlayerCard` writes an inline `transform` that replaces it, so
  the player names sit at y≈790 — anything placed under the badge collides with them.
- **No `ss`, `lsof` or `fuser` in the container.** "Kill whatever holds the port" silently does
  nothing and the next `npm run dashboard` dies with EADDRINUSE while the old server keeps
  answering — tests then run against stale code. Find it with
  `ps -eo pid,args | grep 'src/server.ts'` and kill by PID; the process `comm` is `MainThread`.
- **Country flags render as tofu** unless the container has a colour-emoji font; the pixel font
  has no flag glyphs. Cosmetic on the intro card.
- **Verify visual changes by rendering.** `npm run still -- <Composition> <out.png>`,
  then read the PNG. Don't reason about the JSX and call it done.
- **Run `npm test` after touching rendering or asset generation, and keep it green.** Not after
  every edit, though — the suite drives Chromium and ffmpeg and takes minutes, which is why the
  PostToolUse hook runs `prettier` and `tsc --noEmit` instead. Those two catch the mistakes an
  edit actually introduces; the suite catches what a *change* introduces.
- **Generated projects carry `root`.** `src/kdenliveProject.ts:313` emits
  `<mlt root="...">` with every resource relative to it, which is what lets a
  project rendered on the homelab open on the desktop. Check output with
  `npm run validate-project -- media/<id>/match-<id>.kdenlive`; note that only
  proves the XML parses, not that the media resolves.

## Version Control

Long-lived branches are normal here. Before concluding a feature doesn't exist,
check `git branch -a`, `git worktree list`, and the remote — not just the working
tree; several branches have existed only locally. Sessions also run concurrently
in `.claude/worktrees/`, so check for another session's uncommitted work before
staging anything, and never `git add -A` on a shared tree.

## Branding (updated 2026-08-09)

The whole project — video overlay, thumbnails, and channel art — shares one
pixel-art Minecraft identity:

- **Font:** Monocraft (`remotion/assets/fonts/`), loaded via `@font-face` in
  `remotion/overlay.source.css` as `--pixel-font`. Real font, not a
  hand-drawn bitmap — use it everywhere text needs the Minecraft look.
- **Palette:** CSS custom properties in `remotion/overlay.source.css`:
  `--panel` `--panel-2` `--panel-edge` `--panel-edge-light` `--crimson`
  `--warped` `--gold` `--quartz` `--muted`. These are the actual brand
  colors — don't invent new ones for related work (thumbnails, channel art,
  docs).
- **Badge/logo mark:** a pixel-art replay/refresh ring — two arcs (crimson
  + warped), each capped with an arrowhead, at 180-degree rotational
  symmetry (the classic "refresh/sync" icon shape) — with an "MC"/"SR"
  monogram stacked in a 2x2 grid on top, in Monocraft, outlined in a
  darker shade of its own fill color for a 3D-bevel look. Defined once in
  `remotion/pixelBadge.ts` (`buildBadgeRingCells`, grid resolution
  `BADGE_GRID_N=64`) and consumed by the shared `<PixelBadge />` component
  (`remotion/PixelBadge.tsx`, which also draws the monogram), used by both
  `Overlay.tsx` and `Thumbnail.tsx`. Note: `<PixelBadge />` must render
  *after* its siblings in `Overlay.tsx` (last child of the top-level
  `AbsoluteFill`) — the badge is taller than the header bar it sits in and
  gets painted over by later siblings otherwise. If the icon ever needs to
  change, change it in `pixelBadge.ts`/`PixelBadge.tsx` — not by
  re-inlining SVG in either component.
- **Channel art:** `branding/logo.png` + `branding/banner.png`, generated
  (not hand-drawn) by `branding/generate_brand_assets.py`, using the same
  ring geometry and the real Monocraft font. See `branding/README.md` to
  regenerate.
- **Full brand/launch plan** (positioning, content rules, competitor
  analysis, posting schedule, sample video descriptions): published at
  https://claude.ai/code/artifact/82c863d6-1bf5-4e01-b679-a2a3c40fcc80

## Coordination note

Reconciled on 2026-09-03. All twelve `worktree-*` branches were merged into
`main` and their worktrees pruned; `git worktree list` should show only the
primary checkout. The `.claude/worktrees/` tree (37 GB) and the unreferenced
Kdenlive `*-60fps.mp4` transcodes (27 GB) were deleted — nothing in `src/`,
`remotion/`, or any `.kdenlive` project referenced them, and Kdenlive
regenerates transcodes on demand from the source VODs.

The `match-suggester` worktree's uncommitted refactor (7 files, +63/-105) was saved as
`~/mcsr-suggester-refactor.patch` on 2026-09-03 and is **gone**: `/home/node` is not a
persisted volume (only `~/.claude` is, see compose.yaml), so an image rebuild took it. Checked
2026-09-08. Nothing to apply; the suggester on `main` — including the 2026-09-07 card redesign
in `src/suggestPresent.ts` — is its current shape. Save loose ends inside the repo next time.
