import type { CSSProperties, FC } from "react";
import { Img, staticFile } from "remotion";

/**
 * The thumbnail's seed-type icon: a small isometric diorama of the structure, built block by block
 * from the game's own textures (remotion/assets/minecraft/, Minecraft 1.16.1 client) and drawn in
 * the inventory's projection, on a background that reads as the biome. Replaces the one-item
 * inventory slot the operator found weak beside @mcsrmatches' scene tiles (25 Sept 2026).
 *
 * A scene is data: `layers` from the ground up, each a plan of rows (z, back to front — the last
 * row faces the lower left) of characters (x, left to right — the last column faces the lower
 * right), one character per block from `BLOCKS`. Edit a character to move a block; preview with
 * `npm run still -- SeedIconSheet out.png`.
 */

/**
 * What one face shows: a texture from remotion/assets/minecraft/. A block texture (16x16) is cut
 * where the game's UVs put the face; `x`/`y` cut a fixed spot of a `sheet` instead (the chest).
 * `flip` for entity sides (stored upside down since 1.15); `fill` paints under the texture (the
 * dark room behind a window, the depth under water), which also keeps every face opaque, so the
 * half-pixel overlap between neighbours never shows as a seam.
 */
interface Tex {
  src: string;
  x?: number;
  y?: number;
  sheet?: number;
  flip?: boolean;
  fill?: string;
  /** Gives off light: drawn unshaded on every side (the portal, lava, magma). */
  glow?: boolean;
}

/** A box in texels inside its cell (0..16 a side), with the texture of each face the camera sees. */
interface Box {
  at: [number, number, number];
  size: [number, number, number];
  top: Tex;
  left: Tex; // the +z face, towards the lower left
  right: Tex; // the +x face, towards the lower right
}

/** `solid`: a full opaque cube, which hides its neighbours' faces against it. `liquid`: faces
 *  against the same liquid are not drawn. */
interface Block {
  boxes: Box[];
  solid?: boolean;
  liquid?: boolean;
}

const tex = (name: string, extra: Partial<Tex> = {}): Tex => ({ src: `${name}.png`, ...extra });
const box = (at: Box["at"], size: Box["size"], side: Tex, top = side): Box => ({
  at,
  size,
  top,
  left: side,
  right: side,
});
const cube = (side: string, top = side): Block => ({
  solid: true,
  boxes: [box([0, 0, 0], [16, 16, 16], tex(side), tex(top))],
});
/** Stairs whose upper step sits on the `up` side: n = -z, s = +z, w = -x, e = +x. */
const stairs = (t: string, up: "n" | "s" | "w" | "e"): Block => {
  const step: Record<typeof up, [Box["at"], Box["size"]]> = {
    n: [
      [0, 8, 0],
      [16, 8, 8],
    ],
    s: [
      [0, 8, 8],
      [16, 8, 8],
    ],
    w: [
      [0, 8, 0],
      [8, 8, 16],
    ],
    e: [
      [8, 8, 0],
      [8, 8, 16],
    ],
  };
  return { boxes: [box([0, 0, 0], [16, 8, 16], tex(t)), box(...step[up], tex(t))] };
};
const slab = (t: string): Block => ({ boxes: [box([0, 0, 0], [16, 8, 16], tex(t))] });
const liquid = (t: string, fill: string, height = 14): Block => ({
  liquid: true,
  boxes: [box([0, 0, 0], [16, height, 16], tex(t, { fill }))],
});
/** Crops: the game's # of four planes, each seen from the camera's side. */
const crop = (t: string): Block => {
  const p = tex(t);
  return {
    boxes: [
      box([0, 0, 4], [16, 16, 0], p),
      box([4, 0, 0], [0, 16, 16], p),
      box([12, 0, 0], [0, 16, 16], p),
      box([0, 0, 12], [16, 16, 0], p),
    ],
  };
};

/** A hull's gunwale: 3-texel spruce walls, 12 high, on the given sides of the cell (n s w e). */
const WALL: Record<string, [Box["at"], Box["size"]]> = {
  n: [[0, 0, 0], [16, 12, 3]],
  s: [[0, 0, 13], [16, 12, 3]],
  w: [[0, 0, 0], [3, 12, 16]],
  e: [[13, 0, 0], [3, 12, 16]],
};
const gunwale = (sides: string): Block => ({ boxes: [...sides].map((side) => box(...WALL[side], tex("spruce_planks"))) });

const CH = { src: "chest_normal.png", sheet: 64, flip: true };
/** The 1.16 chest: base 14x10x14, lid 14x5x14 on it, the latch on the front (+z); sunk 9 texels
 *  (about half its height) into a sand floor, in the block of sand it replaces. */
const SUNK = 9;
const CHEST: Block = {
  boxes: [
    box([0, 0, 0], [16, SUNK, 16], tex("sand")),
    {
      at: [1, SUNK, 1],
      size: [14, 10, 14],
      top: { ...CH, x: 28, y: 19, flip: false },
      left: { ...CH, x: 42, y: 33 },
      right: { ...CH, x: 0, y: 33 },
    },
    {
      at: [1, SUNK + 9, 1],
      size: [14, 5, 14],
      top: { ...CH, x: 28, y: 0, flip: false },
      left: { ...CH, x: 42, y: 14 },
      right: { ...CH, x: 0, y: 14 },
    },
    {
      at: [7, SUNK + 7, 15],
      size: [2, 4, 1],
      top: { ...CH, x: 1, y: 0, flip: false },
      left: { ...CH, x: 1, y: 1 },
      right: { ...CH, x: 3, y: 1 },
    },
  ],
};

const ROOM = "#1c1712";
const DEEP = "#16306e";
const SHALLOW = "#3f6fae";

/** The one legend every scene draws from (exported for the test). */
export const BLOCKS: Record<string, Block> = {
  // village
  g: cube("grass_block_side", "grass_block_top"),
  _: { boxes: [box([0, 0, 0], [16, 15, 16], tex("grass_path_side"), tex("grass_path_top"))] },
  c: cube("cobblestone"),
  P: cube("oak_planks"),
  L: cube("oak_log", "oak_log_top"),
  "#": {
    solid: true,
    boxes: [box([0, 0, 0], [16, 16, 16], tex("glass", { fill: ROOM }), tex("oak_planks"))],
  },
  D: { solid: true, boxes: [box([0, 0, 0], [16, 16, 16], tex("oak_door_bottom"), tex("oak_planks"))] },
  E: {
    solid: true,
    boxes: [box([0, 0, 0], [16, 16, 16], tex("oak_door_top", { fill: ROOM }), tex("oak_planks"))],
  },
  h: cube("hay_block_side", "hay_block_top"),
  f: { boxes: [box([0, 0, 0], [16, 15, 16], tex("dirt"), tex("farmland_moist"))] },
  w: crop("wheat_stage7"),
  "(": stairs("spruce_planks", "e"),
  ")": stairs("spruce_planks", "w"),
  "-": slab("spruce_planks"),
  // water
  "~": liquid("water_still", DEEP),
  ",": liquid("water_still", SHALLOW),
  // desert
  s: cube("sand"),
  S: cube("sandstone", "sandstone_top"),
  C: cube("cut_sandstone", "sandstone_top"),
  X: cube("chiseled_sandstone", "sandstone_top"),
  o: cube("orange_terracotta"),
  b: cube("blue_terracotta"),
  V: { solid: true, boxes: [box([0, 0, 0], [16, 16, 16], { src: "", fill: "#1d140c" })] }, // a dark doorway
  // nether
  O: cube("obsidian"),
  Q: cube("crying_obsidian"),
  "|": { boxes: [box([0, 0, 6], [16, 16, 4], tex("nether_portal", { fill: "#2a0654", glow: true }))] },
  G: cube("gold_block"),
  n: cube("netherrack"),
  m: { solid: true, boxes: [box([0, 0, 0], [16, 16, 16], tex("magma", { glow: true }))] },
  l: { liquid: true, boxes: [box([0, 0, 0], [16, 16, 16], tex("lava_still", { glow: true }))] },
  // ships and treasure
  K: cube("spruce_planks"),
  $: CHEST,
  // a hull's walls, drawn as the plan sees them: the dark part is the wall
  "▀": gunwale("n"),
  "▄": gunwale("s"),
  "▌": gunwale("w"),
  "▛": gunwale("nw"),
  "▙": gunwale("sw"),
  "▜": gunwale("ne"),
  "▟": gunwale("se"),
  "]": gunwale("nes"),
  "!": { boxes: [box([5, 0, 5], [6, 16, 6], tex("oak_log"), tex("oak_log_top"))] }, // a mast
};

interface Scene {
  /** CSS background behind the diorama: the sky, the sea, the dark. */
  bg: string;
  layers: string[][];
  /** Past 1 the tile crops the diorama's outer corners, for a scene that should fill it. */
  zoom?: number;
  /** The point (in blocks) put at the tile's centre; the diorama's middle when left out. */
  focus?: [number, number, number];
}

const SKY = "linear-gradient(#5d9cf0, #b9d8ff)";
const SEA = "linear-gradient(#2d5fb8, #183a80)";

// prettier-ignore
export const SCENES: Record<string, Scene> = {
  // A plains house (cobblestone footing, oak walls and corner logs, a door and a window under a
  // spruce gable) on grass, a path from its door, hay bales and a wheat plot.
  VILLAGE: {
    bg: SKY,
    zoom: 1.08,
    layers: [
      ["gggggg",
       "gggggg",
       "ggggff",
       "ggggff",
       "ggggff",
       "gg_ggg"],
      ["......",
       ".LcL..",
       ".c.cww",
       ".c.cww",
       "hLDLww",
       "h....."],
      ["......",
       ".LPL..",
       ".P.#..",
       ".P.P..",
       ".LEL..",
       "......"],
      ["......",
       "(PPP).",
       "(PPP).",
       "(PPP).",
       "(PPP).",
       "......"],
      ["......",
       ".(P)..",
       ".(P)..",
       ".(P)..",
       ".(P)..",
       "......"],
      ["......",
       "..-...",
       "..-...",
       "..-...",
       "..-...",
       "......"],
    ],
  },
  // A wrecked hull low in the sea: dark spruce sides with a gap stove in, an oak deck, the bow
  // up, a snapped mast, a sand bar beside it.
  SHIPWRECK: {
    bg: SEA,
    zoom: 1.3,
    focus: [3.5, 2.4, 2.5],
    layers: [
      ["~~~~~~~",
       "~~~~~~~",
       "~~~~~~~",
       "~~~~~~~",
       "~~~~~~~",
       "~~~~~~~"],
      ["~~~~~~~",
       "KPPPPK~",
       "KPPPPPK",
       "KPPPPK~",
       "~~~sss~",
       "~~~~~~~"],
      [".......",
       "▛▀▀▀▀▜.",
       "▌..!..]",
       "▙▄.▄▄▟.",
       ".......",
       "......."],
      [".......",
       ".....▜.",
       "...!..]",
       ".....▟.",
       ".......",
       "......."],
      [".......",
       ".......",
       "...!...",
       ".......",
       ".......",
       "......."],
    ],
  },
  // Two towers marked with an orange and blue terracotta cross either side of the stepped
  // sandstone pyramid, its dark doorway between them, on sand.
  DESERT_TEMPLE: {
    bg: SKY,
    zoom: 1.08,
    layers: [
      ["sssssss",
       "sssssss",
       "sssssss",
       "sssssss",
       "sssssss",
       "sssssss",
       "sssssss"],
      ["....CCC",
       ".SSSCCC",
       ".SSSCCC",
       ".SSSSS.",
       "CCCSSS.",
       "CCCSSV.",
       "CCC...."],
      ["....CCC",
       ".SSSCCo",
       ".SSSCoC",
       ".SSSSS.",
       "CCCSSS.",
       "CCoSSS.",
       "CoC...."],
      ["....CCo",
       "....CCb",
       "..SSobo",
       "..SSS..",
       "CCoSS..",
       "CCb....",
       "obo...."],
      ["....CCC",
       "....CCo",
       "....CoC",
       "...X...",
       "CCC....",
       "CCo....",
       "CoC...."],
      ["....CCC",
       "....CCC",
       "....CCC",
       ".......",
       "CCC....",
       "CCC....",
       "CCC...."],
    ],
  },
  // An obsidian frame with two blocks gone and crying obsidian in it, the portal lit, a gold
  // block, on netherrack with magma and lava.
  RUINED_PORTAL: {
    bg: "linear-gradient(#2a1633, #120a14)",
    zoom: 1.1,
    layers: [
      ["nnnnnnn",
       "nnnnnmn",
       "nnnnnnn",
       "nmnnnnn",
       "nnnnnll",
       "nnnnlll"],
      ["n......",
       "......n",
       ".OOOO..",
       "....nG.",
       "n......",
       "......."],
      [".......",
       ".......",
       ".Q||O..",
       ".......",
       ".......",
       "......."],
      [".......",
       ".......",
       ".O||Q..",
       ".......",
       ".......",
       "......."],
      [".......",
       ".......",
       ".O||...",
       ".......",
       ".......",
       "......."],
      [".......",
       ".......",
       ".QO....",
       ".......",
       ".......",
       "......."],
    ],
  },
  // A chest half dug out of a beach, the sea at its side, seen close.
  BURIED_TREASURE: {
    bg: SEA,
    zoom: 2,
    focus: [2.5, 2.2, 2.5],
    layers: [
      ["SSSSS",
       "SSSSS",
       "SSSSS",
       "SSSSS",
       "SSSSS"],
      ["sssss",
       ",ssss",
       "~,$ss",
       "~~,ss",
       "~~~,s"],
    ],
  },
};

/** The seed types there is an icon for; any other value draws nothing. */
export const SEED_ICON_TYPES = Object.keys(SCENES);

// The inventory's projection of one texel: x runs right-down, z left-down, y straight up.
const C = Math.SQRT1_2;
const S = C * 0.5; // sin 45 * sin 30
const V = Math.sqrt(3) / 2; // cos 30
/** The GUI's face shading: top, left, right. */
const SHADE = { top: 1, left: 0.8, right: 0.6 };
const project = (x: number, y: number, z: number) => [(x - z) * C, (x + z) * S - y * V];

const pixelated: CSSProperties = { imageRendering: "pixelated" };

function Face({ m, w, h, t, shade }: { m: number[]; w: number; h: number; t: Tex; shade: number }) {
  const sheet = t.sheet ?? 16;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: w,
        height: h,
        overflow: "hidden",
        background: t.fill,
        transformOrigin: "0 0",
        transform: `matrix(${m.join(",")})`,
      }}
    >
      <div style={{ position: "absolute", inset: 0, transform: t.flip ? "scaleY(-1)" : undefined }}>
        {t.src && (
          <Img
            src={staticFile(`minecraft/${t.src}`)}
            style={{
              ...pixelated,
              position: "absolute",
              left: -(t.x ?? 0),
              top: -(t.y ?? 0),
              width: sheet,
              height: sheet,
            }}
          />
        )}
      </div>
      {shade < 1 && (
        <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${1 - shade})` }} />
      )}
    </div>
  );
}

/** One box placed in the world (texels), with the faces that survive culling. */
interface Placed {
  key: string;
  at: [number, number, number];
  size: [number, number, number];
  faces: { top?: Tex; left?: Tex; right?: Tex };
  order: number;
}

/** Every visible box of a scene, back to front (painter's order: cell x+y+z, then each box by its centre). */
function place(layers: string[][]): Placed[] {
  const at = (x: number, y: number, z: number) => BLOCKS[layers[y]?.[z]?.[x] ?? "."];
  const out: Placed[] = [];
  layers.forEach((rows, y) =>
    rows.forEach((row, z) =>
      [...row].forEach((ch, x) => {
        const block = BLOCKS[ch];
        if (!block) return;
        const hides = (n: Block | undefined) => !!n && (n.solid || (block.liquid && n === block));
        const [above, front, side] = [at(x, y + 1, z), at(x, y, z + 1), at(x + 1, y, z)];
        block.boxes.forEach((b, i) => {
          const [bx, by, bz] = b.at;
          const [w, h, d] = b.size;
          // A face on the cell's edge is hidden by a solid neighbour; a liquid's by the same liquid.
          const faces = {
            top: w && d && !((by + h === 16 || block.liquid) && hides(above)) ? b.top : undefined,
            left: w && h && !((bz + d === 16 || block.liquid) && hides(front)) ? b.left : undefined,
            right: d && h && !((bx + w === 16 || block.liquid) && hides(side)) ? b.right : undefined,
          };
          if (!faces.top && !faces.left && !faces.right) return;
          out.push({
            key: `${x},${y},${z},${i}`,
            at: [x * 16 + bx, y * 16 + by, z * 16 + bz],
            size: [w, h, d],
            faces,
            // Within a cell, back boxes first: by the sum of each box's centre (under 48).
            order: (x + y + z) * 64 + bx + by + bz + (w + h + d) / 2,
          });
        });
      }),
    ),
  );
  return out.sort((a, b) => a.order - b.order);
}

/** A block texture's UV origin for a face, as the game maps a box's position onto its texture. */
const uv = (t: Tex, u: number, v: number): Tex => (t.sheet ? t : { ...t, x: t.x ?? u, y: t.y ?? v });

function Diorama({ scene: { layers, zoom = 1, focus }, size, inset }: { scene: Scene; size: number; inset: number }) {
  const boxes = place(layers);
  // Fit the projected bounds of every drawn box into the tile.
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { at, size: s } of boxes)
    for (const dx of [0, s[0]])
      for (const dy of [0, s[1]])
        for (const dz of [0, s[2]]) {
          const [px, py] = project(at[0] + dx, at[1] + dy, at[2] + dz);
          [x0, y0, x1, y1] = [Math.min(x0, px), Math.min(y0, py), Math.max(x1, px), Math.max(y1, py)];
        }
  const room = size - 2 * inset;
  const k = zoom * Math.min(room / (x1 - x0), room / (y1 - y0));
  const [fx, fy] = focus ? project(focus[0] * 16, focus[1] * 16, focus[2] * 16) : [(x0 + x1) / 2, (y0 + y1) / 2];
  const ox = size / 2 - k * fx;
  const oy = size / 2 - k * fy;
  const p = (x: number, y: number, z: number) => {
    const [px, py] = project(x, y, z);
    return [ox + k * px, oy + k * py];
  };
  // Each face is grown by half a screen pixel on every side, so neighbouring faces overlap
  // instead of letting the background through their anti-aliased edges as a seam.
  const e = 0.5 / k;
  const face = (
    key: string,
    u: number[],
    v: number[],
    o: number[],
    w: number,
    h: number,
    t: Tex,
    shade: number,
  ) => {
    const sx = (w + 2 * e) / w;
    const sy = (h + 2 * e) / h;
    const m = [
      u[0] * sx,
      u[1] * sx,
      v[0] * sy,
      v[1] * sy,
      o[0] - e * (u[0] + v[0]),
      o[1] - e * (u[1] + v[1]),
    ];
    return <Face key={key} m={m} w={w} h={h} t={t} shade={t.glow ? 1 : shade} />;
  };
  const ux = [k * C, k * S]; // +x
  const uz = [-k * C, k * S]; // +z
  const down = [0, k * V]; // -y
  return (
    <>
      {boxes.flatMap(({ key, at: [x, y, z], size: [w, h, d], faces: { top, left, right } }) => {
        const [cx, cy, cz] = [x % 16, y % 16, z % 16];
        return [
          top && face(`${key}t`, ux, uz, p(x, y + h, z), w, d, uv(top, cx, cz), SHADE.top),
          left && face(`${key}l`, ux, down, p(x, y + h, z + d), w, h, uv(left, cx, 16 - cy - h), SHADE.left),
          right &&
            face(
              `${key}r`,
              [-uz[0], -uz[1]],
              down,
              p(x + w, y + h, z + d),
              d,
              h,
              uv(right, 16 - cz - d, 16 - cy - h),
              SHADE.right,
            ),
        ];
      })}
    </>
  );
}

export const SeedIconMC: FC<{ type: string | null | undefined; size: number }> = ({ type, size }) => {
  const scene = type ? SCENES[type] : undefined;
  if (!scene) return null;
  // The frame: one dark line, a texel of the tile's own scale (2 px at 132, 1 at 64).
  const line = Math.max(1, Math.round(size / 64));
  return (
    <div
      style={{ position: "relative", width: size, height: size, overflow: "hidden", background: scene.bg }}
    >
      <Diorama scene={scene} size={size} inset={line + size * 0.04} />
      <div style={{ position: "absolute", inset: 0, border: `${line}px solid var(--panel-edge, #0d0c10)` }} />
    </div>
  );
};

/** Review sheet (the `SeedIconSheet` composition): every type at the thumbnail's 132 px, and at
 *  64 px, about what a phone's home feed shows. */
export const SeedIconSheet: FC = () => (
  <div style={{ width: "100%", height: "100%", background: "#221f27", padding: 24 }}>
    {[132, 64].map((size) => (
      <div key={size} style={{ display: "flex", gap: 24, alignItems: "center", marginBottom: 24 }}>
        {SEED_ICON_TYPES.map((type) => (
          <div key={type} style={{ width: 132, display: "flex", justifyContent: "center" }}>
            <SeedIconMC type={type} size={size} />
          </div>
        ))}
      </div>
    ))}
  </div>
);
