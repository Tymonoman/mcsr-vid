import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// The rival's real titles, one per shape (yt-dlp on @mcsrmatches, 30 Sept 2026). The hook-less
// `A vs B | MCSR Ranked | …` (10 of its newest 15 uploads) and a nickname with a space in it parsed
// to null, so the badge and the nightly's order never saw those posts. "(made up)" is a shape it
// has not posted yet.
{
  const shapes: [string, string, [string, string] | null][] = [
    ["no hook", "Anjouu vs Skycrab | MCSR Ranked | Minecraft Speedrun", ["anjouu", "skycrab"]],
    [
      "no hook, v_strid typed Vstrid",
      "Doogile vs Vstrid | MCSR Ranked | Minecraft Speedrun",
      ["doogile", "vstrid"],
    ],
    [
      "emoji against the pipe",
      "SO FAST! 🤯| Infume vs Silverrruns | MCSR Ranked | Minecraft Speedrun",
      ["infume", "silverrruns"],
    ],
    [
      "two spaces after the pipe",
      "What a Crazy Seed😮 |  Edcr vs Pinne | MCSR Ranked | Minecraft Speedrun",
      ["edcr", "pinne"],
    ],
    [
      "digits in the hook",
      "Insane🤯6:51 | Doogile vs Edcr | MCSR Ranked | Minecraft Speedrun",
      ["doogile", "edcr"],
    ],
    [
      "lower case against camel case",
      "UNLUCKY.!! | bbiddd vs BeefSalad | MCSR Ranked | Minecraft Speedrun",
      ["bbiddd", "beefsalad"],
    ],
    [
      "a nickname that starts with a digit",
      "GIRL?? | 7astrid vs Dandannyboy | MCSR Ranked | Minecraft Speedrun",
      ["7astrid", "dandannyboy"],
    ],
    [
      "a digit inside a nickname",
      "Insane Comeback 🤯 | Lowk3y vs edcr | MCSR Ranked | Minecraft Speedrun",
      ["lowk3y", "edcr"],
    ],
    [
      "a question hook with an apostrophe",
      "WOULD HE HAVE WON IF HE HADN'T ..? | Silverrruns vs Infume | MCSR Ranked | Minecraft Speedrun",
      ["silverrruns", "infume"],
    ],
    [
      "a hook, then the old tail",
      "I've never seen a match like this | Anjouu vs Infume | MCSR Ranked Minecraft Speedrun",
      ["anjouu", "infume"],
    ],
    ["the old grammar, two spaces", "Lowkey vs Infume  MCSR Ranked Minecraft Speedrun", ["lowkey", "infume"]],
    [
      "a nickname with a space: DARVY__X1",
      "Doogile vs Darvy  x1 MCSR Ranked Minecraft Speedrun",
      ["doogile", "darvyx1"],
    ],
    [
      "a nickname with a space: v_strid",
      "Infume vs V strid MCSR Ranked Latest Match #30",
      ["infume", "vstrid"],
    ],
    [
      "a hook's own vs is not the pair (made up)",
      "MY BEST vs YOUR WORST | Feinberg vs Infume | MCSR Ranked | Minecraft Speedrun",
      ["feinberg", "infume"],
    ],
    [
      "a spaced nickname after a hook (made up)",
      "GG | V strid vs Infume | MCSR Ranked | Minecraft Speedrun",
      ["vstrid", "infume"],
    ],
    [
      "a spaced nickname, no hook (made up)",
      "Infume vs V strid | MCSR Ranked | Minecraft Speedrun",
      ["infume", "vstrid"],
    ],
    [
      "MCSR Vault: an upper-case VS and the broadcast name in brackets",
      "NO ONE DOES IT LIKE HIM | Pinne (Skycrab) VS ANJOUU | MCSR Ranked 1v1",
      ["pinne", "anjouu"],
    ],
    [
      "MCSR Replays: the seed type as the tail",
      "Infume vs silverrruns | MCSR Ranked | Shipwreck Seed",
      ["infume", "silverrruns"],
    ],
    [
      "a hook stuck to the first nickname, no pipe: no guess",
      "Skilled players.. Feinberg vs BeefSalad MCSR ranked speedrun 1v1 #13",
      null,
    ],
  ];
  for (const [what, title, want] of shapes)
    assert.deepEqual(playersFromTitle(title), want, `${what}: ${title}`);
  console.log("OK: the rival's real title shapes parse to their pair");
}

const day = 86_400_000;
const matchAt = Date.UTC(2026, 8, 6, 20); // 6 Sept 20:00
const posts: RivalPost[] = [
  {
    channel: "mcsrmatches",
    title: "TOUGH MATCH | Aquacorde vs Nahhann | MCSR Ranked",
    publishedAtMs: matchAt + day,
    players: ["aquacorde", "nahhann"],
  },
  {
    channel: "mcsrmatches",
    title: "Old | nahhann vs Aquacorde | MCSR Ranked",
    publishedAtMs: matchAt - 20 * day,
    players: ["nahhann", "aquacorde"],
  },
  { channel: "mcsrmatches", title: "Something else", publishedAtMs: matchAt + day, players: null },
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

// The bug end to end: a hook-less post has to count for its match like a hooked one, on the cards and
// on the shelf, and "Darvy  x1" as the rival types it is the API's DARVY__X1.
{
  const { rivalRecentPostFor } = await import("./rivalPosts.js");
  const post = (title: string): RivalPost => ({
    channel: "mcsrmatches",
    title,
    publishedAtMs: matchAt + day,
    players: playersFromTitle(title),
  });
  const hookless = post("Feinberg vs Infume | MCSR Ranked | Minecraft Speedrun");
  assert.equal(
    rivalMatchFor([hookless], ["infume", "Feinberg"], matchAt / 1000)?.title,
    hookless.title,
    "a hook-less post is found for its match",
  );
  assert.equal(
    rivalRecentPostFor([hookless], ["infume", "Feinberg"], matchAt + 2 * day)?.title,
    hookless.title,
    "and for the shelf",
  );
  const spaced = post("Doogile vs Darvy  x1 MCSR Ranked Minecraft Speedrun");
  assert.equal(
    rivalMatchFor([spaced], ["Doogile", "DARVY__X1"], matchAt / 1000)?.title,
    spaced.title,
    "a nickname the rival types with a space is the API's underscores",
  );
  console.log("OK: hook-less and spaced-nickname posts reach the badge");
}

// Two matches of one pair in one night: the video's length says which one was posted. Measured
// on the rival: 8:59 for an 8:48 run. A post of the wrong length is the other match, not this
// one, and must not demote this one; without lengths the old pair-and-window rule stands.
{
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
    {
      channel: "mcsrmatches",
      title: "old",
      publishedAtMs: now - 30 * day,
      players: ["aquacorde", "nahhann"],
    },
    {
      channel: "mcsrmatches",
      title: "TOUGH MATCH | Aquacorde vs Nahhann",
      publishedAtMs: now - 1 * day,
      players: ["aquacorde", "nahhann"],
    },
    {
      channel: "mcsrmatches",
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
// The public feed, read with no token (src/fixtures/rival-feed.xml: three entries of @mcsrmatches'
// feed, 14 Oct 2026 — a hook-less title, an escaped quote in a hook, a Short that names no pair).
// The audit told Google the OAuth token reads the channel's own data only.
{
  const { fetchRivalPosts, parseRivalFeed } = await import("./rivalPosts.js");
  const feed = readFileSync(new URL("../fixtures/rival-feed.xml", import.meta.url), "utf8");
  assert.deepEqual(parseRivalFeed(feed, "mcsrmatches"), [
    {
      channel: "mcsrmatches",
      title: "Silverrruns vs Lowkey | MCSR Ranked | Minecraft Speedrun",
      publishedAtMs: Date.parse("2026-10-12T21:00:04+00:00"),
      players: ["silverrruns", "lowkey"],
      matchIds: [],
    },
    {
      channel: "mcsrmatches",
      title: 'One Mistake "GG" | Doogile vs Aquacorde | MCSR Ranked | Minecraft Speedrun',
      publishedAtMs: Date.parse("2026-10-06T21:00:09+00:00"),
      players: ["doogile", "aquacorde"],
      matchIds: [],
    },
    {
      channel: "mcsrmatches",
      title: "MINECRAFT SPEEDRUN CLIPS 1",
      publishedAtMs: Date.parse("2026-09-28T19:01:40+00:00"),
      players: null,
      matchIds: [],
    },
  ]);
  assert.deepEqual(parseRivalFeed("<html>not a feed</html>", "mcsrmatches"), [], "no entries, no posts");

  const asked: { url: string; headers: Record<string, string> }[] = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });
    if (url === "https://www.youtube.com/@mcsrmatches")
      return new Response(
        '<html><link rel="canonical" href="https://www.youtube.com/channel/UCD4mMby1i-Lz2huxfMMWfLA">' +
          '"channelId":"UCxxxxxxxxxxxxxxxxxxxxxx"</html>',
      );
    if (url === "https://www.youtube.com/feeds/videos.xml?channel_id=UCD4mMby1i-Lz2huxfMMWfLA")
      return new Response(feed);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  assert.equal((await fetchRivalPosts("mcsrmatches", stub)).length, 3);
  assert.equal((await fetchRivalPosts("@mcsrmatches", stub)).length, 3, "a leading @ is the same handle");
  assert.equal((await fetchRivalPosts("mcsrmatches", stub)).length, 3);
  assert.equal(
    asked.filter((a) => a.url.startsWith("https://www.youtube.com/@")).length,
    1,
    "the handle is resolved once and kept",
  );
  for (const a of asked) {
    assert.ok(!a.url.includes("googleapis.com"), `no Data API call: ${a.url}`);
    assert.ok(
      !Object.keys(a.headers).some((h) => h.toLowerCase() === "authorization"),
      `no token: ${a.url}`,
    );
  }
  await assert.rejects(fetchRivalPosts("nosuchchannel", stub), /HTTP 404/);
  console.log("OK: the rival's public feed parses, and nothing carries the token");
}
// The match list's rows when the API was down for a match (no date): a post of the pair in the last
// two weeks reads as this match, as the shelf always read it; an older one as the pair only.
{
  const { rivalSightingsFor } = await import("./rivalPosts.js");
  const now = Date.UTC(2026, 9, 16, 12);
  const at = (daysBack: number): RivalPost => ({
    channel: "mcsrmatches",
    title: `${daysBack}d | Infume vs Feinberg | MCSR Ranked`,
    publishedAtMs: now - daysBack * day,
    players: ["infume", "feinberg"],
  });
  const kinds = (feed: RivalPost[]) =>
    rivalSightingsFor(feed, { matchId: 1, players: ["Feinberg", "Infume"], dateSec: null }, now).map(
      (x) => x.kind,
    );
  assert.deepEqual(kinds([at(3)]), ["match"]);
  assert.deepEqual(kinds([at(20)]), ["pair"]);
  assert.deepEqual(kinds([]), [], "no post: nothing");
  console.log("OK: with no match date, the shelf's two-week rule decides");
}
console.log("rivalPosts: all checks passed");
