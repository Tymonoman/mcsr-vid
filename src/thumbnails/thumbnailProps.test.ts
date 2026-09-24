import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeThumbnailProps, RIGHT_RENDER_SIDE } from "./thumbnailProps.js";
import { FACING_YAW, KNOWN_POSES, resolveAvatarUrl } from "../api/avatarUrl.js";
import type { MatchInfo, UserDetails } from "../api/types.js";

const realFetch = globalThis.fetch;
const params = (url: string) => new URL(url).searchParams;

// Every configured pose resolves to its own NMSR camera, so the variants are different
// silhouettes; without that the CTR table compares a variable that never varied.
{
  const walking = await resolveAvatarUrl("uuid-1", "walking", "left");
  const crossed = await resolveAvatarUrl("uuid-1", "crossed", "left");
  assert.equal(walking.provider, "nmsr-facing", "not nmsr-posed: that key drew both players facing left");
  assert.equal(walking.pose, "walking");
  assert.ok(walking.url.startsWith("https://nmsr.nickac.dev/fullbody/uuid-1?"), walking.url);
  assert.notEqual(walking.url, crossed.url, "two poses must not resolve to the same render");

  for (const side of ["left", "right"] as const) {
    const urls = new Set(
      await Promise.all(KNOWN_POSES.map(async (pose) => (await resolveAvatarUrl("u", pose, side)).url)),
    );
    assert.equal(urls.size, KNOWN_POSES.length, `every known pose needs its own camera (${side})`);
  }
}

// Each player turns toward the other: the left render faces the right of its PNG (positive yaw),
// the right render the left. A pose changes the arms, never the direction: the operator's ask
// (24 Sept 2026) was the two facing each other on every variant.
for (const pose of KNOWN_POSES) {
  const left = params((await resolveAvatarUrl("u", pose, "left")).url);
  const right = params((await resolveAvatarUrl("u", pose, "right")).url);
  assert.equal(left.get("yaw"), String(FACING_YAW), `${pose} on the left turns right`);
  assert.equal(right.get("yaw"), String(-FACING_YAW), `${pose} on the right turns left`);
  assert.equal(left.get("arms"), right.get("arms"), `${pose}: same arms on both sides`);
  // Slim or classic arms are NMSR's own reading of the Mojang profile (it matched the profile on
  // every player checked, 24 Sept 2026); forcing ?alex or ?steve would draw half the ladder wrong.
  assert.ok(!left.has("alex") && !left.has("steve"), `${pose} must not force a skin model`);
}
assert.ok(FACING_YAW > 0 && FACING_YAW <= 30, "slightly: a turn, not a profile view");

// An unconfigured pose must say so rather than quietly returning the default view under a name
// that implies it was honoured.
assert.deepEqual(await resolveAvatarUrl("uuid-2", "moonwalking", "left"), {
  url: "https://nmsr.nickac.dev/fullbody/uuid-2",
  provider: "nmsr",
  pose: "moonwalking",
});

// The thumbnail mirrors the right player's image in CSS, so that render must be asked for with
// the left side's camera; once the mirror is gone, with the right side's. The wrong way round,
// both players face away from each other.
{
  const css = readFileSync(new URL("../../remotion/overlay.source.css", import.meta.url), "utf8");
  const mirrored = /\.thumb-player\.right img\s*\{[^}]*scaleX\(-1\)/.test(css);
  assert.equal(
    RIGHT_RENDER_SIDE,
    mirrored ? "left" : "right",
    "RIGHT_RENDER_SIDE must follow the CSS mirror",
  );
}

// The thumbnail must show the rating each player carried INTO the match, not their rating now.
// The overlay and the description were fixed for this; the thumbnail kept showing the live value,
// so the same match rendered a different elo depending on which artefact you looked at.
globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
{
  const match = {
    tag: null,
    seedType: "VILLAGE",
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
  assert.equal(props.props.seedType, "VILLAGE", "the centre slot shows the match's seed type");
  assert.equal(params(props.leftAvatar.url).get("yaw"), String(FACING_YAW), "left player turns right");
  assert.equal(
    props.rightAvatar.url,
    (await resolveAvatarUrl("u-right", props.rightAvatar.pose, RIGHT_RENDER_SIDE)).url,
    "right player asked for with the camera that faces left once drawn",
  );
}

globalThis.fetch = realFetch;

console.log("thumbnailProps: all checks passed");
