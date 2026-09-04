import assert from "node:assert/strict";
import { computeThumbnailProps, resolveAvatarUrl } from "./thumbnailProps.js";
import type { MatchInfo, UserDetails } from "./types.js";

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

// The thumbnail must show the rating each player carried INTO the match, not their rating now.
// The overlay and the description were fixed for this; the thumbnail kept showing the live value,
// so the same match rendered a different elo depending on which artefact you looked at.
globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
{
  const match = {
    tag: null,
    changes: [
      { uuid: "u-left", eloRate: 2615, change: 69 },
      { uuid: "u-right", eloRate: 2370, change: -12 },
    ],
  } as unknown as MatchInfo;
  const user = (uuid: string, nickname: string, liveElo: number) =>
    ({ uuid, nickname, eloRate: liveElo }) as unknown as UserDetails;

  const props = await computeThumbnailProps(
    match,
    user("u-left", "edcr", 2615),
    user("u-right", "doogile", 2370),
  );
  assert.equal(props.props.left.eloRate, 2546, "2615 post-match minus the +69 that match produced");
  assert.equal(props.props.right.eloRate, 2382, "2370 post-match minus the -12 that match produced");
  assert.equal(
    props.props.headerLabel,
    "Minecraft · Speedrunning · Ranked",
    "null tag uses the default",
  );
}

globalThis.fetch = realFetch;

console.log("thumbnailProps: all checks passed");
