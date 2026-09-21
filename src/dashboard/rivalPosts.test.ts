import assert from "node:assert/strict";
import { normaliseNick, playersFromTitle, rivalMatchFor, type RivalPost } from "./rivalPosts.js";

// Both grammars the rival has used, and the nickname spellings that differ from the API's.
assert.deepEqual(playersFromTitle("SUB 7 | Feinberg vs Aquacorde |  MCSR Ranked | Minecraft Speedrun"), [
  "feinberg",
  "aquacorde",
]);
assert.deepEqual(playersFromTitle("TOUGH MATCH | Aquacorde vs Nahhann | MCSR Ranked | Minecraft Speedrun"), [
  "aquacorde",
  "nahhann",
]);
assert.deepEqual(playersFromTitle("Edcr vs Doogile MCSR Ranked Minecraft Speedrun"), ["edcr", "doogile"]);
assert.equal(
  playersFromTitle("10K Couriway NRI Seed 1 completions feinberg edcr doogile infume"),
  null,
  "no matchup, no players",
);
assert.equal(normaliseNick("lowk3y_"), "lowk3y");
assert.equal(
  normaliseNick("Lowk3y"),
  "lowk3y",
  "the rival's capitalisation and our underscore meet in the middle",
);

const day = 86_400_000;
const matchAt = Date.UTC(2026, 8, 6, 20); // 6 Sept 20:00
const posts: RivalPost[] = [
  {
    title: "TOUGH MATCH | Aquacorde vs Nahhann | MCSR Ranked",
    publishedAtMs: matchAt + day,
    players: ["aquacorde", "nahhann"],
  },
  {
    title: "Old | nahhann vs Aquacorde | MCSR Ranked",
    publishedAtMs: matchAt - 20 * day,
    players: ["nahhann", "aquacorde"],
  },
  { title: "Something else", publishedAtMs: matchAt + day, players: null },
];
// Either seating, any case, inside the window after the match.
const hit = rivalMatchFor(posts, ["nahhann", "Aquacorde"], matchAt / 1000);
assert.equal(hit?.title, "TOUGH MATCH | Aquacorde vs Nahhann | MCSR Ranked");
// A post from before the match is a different match between the same two.
assert.equal(
  rivalMatchFor(posts, ["nahhann", "Aquacorde"], (matchAt + 5 * day) / 1000)?.title,
  undefined,
  "a post before the match does not count",
);
// Too long after: the rival posts daily, so a post twelve days later is another match.
assert.equal(rivalMatchFor(posts, ["nahhann", "Aquacorde"], (matchAt - 12 * day) / 1000), null);
assert.equal(rivalMatchFor(posts, ["Infume", "BeefSalad"], matchAt / 1000), null, "not posted: nothing");

// Two matches of one pair in one night: the video's length says which one was posted. Measured
// on the rival: 8:59 for an 8:48 run. A post of the wrong length is the other match, not this
// one, and must not demote this one; without lengths the old pair-and-window rule stands.
{
  const { isoDurationSec } = await import("./rivalPosts.js");
  assert.equal(isoDurationSec("PT8M59S"), 539);
  assert.equal(isoDurationSec("PT1H2M3S"), 3723);
  assert.equal(isoDurationSec("nonsense"), 0);
  const timed: RivalPost[] = [{ ...posts[0]!, durationSec: 539 }];
  assert.equal(
    rivalMatchFor(timed, ["Aquacorde", "nahhann"], matchAt / 1000, 528)?.title,
    posts[0]!.title,
    "8:48 run, 8:59 video: this one",
  );
  assert.equal(
    rivalMatchFor(timed, ["Aquacorde", "nahhann"], matchAt / 1000, 494),
    null,
    "8:13 run, 8:59 video: a different match of the pair",
  );
  assert.equal(
    rivalMatchFor(timed, ["Aquacorde", "nahhann"], matchAt / 1000, 582),
    null,
    "9:42 run: too long for the video",
  );
  assert.equal(
    rivalMatchFor(posts, ["Aquacorde", "nahhann"], matchAt / 1000, 494)?.title,
    posts[0]!.title,
    "no length on the post: the pair-and-window rule as before",
  );
  assert.equal(
    rivalMatchFor(timed, ["Aquacorde", "nahhann"], matchAt / 1000)?.title,
    posts[0]!.title,
    "no run time given: as before",
  );
  console.log("OK: a post's length tells two matches of one pair apart");
}
// The shelf has nicknames but no match date: the most recent post of the pair in the last two weeks.
{
  const { rivalRecentPostFor } = await import("./rivalPosts.js");
  const now = Date.UTC(2026, 8, 8, 4);
  const shelfPosts: RivalPost[] = [
    { title: "old", publishedAtMs: now - 30 * day, players: ["aquacorde", "nahhann"] },
    {
      title: "TOUGH MATCH | Aquacorde vs Nahhann",
      publishedAtMs: now - 1 * day,
      players: ["aquacorde", "nahhann"],
    },
    {
      title: "earlier | nahhann vs Aquacorde",
      publishedAtMs: now - 5 * day,
      players: ["nahhann", "aquacorde"],
    },
  ];
  assert.equal(
    rivalRecentPostFor(shelfPosts, ["nahhann", "Aquacorde"], now)?.title,
    "TOUGH MATCH | Aquacorde vs Nahhann",
    "the most recent within two weeks",
  );
  assert.equal(rivalRecentPostFor(shelfPosts, ["Infume", "BeefSalad"], now), null);
  assert.equal(
    rivalRecentPostFor(shelfPosts, ["nahhann", "Aquacorde"], now, 0.5),
    null,
    "outside the window is nothing",
  );
}
console.log("rivalPosts: all checks passed");
