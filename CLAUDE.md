# mcsr-vid

Pipeline that turns an MCSR Ranked match ID into a synced, split-timer-
overlaid video (`fetch-match` → `download-vods` → `validate-sync` →
`render-overlay` → `generate-project`), plus a thumbnail generator. Output
is published to a YouTube channel, **MCSR Replayoffs**.

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

As of 2026-08-09 there were **two divergent lines of work** on top of
`main` (4caf807, Phase 5) that hadn't been reconciled:

- `worktree-thumbnail-gen` (commit `e3905ac`, pushed to origin) — Phase 6
  thumbnail generator, plus the split-timer `resolveSplitSide` refactor.
- Uncommitted local changes in the primary checkout touching the same
  `resolveSplitSide` refactor (parseMatchId fix, VOD-count warning) — these
  overlap with what `e3905ac` already carries forward.
- This pixel-branding work branched from `main`, then merged in
  `worktree-thumbnail-gen` before adding the new badge/logo — so it carries
  both, but the primary checkout's uncommitted edits still need manual
  reconciliation (likely just re-applying the parseMatchId/VOD-warning bits
  on top, since the split-timer refactor itself is already present here).

If you're a session picking this up cold: check `git log --all --oneline`
and `git status` in the primary checkout before assuming `main` is current
— there is real unmerged work sitting in sibling branches/worktrees.
