import assert from "node:assert/strict";
import { planScene, type BakedFace, type BakedScene } from "./SeedScene.js";

// One unit cube, its six faces as bake.py writes them (corners carrying uv (0,0), (16,0), (0,16)).
const face = (p: number[][], n: number[], c = [0, 0, 0]): BakedFace => ({
  t: 0,
  p: p.map((q) => q.map((v, i) => v + c[i])) as BakedFace["p"],
  uv: [0, 0, 16, 16],
  n,
  c,
  o: c.map((v) => v + 0.5),
});
const cube = (c = [0, 0, 0]) => [
  face([[0, 1, 0], [1, 1, 0], [0, 1, 1]], [0, 1, 0], c),
  face([[0, 0, 1], [1, 0, 1], [0, 0, 0]], [0, -1, 0], c),
  face([[0, 1, 1], [1, 1, 1], [0, 0, 1]], [0, 0, 1], c),
  face([[1, 1, 0], [0, 1, 0], [1, 0, 0]], [0, 0, -1], c),
  face([[1, 1, 1], [1, 1, 0], [1, 0, 1]], [1, 0, 0], c),
  face([[0, 1, 0], [0, 1, 1], [0, 0, 0]], [-1, 0, 0], c),
];
const scene = (view: BakedScene["view"], faces = cube()): BakedScene => ({ textures: [{ src: "x.png", uv: 16 }], faces, view });
const seen = (s: BakedScene) => planScene(s, 1024).faces.map(({ f, shade }) => `${f.n.join(",")}:${shade}`);

// iso from the southeast: top, south on the left (0.8), east on the right (0.6), as the wiki renders light it.
assert.deepEqual(seen(scene({})).sort(), ["0,0,1:0.8", "0,1,0:1", "1,0,0:0.6"]);
// Turned to the northwest, north takes the left-hand light and west the right.
assert.deepEqual(seen(scene({ facing: "northwest" })).sort(), ["-1,0,0:0.6", "0,0,-1:0.8", "0,1,0:1"]);
// 2d looks straight at one side, unshaded by default.
assert.deepEqual(seen(scene({ projection: "2d", facing: "east" })), ["1,0,0:1"]);

// Auto-fit: the cube fills the square inside the padding, centred.
const plan = planScene(scene({ padding: 0.1 }), 1000);
const xs = plan.faces.flatMap(({ pts }) => [...pts.map((p) => p[0]), pts[1][0] + pts[2][0] - pts[0][0]]);
const ys = plan.faces.flatMap(({ pts }) => [...pts.map((p) => p[1]), pts[1][1] + pts[2][1] - pts[0][1]]);
const [w, h] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
assert.ok(Math.abs(Math.max(w, h) - 800) < 1e-6, `fit ${w}x${h}`);
assert.ok(Math.abs(Math.min(...xs) + Math.max(...xs) - 1000) < 1e-6);

// Painter's order: of two cubes one in front of the other, the nearer one's faces come last.
const two = planScene(scene({}, [...cube([1, 0, 1]), ...cube([0, 0, 0])]), 512).faces.map(({ f }) => f.c.join(","));
assert.deepEqual(two, ["0,0,0", "0,0,0", "0,0,0", "1,0,1", "1,0,1", "1,0,1"]);

// Overhang: a cube with a lintel above the cell in front of its south face sits in shadow; the
// lintel itself, and depth shade stopping at depthShadeMin, are the rest of a 2d doorway.
const door = scene({ projection: "2d", overhangShade: 0.5, depthShade: 0.5, depthShadeMin: 0.8 }, [...cube([0, 0, 0]), ...cube([0, 1, 1])]);
assert.deepEqual(seen(door), ["0,0,1:0.4", "0,0,1:1"]);

console.log("SeedScene: ok");
