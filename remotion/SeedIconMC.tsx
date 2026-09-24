import type { CSSProperties, FC } from "react";
import { Img, staticFile } from "remotion";

/**
 * Seed-type icons built from the game's own textures (remotion/assets/minecraft/, Minecraft
 * 1.16.1 client). Two looks for the operator to choose from, 24 Sept 2026:
 * - "slot": the thing as the inventory draws it, in a GUI slot. An item is its flat sprite; a
 *   block is the inventory's 3-D cube at the inventory's 0.625 scale.
 * - "iso": one big 3-D block, the inventory's projection (30 deg pitch, 45 deg yaw).
 */
export type SeedIconStyle = "slot" | "iso";

/** Where a face's pixels come from: a texture file and the face's top-left texel in it. */
interface Crop {
  src: string;
  x?: number;
  y?: number;
  /** The texture's size when it is a sheet (the chest), else 16. */
  sheet?: number;
  /** Entity textures since 1.15 hold their side faces upside down. */
  flip?: boolean;
}

/** An axis-aligned box in block units (0..16), with what its three visible faces show. */
interface Box {
  at: [number, number, number];
  size: [number, number, number];
  top: Crop;
  left: Crop;
  right: Crop;
}

const cube = (side: string, top = side): Box[] => [
  { at: [0, 0, 0], size: [16, 16, 16], top: { src: top }, left: { src: side }, right: { src: side } },
];

const CH = { src: "chest_normal.png", sheet: 64 };
/** The 1.16 chest model: base 14x10x14, lid 14x5x14 on it, the latch on the front (left face). */
const CHEST: Box[] = [
  {
    at: [1, 0, 1],
    size: [14, 10, 14],
    top: { ...CH, x: 28, y: 19 },
    left: { ...CH, x: 42, y: 33, flip: true },
    right: { ...CH, x: 0, y: 33, flip: true },
  },
  {
    at: [1, 9, 1],
    size: [14, 5, 14],
    top: { ...CH, x: 28, y: 0 },
    left: { ...CH, x: 42, y: 14, flip: true },
    right: { ...CH, x: 0, y: 14, flip: true },
  },
  {
    at: [7, 7, 15],
    size: [2, 4, 1],
    top: { ...CH, x: 1, y: 0 },
    left: { ...CH, x: 1, y: 1, flip: true },
    right: { ...CH, x: 3, y: 1, flip: true },
  },
];

type Art = { item: string } | { block: Box[] };

const SLOT_ART: Record<string, Art> = {
  VILLAGE: { item: "bell.png" },
  SHIPWRECK: { item: "oak_boat.png" },
  DESERT_TEMPLE: { block: cube("chiseled_sandstone.png", "sandstone_top.png") },
  RUINED_PORTAL: { block: cube("crying_obsidian.png") },
  BURIED_TREASURE: { item: "heart_of_the_sea.png" },
};

const ISO_ART: Record<string, Box[]> = {
  VILLAGE: cube("hay_block_side.png", "hay_block_top.png"),
  SHIPWRECK: cube("spruce_planks.png"),
  DESERT_TEMPLE: cube("chiseled_sandstone.png", "sandstone_top.png"),
  RUINED_PORTAL: cube("crying_obsidian.png"),
  BURIED_TREASURE: CHEST,
};

export const SEED_ICON_MC_TYPES = Object.keys(ISO_ART);

// The inventory's projection of one block unit: x runs right-down, z left-down, y straight up.
const C = Math.SQRT1_2;
const S = C * 0.5; // sin 45 * sin 30
const V = Math.sqrt(3) / 2; // cos 30
/** The cube's projected height in block units (the hexagon is 2*8*(2S+V) tall). */
const CUBE_SPAN = 16 * (2 * S + V);
/** The GUI's face shading: top, left, right. */
const SHADE = { top: 1, left: 0.8, right: 0.6 };

const pixelated: CSSProperties = { imageRendering: "pixelated" };

function Face({ m, w, h, crop, shade }: { m: number[]; w: number; h: number; crop: Crop; shade: number }) {
  const sheet = crop.sheet ?? 16;
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
      <div style={{ position: "absolute", inset: 0, transform: crop.flip ? "scaleY(-1)" : undefined }}>
        <Img
          src={staticFile(`minecraft/${crop.src}`)}
          style={{
            ...pixelated,
            position: "absolute",
            left: -(crop.x ?? 0),
            top: -(crop.y ?? 0),
            width: sheet,
            height: sheet,
          }}
        />
      </div>
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
    crop: Crop,
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
    return <Face key={key} m={m} w={w} h={h} crop={crop} shade={shade} />;
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

export const SeedIconMC: FC<{ type: string | null | undefined; size: number; style: SeedIconStyle }> = ({
  type,
  size,
  style,
}) => {
  if (!type || !ISO_ART[type]) return null;
  const box: CSSProperties = { position: "relative", width: size, height: size };
  if (style === "iso") {
    return (
      <div style={box}>
        <Block boxes={ISO_ART[type]} k={(size * 0.96) / CUBE_SPAN} cx={size / 2} cy={size / 2} />
      </div>
    );
  }
  const px = size / 24;
  const art = SLOT_ART[type];
  return (
    <div style={box}>
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

/** The review sheet: both styles, a row each, every type labelled. */
export const SeedIconOptions: FC<{ size: number }> = ({ size }) => {
  const label: CSSProperties = {
    fontFamily: "var(--pixel-font)",
    color: "var(--muted)",
    fontSize: Math.max(12, size / 8),
  };
  return (
    <div
      style={{
        background: "var(--panel)",
        width: "100%",
        height: "100%",
        padding: size / 4,
        display: "flex",
        flexDirection: "column",
        gap: size / 5,
      }}
    >
      {(["slot", "iso"] as const).map((style) => (
        <div key={style}>
          <div style={{ ...label, color: "var(--gold)", marginBottom: size / 10 }}>
            {style === "slot" ? "A · INVENTORY SLOT" : "B · ISOMETRIC BLOCK"}
          </div>
          <div style={{ display: "flex", gap: size / 4 }}>
            {SEED_ICON_MC_TYPES.map((t) => (
              <div key={t} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <SeedIconMC type={t} size={size} style={style} />
                <span style={label}>{t.replace("_", " ")}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
