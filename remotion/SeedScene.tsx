import { useLayoutEffect, useRef, useState, type FC } from "react";
import { continueRender, delayRender, staticFile } from "remotion";

/**
 * Draws a scene baked by scripts/seed-icons/bake.py: every face of a Minecraft structure, resolved
 * through the 1.16.1 jar's blockstates and models, as a textured parallelogram. Under an
 * orthographic camera a planar face is an affine image of its texture rectangle, so each face is one
 * canvas setTransform + drawImage (the CSS matrix() of the face), nearest-neighbour, back to front.
 * Canvas rather than a div per face so the tint (grass, leaves, water) and the face shading are
 * multiplied into the texels themselves: a shade layer over a div would darken a torch's or a
 * flower's transparent pixels too.
 */

export interface BakedFace {
  /** Index into `textures`. */
  t: number;
  /** Corners in blocks: the ones that carry texture (u0,v0), (u1,v0) and (u0,v1). */
  p: [number[], number[], number[]];
  /** u0, v0, u1, v1 in the texture's UV units (a flipped rect mirrors). */
  uv: number[];
  /** Outward normal. */
  n: number[];
  /** Never shaded (a model element with shade:false: torches, flowers, crosses). */
  flat?: 1;
  /** The block's cell and the element's centre, for the painter's order. */
  c: number[];
  o: number[];
  tint?: string;
  /** Emissive: never shaded. */
  g?: 1;
}

export interface SceneView {
  /** "iso": the inventory / wiki-render angle; "2d": straight at one side. */
  projection?: "iso" | "2d";
  /** iso: the corner the camera looks from (southeast shows south on the left, east on the right);
   *  2d: the side it looks at. */
  facing?: "southeast" | "southwest" | "northwest" | "northeast" | "south" | "north" | "east" | "west";
  size?: number;
  /** Empty margin around the auto-fitted scene, a fraction of the size per side. */
  padding?: number;
  /** Past 1 crops the scene's edges. */
  zoom?: number;
  /** The world point (blocks) put at the centre of the square; the scene's middle when left out. */
  center?: number[];
  /** A last shift, a fraction of the size ([0.1, 0] moves the scene right by a tenth). */
  offset?: number[];
  /** Apply Minecraft's face shading (default on in iso, off in 2d). */
  faceShade?: boolean;
  /** 2d: darken a face by this much per block it sits behind the frontmost face (floor 0.35). */
  depthShade?: number;
  /** The darkest depthShade may take a face to (default 0.35). */
  depthShadeMin?: number;
  /** Multiply a side face by this when any block sits above the cell in front of it — a doorway, a
   *  recess under a lintel, a tunnel — the shadow the sky-lit game shows there. Off when left out. */
  overhangShade?: number;
  /** Screen pixels each face is grown by so neighbours overlap instead of leaving a seam. */
  seam?: number;
}

export type BakedScene = {
  name?: string;
  view?: SceneView;
  /** "none", a preset (sky, sea, nether) or any CSS background. */
  background?: string;
  textures: { src: string; uv: number }[];
  faces: BakedFace[];
};

export const SCENE_BACKGROUNDS: Record<string, string> = {
  none: "transparent",
  sky: "linear-gradient(#5d9cf0, #b9d8ff)",
  sea: "linear-gradient(#2d5fb8, #183a80)",
  nether: "linear-gradient(#2a1633, #120a14)",
};

type V3 = number[];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The turn about the vertical that brings the camera round to +x+z (iso) or +z (2d). */
const TURN: Record<string, (x: number, z: number) => [number, number]> = {
  southeast: (x, z) => [x, z],
  south: (x, z) => [x, z],
  southwest: (x, z) => [z, -x],
  west: (x, z) => [z, -x],
  northwest: (x, z) => [-x, -z],
  north: (x, z) => [-x, -z],
  northeast: (x, z) => [-z, x],
  east: (x, z) => [-z, x],
};

const C = Math.SQRT1_2;
const S = C * 0.5; // sin 45 * sin 30
const V = Math.sqrt(3) / 2; // cos 30
/** Screen right, screen up and towards-the-camera vectors per projection. */
const CAMERA = {
  iso: { r: [C, 0, -C], u: [-S, V, -S], w: [C * V, 0.5, C * V] },
  "2d": { r: [1, 0, 0], u: [0, 1, 0], w: [0, 0, 1] },
};

/** Minecraft's face shading, by where the face points on screen as the wiki renders light it: up 1,
 *  down 0.5, the left-hand side (view +z) 0.8, the right-hand side (view +x) 0.6. */
function shadeOf([x, y, z]: V3): number {
  const [ax, ay, az] = [Math.abs(x), Math.abs(y), Math.abs(z)];
  if (ay >= ax && ay >= az) return y > 0 ? 1 : 0.5;
  return az >= ax ? 0.8 : 0.6;
}

export interface Plan {
  k: number;
  ox: number;
  oy: number;
  faces: { f: BakedFace; pts: [number, number][]; shade: number }[];
}

/** Where every visible face lands on a square of `size` px, back to front. Pure, for the test. */
export function planScene(scene: BakedScene, size: number): Plan {
  const view = scene.view ?? {};
  const proj = view.projection ?? "iso";
  const cam = CAMERA[proj];
  const turn = TURN[view.facing ?? (proj === "iso" ? "southeast" : "south")];
  const R = (p: V3): V3 => {
    const [x, z] = turn(p[0], p[2]);
    return [x, p[1], z];
  };
  const P = (p: V3): [number, number] => {
    const q = R(p);
    return [dot(q, cam.r), -dot(q, cam.u)];
  };
  const faceShade = view.faceShade ?? proj === "iso";
  const visible = scene.faces
    .map((f, i) => ({ f, i, n: R(f.n) }))
    .filter(({ n }) => dot(n, cam.w) > 1e-6)
    .map(({ f, i }) => ({
      f,
      i,
      cell: dot(R([f.c[0] + 0.5, f.c[1] + 0.5, f.c[2] + 0.5]), cam.w),
      el: dot(R(f.o), cam.w),
      pts: f.p.map(P),
    }))
    .sort((a, b) => a.cell - b.cell || a.el - b.el || a.i - b.i);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { pts } of visible)
    for (const [px, py] of [...pts, [pts[1][0] + pts[2][0] - pts[0][0], pts[1][1] + pts[2][1] - pts[0][1]]]) {
      [x0, y0, x1, y1] = [Math.min(x0, px), Math.min(y0, py), Math.max(x1, px), Math.max(y1, py)];
    }
  if (!visible.length) [x0, y0, x1, y1] = [0, 0, 1, 1];
  const room = size * (1 - 2 * (view.padding ?? 0.06));
  const k = (view.zoom ?? 1) * Math.min(room / (x1 - x0 || 1), room / (y1 - y0 || 1));
  const [fx, fy] = view.center ? P(view.center) : [(x0 + x1) / 2, (y0 + y1) / 2];
  const [dx, dy] = view.offset ?? [0, 0];
  const ox = size / 2 - k * fx + dx * size;
  const oy = size / 2 - k * fy + dy * size;
  const front = Math.max(...visible.map(({ f }) => dot(R(f.o), cam.w)));
  const filled = new Set(scene.faces.map(({ c }) => c.join(",")));
  // ponytail: looks 32 blocks up the front column; enough for any structure template here.
  const covered = ({ c, n }: BakedFace) =>
    n[1] === 0 &&
    Array.from({ length: 32 }, (_, k) => `${c[0] + n[0]},${c[1] + 1 + k},${c[2] + n[2]}`).some((key) => filled.has(key));
  return {
    k,
    ox,
    oy,
    faces: visible.map(({ f, pts }) => {
      let shade = f.g || f.flat || !faceShade ? 1 : shadeOf(R(f.n));
      if (view.depthShade && !f.g)
        shade *= Math.max(view.depthShadeMin ?? 0.35, 1 - view.depthShade * (front - dot(R(f.o), cam.w)));
      if (view.overhangShade && !f.g && covered(f)) shade *= view.overhangShade;
      return { f, pts: pts.map(([x, y]) => [ox + k * x, oy + k * y] as [number, number]), shade };
    }),
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`texture ${src} did not load`));
    img.src = staticFile(src);
  });
}

/** The texture's first frame (an animated strip is frames stacked down), tinted and shaded texel by
 *  texel the way the game multiplies them; `glassy` when it has half-transparent texels (water,
 *  stained glass), which must not overlap their neighbours or the overlap shows as a grid. */
function prepared(img: HTMLImageElement, tint: string | undefined, shade: number) {
  const w = img.naturalWidth;
  const h = Math.min(img.naturalHeight, w);
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const t = tint ? [1, 3, 5].map((i) => parseInt(tint.slice(i, i + 2), 16) / 255) : [1, 1, 1];
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  let glassy = false;
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] * t[c] * shade);
    if (px[i + 3] > 0 && px[i + 3] < 255) glassy = true;
  }
  ctx.putImageData(data, 0, 0);
  return { cv, glassy };
}

async function draw(canvas: HTMLCanvasElement, scene: BakedScene, size: number) {
  const imgs = await Promise.all(scene.textures.map((t) => loadImage(t.src)));
  const plan = planScene(scene, size);
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = false;
  const cache = new Map<string, ReturnType<typeof prepared>>();
  const seam = scene.view?.seam ?? 0.5;
  for (const { f, pts, shade } of plan.faces) {
    const [u0, v0, u1, v1] = f.uv;
    if (u0 === u1 || v0 === v1) continue;
    const key = `${f.t}|${f.tint ?? ""}|${Math.round(shade * 256)}`;
    let src = cache.get(key);
    if (!src) cache.set(key, (src = prepared(imgs[f.t], f.tint, Math.round(shade * 256) / 256)));
    const scale = imgs[f.t].naturalWidth / scene.textures[f.t].uv; // texels per UV unit
    // Local drawing space is the UV rectangle, [umin, umax] x [vmin, vmax] shifted to 0.
    const [p0, p1, p2] = pts;
    const A = [(p1[0] - p0[0]) / (u1 - u0), (p1[1] - p0[1]) / (u1 - u0)];
    const B = [(p2[0] - p0[0]) / (v1 - v0), (p2[1] - p0[1]) / (v1 - v0)];
    const um = Math.min(u0, u1);
    const vm = Math.min(v0, v1);
    const W = Math.abs(u1 - u0);
    const H = Math.abs(v1 - v0);
    const tx = p0[0] + (um - u0) * A[0] + (vm - v0) * B[0];
    const ty = p0[1] + (um - u0) * A[1] + (vm - v0) * B[1];
    const grow = src.glassy ? seam * 0.4 : seam;
    const ea = grow / (Math.hypot(A[0], A[1]) || 1);
    const eb = grow / (Math.hypot(B[0], B[1]) || 1);
    ctx.setTransform(A[0], A[1], B[0], B[1], tx, ty);
    ctx.drawImage(src.cv, um * scale, vm * scale, W * scale, H * scale, -ea, -eb, W + 2 * ea, H + 2 * eb);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** A baked scene on a square canvas of `size` px, over its background. */
export const SeedScene: FC<{ scene: BakedScene; size: number }> = ({ scene, size }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const [handle] = useState(() => delayRender(`seed scene ${scene.name ?? ""}`));
  useLayoutEffect(() => {
    draw(ref.current!, scene, size).then(
      () => continueRender(handle),
      (e) => {
        throw e;
      },
    );
  }, [scene, size, handle]);
  const bg = scene.background ?? "none";
  return (
    <div style={{ width: size, height: size, background: SCENE_BACKGROUNDS[bg] ?? bg }}>
      <canvas ref={ref} width={size} height={size} style={{ display: "block" }} />
    </div>
  );
};

/** The `SeedIconScene` composition: props are a baked scene (scripts/seed-icons/render.sh). */
export const SeedIconScene: FC<BakedScene> = (scene) => (
  <SeedScene scene={scene} size={scene.view?.size ?? 1024} />
);
