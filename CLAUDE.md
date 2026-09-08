# mcsr-vid

Turns an MCSR Ranked match id into a synced, split-timer-overlaid video (`fetch-match` →
`download-vods` → `validate-sync` → `render-overlay` → `generate-project` / `export:fast`), plus
thumbnails and a Short, published to the YouTube channel **MCSR Replayoffs**. Everything below is
what an agent cannot derive from the code; the rest is in the files it names.

## House rules

- The match footage is never cut. The two editable regions — before the match and after the run
  — are automated (`ANCHOR_SEC`, `src/postRoll.ts`).
- Nothing names the winner: no result line in the description, no winner in a hook or on a
  thumbnail. The upset hook is a question (`Can the 1789 take down the 2080?`).
- No `videos.insert` until the YouTube API compliance audit clears (submitted 7 Sept 2026): an
  upload through an unaudited project is locked private for good. Uploads go through Studio.
- Nothing irreversible without the operator: deletions, retitles on the live channel, config
  that changes what a nightly render does.

## Commands

Use the script, don't reconstruct the shell line. Extra arguments go after `--`.

| Script | What it does |
| --- | --- |
| `npm run dashboard` | The web dashboard (`PORT`, default 8080). |
| `npm start` | The terminal UI (`src/tui.tsx`). |
| `npm run still -- <Composition> <out.png> [--frame=N] [--props=p.json]` | One Remotion frame to PNG — the fast visual check. Rebuilds overlay CSS first. Composition ids are in `remotion/Root.tsx`. |
| `npm run validate-project -- media/<id>/match-<id>.kdenlive` | Load the generated MLT XML through the MLT engine. Exit 0 = parses. Malformed XML only: it passes a project whose media is missing. |
| `npm run export:fast -- <matchId> [--cpu] [--seconds=N] [--full-tail]` | The finished MP4 in one ffmpeg pass (Intel VAAPI on the lab), no Kdenlive. `--seconds` renders a short range as a smoke test. Open the `.kdenlive` when a match needs a human; both place clips through `placeOnTimeline`. |
| `npm run export:nvenc -- media/<id>/match-<id>.kdenlive [out=N]` | melt + `h264_nvenc` to `out/export.mp4`. Needs an NVIDIA GPU; the lab has none. |
| `npm run short -- <matchId> [--pick=N] [--seconds=22]` | The ~22 s vertical MP4 (`short-<id>.mp4`) plus its `.title.txt` / `.description.txt`. Needs the VODs. |
| `npm run chat -- <matchId>` | Re-fetch both players' Twitch chat to `chat-<nick>.json` (the pipeline does this itself after `download-vods`). |
| `npm run bench -- <Composition> [--frames=N] [--codec=] [--pixelFormat=] [--concurrency=N]` | Render throughput for one composition. Measure before claiming a render change is faster. |
| `npm run analytics -- <videoId> [--traffic-sources] [--days N]` | YouTube Analytics via `~/.claude/skills/claude-youtube/` (outside the repo; token at `~/.claude/.tmp/youtube_oauth_token.json`). |
| `python3 scripts/reap.py <command…>` | Run anything that spawns Chromium through this (see Pitfalls). |

Lab timings for a 10-minute match: overlay render ~9 min, `export:fast` ~10 min, a Short in
seconds; a nightly render + Short + MP4 lands in 12–21 minutes.

## What the render produces

Almost nothing in the overlay moves, so the render is stills plus one strip (`src/overlayRender.ts`):

- `overlay-top.png` — the identity/stats band, static.
- `overlay-splits-<n>.png` + `overlay-splits.json` — the meta+splits region (1440x346), one still
  per distinct state (`src/splitStates.ts`). The manifest is written last and means "the render
  finished". The last state is the subscribe card (`postRollCta`, `ctaFrameOf`).
  `renderOverlay({ only: ["splits"] })` redoes just the stills in seconds.
- `overlay-timer.mp4` — the RTA column (480x346), the only thing rendered per frame.
- `overlay-intro.webm` — the 7 s intro card.

## Shorts

`npm run short` cuts from VODs already downloaded, with no Kdenlive project on purpose: 22 s of
fixed layout has nothing to decide. Two Remotion stills (board, hook) plus one ffmpeg pass
(`src/shortRender.ts`).

- **Which 22 seconds** is `src/shortMoment.ts`, scored from `match.timelines` and the saved
  chat only, no video decoding. The weights are informed guesses; re-tune against retention.
- **Nothing on the board animates**, deliberately: the RTA is a static "at 6:57" label, not a
  counter; a 900-frame render took ten minutes for furniture.
- **The hook line is the title hook** (`resolveShortHook`, `src/shortHook.ts`): the edited
  title's hook, else the first rivalry chip, else the per-moment line, burned in for 4 s. The
  Short's title is that hook plus `#minecraft #mcsr` unless the hook already carries a `#`.
- **Auto-crop usually declines, and should**: streamers' panels reach the frame edges.
  `--top-crop=x,y,w,h` overrides it.

## Dashboard

`src/` is read at boot; `public/` is served from disk per request. After pulling server changes
run `docker restart mcsr-dashboard` on the lab (both containers share one image; the repo and
`/media` are bind mounts). The nightly strip names the running and the checked-out commit when
they differ (`code: { boot, now }` from `src/repoHead.ts`). Client changes need only a reload.

- **Suggestions** (`src/suggest.ts`, `src/suggestPresent.ts`): scored candidates, cached in
  `<mediaDir>/.suggest-cache.json`; bumping `CACHE_VERSION` re-fetches everything on the next
  scan (~340 MCSR API calls against 500/10 min). Scanned at boot, every `suggestCacheTtlMin`
  (30) for new matches, before the nightly picks, and fully on the `rescan` link.
- **Rival posts** (`src/rivalPosts.ts`): the competitor's (`rivalChannelHandle`, default
  `mcsrmatches`) last 50 uploads, matched to cards by nickname pair, date and run length (their
  video is the run plus a few seconds; a post of the wrong length is another match of the same
  pair). A posted match sorts after the fresh ones, in the nightly's order too.
- **Hook chips** (`src/hooks.ts`) put rivalry framing first: the audit measured rivalry hooks at
  9.36% CTR against 2.25% for descriptive ones.
- **Thumbnails carry a hook** (`hookText` in `thumbnail.json`; `src/thumbnailVariants.ts`),
  legible at YouTube's 246x138 grid size. The third variant is `hook: false`, the A/B control.
  `POST /api/thumbnails/:id/rerender` redoes the hooked variants with the typed hook and reports
  rendered / failed / nothing to change. A pipeline re-run keeps a manifest's headline; a still
  is reused only under the same headline. The Short reuses the manifest's hook so both halves
  of a match agree; the Short panel says when they do not.
- **Upload** sends `match-<id>.tags.txt` and refuses a title still containing `<HOOK>`; it adds
  the video to the season playlist (`PLHG-jSA-dWDo`), a per-matchup and a per-player playlist
  (`src/youtube.ts`; ids remembered per process because YouTube's list is eventually consistent).
  **A Studio upload is recognised without a tick** (`src/channelUploads.ts`): the channel's
  videos are paired to matches by the `/matches/<id>` segment in the pasted description; the
  YouTube panel's "check the channel" link lists the channel at once. The manual `uploaded`
  tick is the fallback for a video with no match link.
- **Publish kit** (`GET /api/publishkit/:id`): copy buttons for the title, the publish slot
  (`publishHourUtc`, default 19:00 UTC, the competitor's measured hour), description, tags, the
  Short's title/description, a pinned comment, a community post, and a DM per player. When
  `pullSource` is set it opens with an rsync *pull* the operator's PC runs (`src/publishSet.ts`;
  the lab host's path, not the container's `/media`) — pull, not push, because the image has no
  ssh client and the PC already reaches the lab. `GET /api/export/bundle/:id` is the same
  publish set as one `.tar`.
- **Publish checklist**: facts from disk plus manual toggles in `<mediaDir>/<id>/publish.json`
  (`src/matchShelf.ts`). The Rendered tab counts exported-and-not-uploaded and is ordered by what
  to publish next.
- **Dismiss** hides a suggestion (`DELETE /api/suggestions/:id`) with an undo line
  (`POST …/restore`). **Delete** refuses while any job writes into the match directory.
- **Nightly** (`src/nightly.ts`): at `nightlyRenderHourUtc` (default 3 UTC; `null` disables) the
  server renders the first eligible card in dashboard order, skipping the night if a render is
  running or under two matches of disk remain, then the Short (`nightlyRenderShort`) and the MP4
  (`nightlyRenderExport`); `nightlyNotifyUrl` gets one line on done / failed / aborted. The
  strip's `Run now` is the same path, as is a card's "Render + Short + MP4".
- Phones (<= 860px): list and match are two screens with a back bar; rows carry no Hide/Delete
  on a coarse pointer; the match screen offers jump links to the video, the kit and the Short.
- `docs/` is the GitHub Pages site (`mcsr.sezamki.site`: the OAuth homepage, privacy and terms
  pages Google checks). `deploy/mcsr-claude.service` is the lab's systemd user unit for the
  Claude container. Only `~/.claude` is a persisted volume in that container: save loose ends
  inside the repo.

## Chat replay (prototype)

`src/twitchChat.ts` fetches a VOD's chat through Twitch's web GQL persisted query without a
login, paging by **offset** — the cursor fails Twitch's integrity check without a browser token.
The pipeline saves it after `download-vods` and the Short scorer reads it. `remotion/ChatPanel.tsx`
renders it; where it sits in the frame is the operator's call, and nothing is wired into
`src/pipeline.ts` until then.

## Session preflight

`scripts/preflight.sh` runs at session start (`.claude/settings.json`), always exits 0, and
prints one line when everything is fine. When it flags something — no GitHub credentials, a
read-only PAT, an expiring OAuth token — fix that first. `bash scripts/preflight.sh` by hand.

## Known pitfalls

- **Season vs career stats.** `pickStats` (`src/overlayProps.ts`) falls back to career totals
  only when the season bucket has no ranked games, and the overlay then labels itself CAREER.
  Both paths are pinned by `src/overlayProps.test.ts`; don't "fix" the fallback away.
- **Elo must come from the match, not the user.** `user.eloRate` is the rating now; use
  `eloAtMatchStart()` everywhere or the same match shows different numbers in different places.
- **Props functions are async.** `computeOverlayProps` and `computeThumbnailProps` return
  promises; a missing `await` renders a pending promise as player data.
- **Never import `Overlay.tsx` from Node code** — its `import "./overlay.css"` crashes outside
  webpack. Shared geometry lives in `remotion/layout.ts`.
- **MLT silently drops ProRes 4444's alpha.** VP9 `yuva420p` is the only alpha format Remotion
  emits that MLT composites; when spot-checking, decode with `-c:v libvpx-vp9` or the alpha
  looks missing when it is not. ProRes is also ~1.9x slower in Remotion (no parallel encoding).
- **Timeline zero is the world-load thump** (`ANCHOR_SEC`, `src/kdenliveProject.ts`): match
  start lands at exactly 10 s. A clip whose match start is later than the anchor must be pushed
  into its own head, not un-blanked — the wrong fix renders perfectly and slides the overlay late.
- **Sync reads the picture, not the audio.** Both players freeze through the 10 s countdown
  (`src/countdownDetect.ts`); opponents play separate worlds, so audio cross-correlation was
  12–32 s wrong. `src/sync.ts` keeps audio only as the fallback.
- **The intro card's centre block must sit above the VS badge**: `.intro-player` positions the
  columns with a `transform` that `PlayerCard`'s inline transform replaces, so the names sit at
  y≈790 and anything under the badge collides with them.
- **PID 1 in the Claude container is `sleep infinity` and never reaps.** Zombies count against
  the pids cgroup limit (`/sys/fs/cgroup/pids.max`), and nothing can fork past it. Run anything
  that spawns Chromium — Playwright, `npm test` — through `python3 scripts/reap.py <command…>`,
  tell subagents to, and watch `ps -eo stat | grep -c '^Z'`.
- **No `ss`, `lsof` or `fuser` in the container.** Find a server with
  `ps -eo pid,args | grep 'src/server.ts'` and kill by PID; the process `comm` is `MainThread`.
- **Country flags render as tofu** without a colour-emoji font (cosmetic, intro card).
- **Verify visual changes by rendering** (`npm run still`, then read the PNG).
- **Run `npm test` after touching rendering or asset generation, and keep it green** — not
  after every edit: it drives Chromium and ffmpeg. The PostToolUse hook's `prettier` +
  `tsc --noEmit` covers per-edit mistakes.
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
