import assert from "node:assert/strict";
import { LEFT_POV_RECT, RIGHT_POV_RECT } from "../remotion/layout.js";
import { buildKdenliveProject, type KdenliveClipInput } from "./kdenliveProject.js";

const clip = (name: string): KdenliveClipInput => ({
  path: `/media/${name}.mp4`,
  durationSec: 600,
  matchOffsetIntoClipSec: 10,
  clipName: name,
});

const xml = buildKdenliveProject({
  fps: 60,
  width: 1920,
  height: 1080,
  root: "/media",
  leftClip: clip("left"),
  rightClip: clip("right"),
  overlayClips: [clip("overlay")],
  projectName: "Test Match",
});

// Each clip needs a unique kdenlive:id, or Kdenlive's Project Bin collapses/drops entries
// that share an id (this is what silently broke VODs disappearing from the bin before).
const binIds = [...xml.matchAll(/kdenlive:id">([^<]*)</g)].map((m) => m[1]);
assert.equal(binIds.length, 5, `expected 5 clips (audio x2, video x2, overlay), got ${binIds.length}`);
assert.equal(new Set(binIds).size, binIds.length, `duplicate kdenlive:id values found: ${binIds}`);
assert.ok(
  binIds.every((id) => id !== "undefined" && id !== ""),
  `found unset bin id: ${binIds}`,
);

// Markers should serialize onto main_bin as kdenlive:docproperties.guides, one JSON entry per
// input marker.
const xmlWithMarkers = buildKdenliveProject({
  fps: 60,
  width: 1920,
  height: 1080,
  root: "/media",
  leftClip: clip("left"),
  rightClip: clip("right"),
  overlayClips: [clip("overlay")],
  projectName: "Test Match",
  markers: [
    { positionSec: 12.5, comment: "Nether Enter — Alice" },
    { positionSec: 40, comment: "Bastion — Bob" },
  ],
});

const guidesMatch = xmlWithMarkers.match(/kdenlive:docproperties\.guides">([^<]*)</);
assert.ok(guidesMatch, "expected kdenlive:docproperties.guides property to be present");
const guides = JSON.parse(guidesMatch![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
assert.equal(guides.length, 2, `expected 2 guide entries, got ${guides.length}`);
assert.equal(guides[0].pos, Math.round(12.5 * 60));
assert.equal(guides[0].comment, "Nether Enter — Alice");

// A still overlay band needs an image producer, not an avformat chain — MLT renders nothing
// for a PNG pointed at by avformat, so the band would silently vanish from the timeline.
const layered = buildKdenliveProject({
  fps: 60,
  width: 1920,
  height: 1080,
  root: "/media",
  leftClip: clip("left"),
  rightClip: clip("right"),
  overlayClips: [
    { ...clip("top"), path: "/media/top.png", isImage: true, positionRect: "0 0 1920 194 1" },
    { ...clip("splits"), positionRect: "0 734 1920 346 1" },
    clip("intro"),
  ],
  projectName: "Layered",
});

assert.match(layered, /mlt_service">qimage</, "still band should use the qimage producer");
assert.equal(
  [...layered.matchAll(/<producer id="chain_overlay_\d+"/g)].length,
  1,
  "only the image band should be a producer",
);
assert.equal(
  [...layered.matchAll(/<chain id="chain_overlay_\d+"/g)].length,
  2,
  "the two video bands should stay avformat chains",
);
for (const rect of ["0 0 1920 194 1", "0 734 1920 346 1"]) {
  assert.ok(layered.includes(`<property name="rect">${rect}</property>`), `missing rect ${rect}`);
}
// Every band must be a real track and a bin entry, or it just won't show up in Kdenlive.
for (let i = 0; i < 3; i++) {
  assert.ok(
    layered.includes(`<track producer="tractor_video_overlay_${i}"/>`),
    `overlay band ${i} is not on the timeline`,
  );
  assert.ok(layered.includes(`producer="chain_overlay_${i}"/>`), `overlay band ${i} missing from bin`);
}
const layeredBinIds = [...layered.matchAll(/kdenlive:id">([^<]*)</g)].map((m) => m[1]);
assert.equal(
  new Set(layeredBinIds).size,
  layeredBinIds.length,
  `duplicate kdenlive:id across layered clips: ${layeredBinIds}`,
);

// POV clips should be trimmed to start at the world-load thump (matchOffsetIntoClipSec - 10s),
// but overlay clips (short, deliberate lead-in already) must stay untrimmed at in=0.
const preRollClip = (name: string, offsetSec: number): KdenliveClipInput => ({
  ...clip(name),
  matchOffsetIntoClipSec: offsetSec,
});

const trimmed = buildKdenliveProject({
  fps: 60,
  width: 1920,
  height: 1080,
  root: "/media",
  leftClip: preRollClip("left", 150),
  rightClip: preRollClip("right", 120),
  overlayClips: [preRollClip("overlay", 20)],
  projectName: "Trim Test",
});

// left: 150 - 10 = 140s in; right: 120 - 10 = 110s in.
assert.match(
  trimmed,
  /<entry in="00:02:20\.000" out="[^"]*" producer="chain_video_left"/,
  "left POV clip should be trimmed to 00:02:20.000 (150s offset - 10s thump lead-in)",
);
assert.match(
  trimmed,
  /<entry in="00:01:50\.000" out="[^"]*" producer="chain_video_right"/,
  "right POV clip should be trimmed to 00:01:50.000 (120s offset - 10s thump lead-in)",
);
assert.match(
  trimmed,
  /<entry in="00:00:00\.000" out="00:10:00\.000" producer="chain_overlay_0"/,
  "overlay clip must stay untrimmed at in=0",
);

// The project must be portable between machines. The lab generates it with root=/media/<id>
// and the desktop opens the same file; if resources were absolute, every clip would be offline
// on the other box. MLT resolves relative resources against the root attribute.
const portable = buildKdenliveProject({
  fps: 60,
  width: 1920,
  height: 1080,
  root: "/media/12345678",
  leftClip: { ...clip("left"), path: "/media/12345678/left.mp4" },
  rightClip: { ...clip("right"), path: "/media/12345678/right.mp4" },
  overlayClips: [{ ...clip("overlay"), path: "/media/12345678/overlay.mov" }],
  projectName: "Portable Match",
});

assert.match(portable, /<mlt root="\/media\/12345678"/, "root attribute must be emitted");

const resources = [...portable.matchAll(/name="resource">([^<]*)</g)].map((m) => m[1]);
const mediaResources = resources.filter((r) => r !== "black");
assert.deepEqual(
  [...new Set(mediaResources)].sort(),
  ["left.mp4", "overlay.mov", "right.mp4"],
  `resources must be relative to root, got: ${mediaResources}`,
);
assert.ok(
  mediaResources.every((r) => !r.startsWith("/")),
  `no resource may be absolute: ${mediaResources}`,
);

// Relocating the project to another machine is a one-attribute rewrite. Swapping root alone
// must be enough - nothing else in the file may mention the old location.
const relocated = portable.replace('root="/media/12345678"', 'root="/home/tymek/media/12345678"');
assert.ok(
  !relocated.includes("/media/12345678/"),
  "rewriting root alone must relocate the project - no path may survive it",
);
assert.match(relocated, /<mlt root="\/home\/tymek\/media\/12345678"/);

console.log("kdenliveProject: all checks passed");

// The two POV clips must honour their own positionRect. Without this they fall back to a naive
// "half the canvas, full height" box, which letterboxes a 16:9 POV into a 960x1080 slot and
// leaves it overlapping the overlay bands — the layout bug viewers reported.
const posed = buildKdenliveProject({
  fps: 60,
  width: 1920,
  height: 1080,
  root: "/media",
  leftClip: { ...clip("left"), positionRect: LEFT_POV_RECT },
  rightClip: { ...clip("right"), positionRect: RIGHT_POV_RECT },
  overlayClips: [],
  projectName: "Posed",
});
for (const rect of [LEFT_POV_RECT, RIGHT_POV_RECT]) {
  assert.ok(posed.includes(`<property name="rect">${rect}</property>`), `missing POV rect ${rect}`);
}
assert.ok(
  !posed.includes('<property name="rect">0 0 960 1080 1</property>'),
  "POV must not use the full-height fallback when a rect is given",
);

// Omitting them keeps the old full-height split, so the builder stays usable standalone.
const bare = buildKdenliveProject({
  fps: 60,
  width: 1920,
  height: 1080,
  root: "/media",
  leftClip: clip("left"),
  rightClip: clip("right"),
  overlayClips: [],
  projectName: "Bare",
});
assert.ok(bare.includes('<property name="rect">0 0 960 1080 1</property>'));
