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
console.log("rivalPosts: all checks passed");
