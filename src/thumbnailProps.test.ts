import assert from "node:assert/strict";
import { computeThumbnailProps, resolveAvatarUrl } from "./thumbnailProps.js";
import { KNOWN_POSES } from "./avatarUrl.js";
import type { MatchInfo, UserDetails } from "./types.js";

const realFetch = globalThis.fetch;

// Every configured pose resolves to its own NMSR camera, so the three variants are three
// different silhouettes. When this regressed (Starlight Skins going down), all three were the
// same image and the CTR table was comparing a variable that never varied.
{
  const walking = await resolveAvatarUrl("uuid-1", "walking");
  const crossed = await resolveAvatarUrl("uuid-1", "crossed");
  assert.equal(walking.provider, "nmsr-posed");
  assert.equal(walking.pose, "walking");
  assert.ok(walking.url.startsWith("https://nmsr.nickac.dev/fullbody/uuid-1?"), walking.url);
  assert.notEqual(walking.url, crossed.url, "two poses must not resolve to the same render");

  const urls = new Set(
    await Promise.all(KNOWN_POSES.map(async (pose) => (await resolveAvatarUrl("u", pose)).url)),
  );
  assert.equal(urls.size, KNOWN_POSES.length, "every known pose needs its own camera");
}

// An unconfigured pose must say so rather than quietly returning the default view under a name
// that implies it was honoured.
assert.deepEqual(await resolveAvatarUrl("uuid-2", "moonwalking"), {
  url: "https://nmsr.nickac.dev/fullbody/uuid-2",
  provider: "nmsr",
  pose: "moonwalking",
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
  assert.equal(props.props.headerLabel, "Minecraft · Speedrunning · Ranked", "null tag uses the default");
}

globalThis.fetch = realFetch;

console.log("thumbnailProps: all checks passed");
