import assert from "node:assert/strict";
import { resolveAvatarUrl } from "./thumbnailProps.js";

const realFetch = globalThis.fetch;

// Starlight Skins reachable: use its pose render.
globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
assert.equal(
  await resolveAvatarUrl("uuid-1", "walking"),
  "https://starlightskins.lunareclipse.studio/render/walking/uuid-1/full",
);

// Starlight Skins down (bad status): fall back to NMSR.
globalThis.fetch = (async () => new Response(null, { status: 502 })) as typeof fetch;
assert.equal(await resolveAvatarUrl("uuid-2", "walking"), "https://nmsr.nickac.dev/fullbody/uuid-2");

// Starlight Skins unreachable (network error/timeout): also falls back.
globalThis.fetch = (async () => {
  throw new Error("network error");
}) as typeof fetch;
assert.equal(await resolveAvatarUrl("uuid-3", "crossed"), "https://nmsr.nickac.dev/fullbody/uuid-3");

globalThis.fetch = realFetch;

console.log("thumbnailProps.resolveAvatarUrl: all checks passed");
