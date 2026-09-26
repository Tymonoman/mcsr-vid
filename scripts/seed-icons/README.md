# Seed-icon scenes

Vanilla Minecraft 1.16.1 structures, drawn from the game's own data: `bake.py` reads a structure
template out of the client jar, applies your edits, and resolves every block exactly as the game
bakes it (blockstate variants or multipart → block models with parent inheritance and `#texture`
variables → elements with per-face uv, uv rotation, cullface, tint, element rotation + rescale →
the variant's x/y rotation and uvlock). `remotion/SeedScene.tsx` (composition `SeedIconScene`)
draws the faces, back to front, one affine-mapped texture per face.

The thumbnail's seed-type icons are renders of these scenes: `icons.sh` maps each type to its
spec and writes `remotion/assets/seed-icons/<TYPE>.png` (what `remotion/SeedIconMC.tsx` draws) and
`<TYPE>-alt.png` (the other projection, iso vs 2d; rename it over `<TYPE>.png` to swap). Change a
spec in `scenes/`, run `icons.sh <TYPE>`, look at the PNG, commit it.

```sh
scripts/seed-icons/icons.sh [TYPE...]                           # re-render the thumbnail icons
scripts/seed-icons/render.sh <spec.json> <out.png> [size]     # bake + render, one command
python3 scripts/seed-icons/bake.py <spec.json>                  # bake only -> remotion/seedIcons/<name>.json
python3 scripts/seed-icons/bake.py --check <dir|file.nbt|file.json>...   # resolve every block, list failures
python3 scripts/seed-icons/bake.py --selftest                   # the rotation/uv conventions, against the jar
```

The jar is `$MC_JAR`, else `--jar`, else `~/.cache/mcsr-vid/client-1.16.1.jar`, downloaded from
Mojang's piston-meta manifest (sha1-checked) when missing. Every texture a scene uses is copied
out of the jar, raw bytes, to `remotion/assets/minecraft/textures/<jar path>.png` (Remotion's
public dir, so `staticFile("minecraft/textures/block/oak_planks.png")`). Render at 1024 (the
default) and let the thumbnail downscale the PNG.

## Spec

```json
{
  "name": "village",
  "template": "village/plains/houses/plains_small_house_1",
  "palette": 0,
  "edits": [
    { "op": "keep", "from": [0, 0, 0], "to": [6, 3, 6] },
    { "op": "replace", "map": { "cobblestone": "mossy_cobblestone" } },
    { "op": "set", "at": [3, 1, 3], "block": "chest[facing=west]" },
    { "op": "ground", "block": "grass_block", "margin": 1 }
  ],
  "view": { "projection": "iso", "facing": "southwest", "zoom": 1.2, "padding": 0.06 },
  "background": "sky"
}
```

| Key | Meaning |
| --- | --- |
| `name` | Output stem: `remotion/seedIcons/<name>.json`. Default: the spec file's name. |
| `template` | A structure under the jar's `data/minecraft/structures/` without `.nbt` (`shipwreck/with_mast`, `ruined_portal/portal_1`, `village/plains/town_centers/plains_meeting_point_1`), or a path (relative to the spec) to an `.nbt` or to a structures JSON (`{size, blocks: [[x,y,z,"name",{props}]]}`). `null` = start empty. Jigsaw blocks become their `final_state`; air, structure voids and structure blocks (data markers) are dropped, as the game does. Entities in templates are ignored. |
| `palette` | Which palette of a multi-palette template (shipwrecks carry 8 wood sets; 0 is oak hull, spruce deck, oak logs — the wiki's "Oak" render). |
| `edits` | Applied in order; coordinates are the template's block coordinates (x east, y up, z south), inclusive boxes. |
| `view` | Camera and framing, below. |
| `background` | `"none"` (transparent PNG, default), a preset `"sky"`, `"sea"`, `"nether"`, or any CSS background. |
| `outline` | A dark contour round the structure's silhouette, below. Off when left out. |

A block is `"name"` or `"name[prop=value,...]"` (with or without `minecraft:`); `"props": {...}`
beside it adds or overrides properties. Missing properties take the default state (axis y, half
bottom, facing north, ...).

### Edits

| `op` | Fields | Does |
| --- | --- | --- |
| `set` | `at`, `block`, `props?` | One block. |
| `fill` | `from`, `to`, `block`, `props?`, `onlyAir?` | A box; `onlyAir: true` leaves existing blocks. |
| `remove` | `at` or `from`/`to` (or neither = everywhere), `blocks?` | Deletes; `blocks: ["chest", ...]` limits it to those names. |
| `keep` | same as remove | Deletes everything *outside* (crop to a region). |
| `replace` | `map: {"old": "new[props]"}` | Renames blocks, keeping their properties (wood swaps, etc.). |
| `ground` | `block?` (grass_block), `props?`, `y?` (under the lowest block), `depth?` (1), `margin?` (1) | Fills air under the scene's footprint + margin. |
| `water` | `top`, `from?` (lowest y), `margin?` (1) | Fills air in the footprint + margin, `from`..`top`, with water source blocks. |
| `shift` | `by: [dx, dy, dz]` | Moves everything. |
| `nudge` | `at`, `by: [dx, dy, dz]` (blocks, fractions allowed) | Draws that one block moved off its cell; it is still culled and ordered as its cell. The buried treasure's chest sits `-0.4375` (7 texels) into the sand this way. |

### View

| Key | Default | Meaning |
| --- | --- | --- |
| `projection` | `"iso"` | `"iso"`: the inventory / wiki-render angle (orthographic, 30° down, 45° round; measured against the wiki renders to the pixel). `"2d"`: an orthographic elevation straight at one side; only the faces turned to the camera are drawn. |
| `facing` | iso `"southeast"`, 2d `"south"` | iso: the corner the camera stands at (`southeast` puts south on the left and east on the right; `southwest`, `northwest`, `northeast` turn it). 2d: the side it looks at (`south`, `north`, `east`, `west`). |
| `size` | 1024 | Square output in px (`render.sh`'s third argument sets it). |
| `padding` | 0.06 | Margin around the auto-fitted scene, a fraction of the size per side. |
| `zoom` | 1 | Past 1 crops the scene's edges (the old BURIED_TREASURE used 2). |
| `center` | the scene's middle | A world point `[x, y, z]` in blocks (block centres are `x + 0.5`) to put at the square's centre. |
| `offset` | `[0, 0]` | A last shift, fractions of the size (`[0, 0.1]` moves the scene down a tenth). |
| `faceShade` | iso on, 2d off | Minecraft's face shading, lit the way the wiki renders are: up 1.0, down 0.5, the left-hand side 0.8, the right-hand side 0.6. Emissive faces (lava, portal, magma, glowstone, lanterns, fire) and model elements with `shade: false` (torches, flowers, crops) are never shaded. |
| `depthShade` | 0 | Darkens a face by this much per block it lies behind the frontmost face (floor 0.35). For 2d, where recessed blocks otherwise look flat: 0.08–0.15. |
| `depthShadeMin` | 0.35 | The floor `depthShade` stops at. Raise it (≈0.7) to keep a far backdrop sunlit while a one-block recess still darkens. |
| `overhangShade` | off | Multiplies a side face that has a block above the cell in front of it (a doorway, a recess under a lintel, a tunnel). 0.5–0.6 makes a 2d entrance read as an opening. |
| `seam` | 0.5 | Screen px each opaque face is grown by, so neighbours overlap instead of leaving hairline gaps. |

### Outline

```json
"outline": { "color": "#0d0c10", "px": 24, "exclude": ["sand"], "base": true }
```

The faces of every block not in `exclude` are drawn once more as one silhouette in `color`, grown
by a square of `px` (at a 1024 px render; scaled with `size`) and laid under the scene, so the
line shows only where the structure meets the sky or the ground. Square, not round: it keeps the
pixel steps of a block skyline.

| Key | Default | Meaning |
| --- | --- | --- |
| `color` | `#0d0c10` (`--panel-edge`) | The line's colour. |
| `px` | — | Width in px at 1024: 16 is 2 px on the thumbnail's 132 px tile, 24 is 3. |
| `exclude` | `[]` | Block names drawn but never outlined (the ground). `bake.py` marks their faces `bare: 1`. |
| `base` | false | Draw the excluded blocks first, under the contour, so it also runs along the structure's foot. Right for a 2d elevation, whose ground never covers the structure; wrong where it does. |
| `inner` | off | Also line where the front overlaps what is behind it: the faces within this many blocks of the nearest outlined face get a contour of their own over the rest (the temple's towers against its recessed body). |
| `innerPx` | `px` | That inner line's width. |

`DESERT_TEMPLE-2d.json` uses `px` 24 with `base` (the operator, 26 Sept 2026: "add an outline to
the desert temple so its easier to recognize"); the `DESERT_TEMPLE-2d-outline-*.json` specs are
the other widths, colours and the inner-edge variant it was picked from.

## What is and is not drawn

- Every block model in the jar, by the game's rules. Grass, leaves, water are tinted plains
  colours (grass `#91BD59`, foliage `#77AB2F`, water `#3F76E4`), multiplied texel by texel;
  animated strips (water, lava, portal, magma) show their first frame; leaves are fancy (with holes).
- Culling: a face with a `cullface` is dropped against a full opaque cube; glass against the same
  glass, a fluid against the same fluid.
- Fluids have no model: water and lava are boxes of the game's height (8/9 of a block for a
  source, full under the same fluid), `water_still` / `lava_still` on every side, water
  translucent. At 1024 px a block-grid shows faintly through large water faces; it is gone at
  thumbnail size.
- Block entities have no model in 1.16 and are built from their entity textures with the
  renderers' own geometry: chest / trapped chest / ender chest (single only; `type=left/right`
  draws as two singles), beds (the frame, mattress and pillow; the four 3-px legs are left out),
  the bell's body (its bars and posts are the block model). Not drawn: signs, banners, skulls,
  shulker boxes, item frames, paintings, mobs — none occur in the plains, shipwreck or
  ruined-portal templates. `waterlogged=true` draws no water (the wiki renders show none either);
  add water with the `water` edit.
- Not modelled: ambient occlusion and the random processors the game runs at placement
  (ruined-portal blackstone/moss swaps, vines, missing blocks in degraded wrecks). Pick a
  `_degraded` template, or edit, for those.

## Output

`remotion/seedIcons/<name>.json` (gitignored: an intermediate, rebuilt by every render): `{name, template, size, view, background, textures:
[{src, uv}], faces: [...]}`. A face is `{t: texture index, p: [corner(u0,v0), corner(u1,v0),
corner(u0,v1)] in blocks, uv: [u0,v0,u1,v1] (in the texture's `uv` units: 16 for block
textures, 64 chests and beds, 32 the bell), n: outward normal, c: the block's cell, o: the
element's centre, tint?: "#rrggbb", flat?: 1 (never shaded), g?: 1 (emissive)}`. Any planar face
under an orthographic camera is the affine image of its uv rectangle, so the renderer draws each
with one `setTransform` + `drawImage` (canvas, nearest neighbour), sorted by the block cell's
depth, then the element's.

## Structures that are not templates

The desert pyramid is code in the game (`DesertPyramidPiece`), not an `.nbt`:
`structures/build_pyramid.py` replays 1.16.1's `postProcess` above ground and writes
`structures/desert_pyramid.json`, which the `DESERT_TEMPLE-*` specs name as `../structures/desert_pyramid.json`.
