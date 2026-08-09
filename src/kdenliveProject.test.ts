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
  overlayClip: clip("overlay"),
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
  overlayClip: clip("overlay"),
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

console.log("kdenliveProject: all checks passed");
