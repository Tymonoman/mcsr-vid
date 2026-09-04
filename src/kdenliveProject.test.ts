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

// Timeline zero is the world-load thump, so every clip's head that falls before it is trimmed
// away and match start lands at exactly 10s no matter how much sync pre-roll a clip carries.
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
  overlayClips: [preRollClip("overlay", 10)],
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
// An overlay whose own lead-in already equals the thump lead-in needs no trim at all.
assert.match(
  trimmed,
  /<entry in="00:00:00\.000" out="00:10:00\.000" producer="chain_overlay_0"/,
  "an overlay with a 10s lead-in must stay untrimmed at in=0",
);

// THE invariant this whole anchoring exists for: the exported timeline opens on the footage,
// not on minutes of blank. Placement used to be relative to max(all offsets) = the 150s sync
// pre-roll, so the project began 2.5 minutes before the match and every export had to be
// trimmed by hand in Kdenlive before it was publishable.
assert.ok(
  !/<playlist id="playlist4">\s*<blank/.test(trimmed),
  "the left POV track must start at timeline 0, with no leading blank",
);
assert.ok(
  !/<playlist id="playlist6">\s*<blank/.test(trimmed),
  "the right POV track must start at timeline 0, with no leading blank",
);
assert.ok(
  !/<playlist id="playlist8">\s*<blank/.test(trimmed),
  "the overlay track must start at timeline 0, with no leading blank",
);

// A clip whose match offset is *smaller* than the thump lead-in has no footage for the first
// few seconds, so it gets a real (short) blank instead of being dragged back to a negative
// position — which MLT cannot express.
const late = buildKdenliveProject({
  fps: 60,
  width: 1920,
  height: 1080,
  root: "/media",
  leftClip: preRollClip("left", 4),
  rightClip: preRollClip("right", 150),
  overlayClips: [],
  projectName: "Late VOD",
});
assert.match(
  late,
  /<playlist id="playlist4">\s*<blank length="00:00:06\.000"\/>/,
  "a clip starting 4s before the match should sit 6s into the timeline, untrimmed",
);
assert.match(late, /<entry in="00:00:00\.000" out="[^"]*" producer="chain_video_left"/);

// A splits panel changes only a handful of times per match, so it is a sequence of stills on
// ONE track rather than a video or one track per state.
const stills = buildKdenliveProject({
  fps: 60,
  width: 1920,
  height: 1080,
  root: "/media",
  leftClip: preRollClip("left", 150),
  rightClip: preRollClip("right", 150),
  overlayClips: [
    {
      ...preRollClip("splits", 10),
      positionRect: "0 734 1440 346 1",
      stills: [
        { path: "/media/splits-0.png", startSec: 0, durationSec: 30 },
        { path: "/media/splits-1.png", startSec: 30, durationSec: 45 },
        { path: "/media/splits-2.png", startSec: 75, durationSec: 20 },
      ],
    },
  ],
  projectName: "Stills",
});
assert.equal(
  [...stills.matchAll(/<producer id="chain_overlay_0_\d+"/g)].length,
  3,
  "each still segment needs its own qimage producer",
);
assert.equal(
  [...stills.matchAll(/mlt_service">qimage</g)].length,
  3,
  "still segments must all be qimage, not avformat",
);
// Laid end to end on one track: no blank anywhere in the sequence, and each held for its own span.
assert.match(
  stills,
  /<playlist id="playlist8">\s*<entry in="00:00:00\.000" out="00:00:30\.000" producer="chain_overlay_0_0"/,
);
assert.ok(
  !/<playlist id="playlist8">[\s\S]*?<blank/.test(
    stills.slice(stills.indexOf('id="playlist8"'), stills.indexOf('id="playlist9"')),
  ),
  "still segments are contiguous, so the track must contain no blank",
);
for (const [i, dur] of [
  ["0", "00:00:30.000"],
  ["1", "00:00:45.000"],
  ["2", "00:00:20.000"],
] as const) {
  assert.ok(
    stills.includes(`out="${dur}" producer="chain_overlay_0_${i}"`),
    `still ${i} should be held for ${dur}`,
  );
}
// Every still is its own bin clip, with a unique id, or Kdenlive drops the duplicates.
const stillBinIds = [...stills.matchAll(/kdenlive:id">([^<]*)</g)].map((m) => m[1]);
assert.equal(new Set(stillBinIds).size, stillBinIds.length, `duplicate bin ids: ${stillBinIds}`);
for (let j = 0; j < 3; j++) {
  assert.ok(stills.includes(`producer="chain_overlay_0_${j}"/>`), `still ${j} missing from the project bin`);
}

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
