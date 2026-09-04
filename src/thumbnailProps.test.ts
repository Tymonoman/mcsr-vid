import assert from "node:assert/strict";
import { resolveAvatarUrl } from "./thumbnailProps.js";

const realFetch = globalThis.fetch;

// Starlight Skins reachable: use its pose render.
globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
assert.deepEqual(await resolveAvatarUrl("uuid-1", "walking"), {
  url: "https://starlightskins.lunareclipse.studio/render/walking/uuid-1/full",
  provider: "starlight",
  pose: "walking",
});

// Starlight Skins down (bad status): fall back to NMSR.
globalThis.fetch = (async () => new Response(null, { status: 502 })) as typeof fetch;
// provider "nmsr" is what tells a caller the pose was NOT honoured -- without it, three
// "different pose" variants during a Starlight outage are three identical images.
assert.deepEqual(await resolveAvatarUrl("uuid-2", "walking"), {
  url: "https://nmsr.nickac.dev/fullbody/uuid-2",
  provider: "nmsr",
  pose: "walking",
});

// Starlight Skins unreachable (network error/timeout): also falls back.
globalThis.fetch = (async () => {
  throw new Error("network error");
}) as typeof fetch;
assert.deepEqual(await resolveAvatarUrl("uuid-3", "crossed"), {
  url: "https://nmsr.nickac.dev/fullbody/uuid-3",
  provider: "nmsr",
  pose: "crossed",
});

globalThis.fetch = realFetch;

console.log("thumbnailProps.resolveAvatarUrl: all checks passed");
