import type { FC } from "react";
import { Img, staticFile } from "remotion";

/**
 * The thumbnail's seed-type icon: remotion/assets/seed-icons/<TYPE>.png, a 1024 px render of the
 * real Minecraft 1.16.1 structure (template, blocks and textures out of the client jar) made by
 * scripts/seed-icons/ (`icons.sh` renders all of them; specs in scripts/seed-icons/scenes/).
 * `<TYPE>-alt.png` beside each is the other projection (iso vs 2d): rename it over <TYPE>.png to
 * swap. The operator's brief, 25 Sept 2026: copy the real structures, complete the portal, keep the
 * buried treasure as it was.
 */

/** The seed types there is an icon for; any other value draws nothing. */
export const SEED_ICON_TYPES = ["VILLAGE", "SHIPWRECK", "DESERT_TEMPLE", "RUINED_PORTAL", "BURIED_TREASURE"];

export const seedIconFile = (type: string, alt = false) => `seed-icons/${type}${alt ? "-alt" : ""}.png`;

/** The icon in its frame: one dark line, a texel of the tile's own scale (2 px at 132, 1 at 64). */
const Tile: FC<{ src: string; size: number }> = ({ src, size }) => {
  const line = Math.max(1, Math.round(size / 64));
  return (
    <div style={{ position: "relative", width: size, height: size, overflow: "hidden" }}>
      {/* Smooth downscale of the 1024 px render; nearest-neighbour would shimmer at 132. */}
      <Img src={staticFile(src)} style={{ width: size, height: size, display: "block" }} />
      <div style={{ position: "absolute", inset: 0, border: `${line}px solid var(--panel-edge, #0d0c10)` }} />
    </div>
  );
};

export const SeedIconMC: FC<{ type: string | null | undefined; size: number }> = ({ type, size }) =>
  type && SEED_ICON_TYPES.includes(type) ? <Tile src={seedIconFile(type)} size={size} /> : null;

/** Review sheet (the `SeedIconSheet` composition): every icon at the thumbnail's 132 px and at
 *  64 px (about what a phone's home feed shows), then the -alt renders the same way. */
export const SeedIconSheet: FC = () => (
  <div style={{ width: "100%", height: "100%", background: "#221f27", padding: 24 }}>
    {[false, true].flatMap((alt) =>
      [132, 64].map((size) => (
        <div
          key={`${alt}${size}`}
          style={{ display: "flex", gap: 24, alignItems: "center", marginBottom: 24 }}
        >
          {SEED_ICON_TYPES.map((type) => (
            <div key={type} style={{ width: 132, display: "flex", justifyContent: "center" }}>
              <Tile src={seedIconFile(type, alt)} size={size} />
            </div>
          ))}
        </div>
      )),
    )}
  </div>
);
