import type { CSSProperties, FC } from "react";
import { Img, staticFile } from "remotion";

/**
 * The thumbnail's seed-type icon, built from the game's own textures (remotion/assets/minecraft/,
 * Minecraft 1.16.1 client): the thing as the inventory draws it, in a GUI slot. An item is its
 * flat sprite; a block is the inventory's 3-D cube at the inventory's 0.625 scale. The operator's
 * pick of two looks, 24 Sept 2026, after a hand-drawn set "doesnt look like minecraft at all".
 */

/** An axis-aligned box in block units (0..16), with the texture each visible face shows. */
interface Box {
  at: [number, number, number];
  size: [number, number, number];
  top: string;
  left: string;
  right: string;
}

const cube = (side: string, top = side): Box[] => [
  { at: [0, 0, 0], size: [16, 16, 16], top, left: side, right: side },
];

type Art = { item: string } | { block: Box[] };

const SLOT_ART: Record<string, Art> = {
  VILLAGE: { item: "bell.png" }, // bells only generate in villages
  SHIPWRECK: { item: "oak_boat.png" },
  DESERT_TEMPLE: { block: cube("chiseled_sandstone.png", "sandstone_top.png") },
  RUINED_PORTAL: { block: cube("crying_obsidian.png") }, // the overworld's only crying obsidian
  BURIED_TREASURE: { item: "heart_of_the_sea.png" }, // only found in buried treasure
};

/** The seed types there is an icon for; any other value draws nothing. */
export const SEED_ICON_TYPES = Object.keys(SLOT_ART);

// The inventory's projection of one block unit: x runs right-down, z left-down, y straight up.
const C = Math.SQRT1_2;
const S = C * 0.5; // sin 45 * sin 30
const V = Math.sqrt(3) / 2; // cos 30
/** The GUI's face shading: top, left, right. */
const SHADE = { top: 1, left: 0.8, right: 0.6 };

const pixelated: CSSProperties = { imageRendering: "pixelated" };

function Face({ m, w, h, src, shade }: { m: number[]; w: number; h: number; src: string; shade: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: w,
        height: h,
        overflow: "hidden",
        transformOrigin: "0 0",
        transform: `matrix(${m.join(",")})`,
      }}
    >
      <Img
        src={staticFile(`minecraft/${src}`)}
        style={{ ...pixelated, position: "absolute", left: 0, top: 0, width: 16, height: 16 }}
      />
      {shade < 1 && (
        <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${1 - shade})` }} />
      )}
    </div>
  );
}

/** Boxes projected the way the inventory draws a block, centred on (cx, cy), k px per block unit. */
function Block({ boxes, k, cx, cy }: { boxes: Box[]; k: number; cx: number; cy: number }) {
  const p = (x: number, y: number, z: number) => [
    cx + k * ((x - 8) * C - (z - 8) * C),
    cy + k * ((x - 8) * S + (z - 8) * S - (y - 8) * V),
  ];
  // Each face is grown by half a screen pixel on every side, so neighbouring faces overlap
  // instead of letting the background through their anti-aliased edges as a dark seam.
  const e = 0.5 / k;
  const face = (
    key: string,
    u: number[],
    v: number[],
    o: number[],
    w: number,
    h: number,
    src: string,
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
    return <Face key={key} m={m} w={w} h={h} src={src} shade={shade} />;
  };
  const ux = [k * C, k * S]; // +x
  const uz = [-k * C, k * S]; // +z
  const down = [0, k * V]; // -y
  return (
    <>
      {boxes.flatMap(({ at: [x, y, z], size: [w, h, d], top, left, right }, i) => [
        face(`${i}t`, ux, uz, p(x, y + h, z), w, d, top, SHADE.top),
        face(`${i}l`, ux, down, p(x, y + h, z + d), w, h, left, SHADE.left),
        face(`${i}r`, [-uz[0], -uz[1]], down, p(x + w, y + h, z + d), d, h, right, SHADE.right),
      ])}
    </>
  );
}

/**
 * Minecraft's 18x18 GUI slot (#8b8b8b, #373737 top-left edge, white bottom-right, grey corners)
 * on a 3-texel ring of the inventory window around it (black rounded outline, white/#555 bevel,
 * #c6c6c6): the slot's own dark edge disappears on a dark thumbnail without it. 24x24 texels.
 * These are the game's GUI greys, deliberately outside the brand palette — they are what makes it
 * read as the inventory.
 */
function SlotFrame({ size }: { size: number }) {
  const r = (x: number, y: number, w: number, h: number, fill: string) => (
    <rect key={`${x},${y},${w},${h}`} x={x} y={y} width={w} height={h} fill={fill} />
  );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      shapeRendering="crispEdges"
      style={{ position: "absolute", inset: 0 }}
    >
      {r(1, 1, 22, 22, "#c6c6c6")}
      {r(2, 0, 20, 1, "#000")}
      {r(2, 23, 20, 1, "#000")}
      {r(0, 2, 1, 20, "#000")}
      {r(23, 2, 1, 20, "#000")}
      {[
        [1, 1],
        [22, 1],
        [1, 22],
        [22, 22],
      ].map(([x, y]) => r(x, y, 1, 1, "#000"))}
      {r(2, 1, 19, 1, "#fff")}
      {r(1, 2, 1, 19, "#fff")}
      {r(3, 22, 19, 1, "#555")}
      {r(22, 3, 1, 19, "#555")}
      {r(3, 3, 18, 18, "#8b8b8b")}
      {r(3, 3, 17, 1, "#373737")}
      {r(3, 3, 1, 17, "#373737")}
      {r(4, 20, 17, 1, "#fff")}
      {r(20, 4, 1, 17, "#fff")}
    </svg>
  );
}

export const SeedIconMC: FC<{ type: string | null | undefined; size: number }> = ({ type, size }) => {
  const art = type ? SLOT_ART[type] : undefined;
  if (!art) return null;
  const px = size / 24;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <SlotFrame size={size} />
      {"item" in art ? (
        <Img
          src={staticFile(`minecraft/${art.item}`)}
          style={{
            ...pixelated,
            position: "absolute",
            left: 4 * px,
            top: 4 * px,
            width: 16 * px,
            height: 16 * px,
          }}
        />
      ) : (
        <Block boxes={art.block} k={px * 0.625} cx={size / 2} cy={size / 2} />
      )}
    </div>
  );
};
