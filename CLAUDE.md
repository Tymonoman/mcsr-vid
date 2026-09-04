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

Three things these scripts do **not** do:

- `validate-project` catches malformed XML only. It exits 0 on a project whose
  media files are all missing, so it is not a substitute for opening the result
  in Kdenlive.
- `export:nvenc` needs an NVIDIA GPU and writes to a fixed `out/export.mp4`.
  Check support with `ffmpeg -hide_banner -encoders | grep nvenc`.
- `analytics` shells out to `~/.claude/skills/claude-youtube/`, which lives
  outside this repo and needs an OAuth token at
  `~/.claude/.tmp/youtube_oauth_token.json`.

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
- **Verify visual changes by rendering.** `npm run still -- <Composition> <out.png>`,
  then read the PNG. Don't reason about the JSX and call it done.
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

One loose end survives as a patch, not a branch: the `match-suggester`
worktree carried uncommitted work (7 files, +63/-105 — a net simplification of
`suggest.ts`, `matchScore.ts`, `config.ts`, `scoreCli.ts`, `tui.tsx`,
`tuiComponents.tsx`). It is saved at `~/mcsr-suggester-refactor.patch` and
applies cleanly to `main`. It has **not** been applied — decide deliberately
before assuming the suggester is in its final shape.
