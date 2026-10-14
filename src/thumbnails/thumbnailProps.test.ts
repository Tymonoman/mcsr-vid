import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeThumbnailProps, RIGHT_RENDER_SIDE, withInlineAvatars } from "./thumbnailProps.js";
import { FACING_YAW, inlineAvatar, KNOWN_POSES, resolveAvatarUrl } from "../api/avatarUrl.js";
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
const png = () =>
  new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });

// The render never waits on NMSR (14 Oct 2026: one slow fullbody answer timed the thumbnail stage
// out). A hung try is cut off and asked again; the image reaches the props as a data: URL.
{
  let calls = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls++;
    if (calls > 1) return png();
    // A real hung fetch holds a socket open; this timer stands in for it (the timeout's own is unref'd).
    const socket = setTimeout(() => {}, 10_000);
    const signal = init!.signal!;
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => (clearTimeout(socket), reject(signal.reason))),
    );
  }) as typeof fetch;
  assert.equal(await inlineAvatar("https://nmsr.nickac.dev/head/u", 50), "data:image/png;base64,iVBORw==");
  assert.equal(calls, 2, "the hung try was given up on and asked again");

  // Every try failing hands the render the URL: the browser's one chance, as before.
  calls = 0;
  globalThis.fetch = (async () => (calls++, new Response("busy", { status: 503 }))) as typeof fetch;
  assert.equal(await inlineAvatar("https://nmsr.nickac.dev/head/u", 50), "https://nmsr.nickac.dev/head/u");
  assert.equal(calls, 3);
}

globalThis.fetch = (async (url: string) =>
  url.startsWith("https://nmsr.nickac.dev/") ? png() : new Response(null, { status: 200 })) as typeof fetch;
{
  const match = {
    tag: null,
    seedType: "VILLAGE",
    changes: [
      { uuid: "u-left", eloRate: 2546, change: 69 },
      { uuid: "u-right", eloRate: 2382, change: -12 },
    ],
  } as unknown as MatchInfo;
  const user = (uuid: string, nickname: string, liveElo: number) =>
    ({ uuid, nickname, eloRate: liveElo }) as unknown as UserDetails;

  const props = await computeThumbnailProps(
    match,
    user("u-left", "edcr", 2615),
    user("u-right", "doogile", 2370),
  );
  assert.equal(props.props.left.eloRate, 2546, "the rating carried in (changes[].eloRate), not the live 2615");
  assert.equal(props.props.right.eloRate, 2382, "the rating carried in (changes[].eloRate), not the live 2370");
  assert.equal(props.props.headerLabel, "Minecraft · Speedrunning · Ranked", "null tag uses the default");
  assert.equal(props.props.seedType, "VILLAGE", "the centre slot shows the match's seed type");
  assert.equal(params(props.leftAvatar.url).get("yaw"), String(FACING_YAW), "left player turns right");
  // The props keep the URL (a reused still needs no image); the still about to be drawn gets the image.
  assert.equal(props.props.left.avatarUrl, props.leftAvatar.url);
  const drawn = await withInlineAvatars(props.props);
  assert.equal(
    drawn.left.avatarUrl,
    "data:image/png;base64,iVBORw==",
    "the render gets the image, not a URL",
  );
  assert.equal(drawn.right.avatarUrl, "data:image/png;base64,iVBORw==");
  assert.equal(drawn.left.nickname, "edcr");
  assert.equal(
    props.rightAvatar.url,
    (await resolveAvatarUrl("u-right", props.rightAvatar.pose, RIGHT_RENDER_SIDE)).url,
    "right player asked for with the camera that faces left once drawn",
  );
}

globalThis.fetch = realFetch;

console.log("thumbnailProps: all checks passed");
