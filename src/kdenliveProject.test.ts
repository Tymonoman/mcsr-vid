import assert from "node:assert/strict";
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
  leftClip: clip("left"),
  rightClip: clip("right"),
  overlayClips: [clip("overlay")],
  projectName: "Test Match",
  markers: [
    { positionSec: 12.5, comment: "Nether Enter — Alice" },
    { positionSec: 40, comment: "Bastion — Bob" },
  ],
});

const guidesMatch = xmlWithMarkers.match(
  /kdenlive:docproperties\.guides">([^<]*)</,
);
assert.ok(guidesMatch, "expected kdenlive:docproperties.guides property to be present");
const guides = JSON.parse(
  guidesMatch![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
);
assert.equal(guides.length, 2, `expected 2 guide entries, got ${guides.length}`);
assert.equal(guides[0].pos, Math.round(12.5 * 60));
assert.equal(guides[0].comment, "Nether Enter — Alice");

// A still overlay band needs an image producer, not an avformat chain — MLT renders nothing
// for a PNG pointed at by avformat, so the band would silently vanish from the timeline.
const layered = buildKdenliveProject({
  fps: 60,
  width: 1920,
  height: 1080,
  leftClip: clip("left"),
  rightClip: clip("right"),
  overlayClips: [
    { ...clip("top"), path: "/media/top.png", isImage: true, positionRect: "0 0 1920 210 1" },
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
for (const rect of ["0 0 1920 210 1", "0 734 1920 346 1"]) {
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

console.log("kdenliveProject: all checks passed");
