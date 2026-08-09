# MCSR RePlayoffs brand assets

`logo.png` (800×800, YouTube profile picture) and `banner.png` (2560×1440,
YouTube channel banner). Both are generated, not hand-drawn — they use the
exact same ring geometry as `remotion/pixelBadge.ts` (the in-video badge)
and the project's real Monocraft font + panel/crimson/warped/gold/quartz
palette from `remotion/overlay.source.css`, so channel art and video overlay
match instead of approximating each other.

To regenerate after a palette or badge-geometry change:

```
pip install pillow
python3 branding/generate_brand_assets.py
```

If `pixelBadge.ts`'s ring parameters (grid size, radii, gap angles) change,
mirror them in `build_ring_cells()` here too — the two are intentionally
kept as parallel implementations rather than one importing the other, since
one is TypeScript (runs in the Remotion/browser render) and one is Python
(runs at asset-generation time, offline).
