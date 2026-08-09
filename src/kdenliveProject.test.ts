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

console.log("kdenliveProject: all checks passed");
