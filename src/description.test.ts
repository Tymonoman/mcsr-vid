import assert from "node:assert/strict";
import { buildDescription, buildTags, type DescriptionInput } from "./description.js";
import type { MatchInfo, UserDetails } from "./types.js";
import type { VodWindow } from "./vodAcquisition.js";

const window = (nickname: string, matchOffsetIntoVodSec: number): VodWindow => ({
  playerUuid: nickname,
  playerNickname: nickname,
  sourceUrl: `https://www.twitch.tv/videos/${nickname}VodId`,
  path: `/media/${nickname}.mp4`,
  matchOffsetIntoVodSec,
  matchOffsetIntoClipSec: 20,
});

const user = (uuid: string, nickname: string, liveElo: number): UserDetails =>
  ({ uuid, nickname, eloRate: liveElo }) as UserDetails;

// Real figures from match 12730175 (edcr vs doogile): live elo 2615/2370, carried in 2546/2440.
// src/overlayProps.test.ts pins the same numbers, so a regression to live elo fails twice.
const EDCR = "edcr-uuid";
const DOOGILE = "doogile-uuid";

const match = (over: Partial<MatchInfo> = {}): MatchInfo =>
  ({
    id: 12730175,
    result: { uuid: EDCR, time: 532_000 },
    forfeited: false,
    changes: [
      { uuid: EDCR, change: 69, eloRate: 2615 },
      { uuid: DOOGILE, change: -70, eloRate: 2370 },
    ],
    ...over,
  }) as MatchInfo;

const build = (m: MatchInfo, over: Partial<DescriptionInput> = {}) =>
  buildDescription({
    matchId: 12730175,
    match: m,
    userLeft: user(EDCR, "edcr", 2615),
    userRight: user(DOOGILE, "doogile", 2370),
    leftWindow: window("edcr", 1847.4),
    rightWindow: window("doogile", 932),
    chapters: [
      { label: "Start", timeSec: 0 },
      { label: "Nether Enter", timeSec: 127 },
    ],
    ...over,
  });

const text = build(match());
const opening = text.split("\n")[0];

// The first 150-200 characters are all YouTube shows before "Show more". 100 at the low end: a
// match with no seed type is legitimately short, and the opening never carries the result.
assert.ok(
  opening.length >= 100 && opening.length <= 200,
  `opening must fit the Show-more preview, got ${opening.length}: ${opening}`,
);
assert.ok(!opening.includes("http"), "opening must not lead with a URL");
assert.match(opening, /MCSR Ranked 1v1/, "format keyword must be in the preview");
assert.ok(
  opening.indexOf("edcr") < 50 && opening.indexOf("doogile") < 50,
  "both nicknames must survive the ~50-char mobile truncation",
);
assert.ok(text.slice(0, 150).includes("MCSR Ranked"), "the format survives the preview cut");

// Elo comes from changes[].eloRate - changes[].change, never the live rating.
assert.match(
  opening,
  /edcr came in at 2546 elo, doogile at 2440\./,
  "must use match-time elo, not the live 2615/2370",
);
// Never the result: the description is read before the match is watched.
assert.ok(!opening.includes("Result:") && !opening.includes("8:52"), "the opening must not say who won");

// The exact opening, as a person would type it: what the video is, and nothing about how it was
// made. A viewer called the old copy out for reading like a machine wrote it.
assert.equal(
  opening,
  "edcr vs doogile, MCSR Ranked 1v1 on the same seed. Both streams run side by side with the split timer between them. edcr came in at 2546 elo, doogile at 2440.",
);
for (const slop of [
  "synced",
  "dual-POV",
  "pipeline",
  "automation",
  "maintained",
  "Subscribe",
  "Full ",
  " — ",
]) {
  assert.ok(!text.includes(slop), `"${slop}" must be gone from the description`);
}

assert.match(
  text,
  /^edcr's stream: https:\/\/www\.twitch\.tv\/videos\/edcrVodId\?t=1847s$/m,
  "deep link must round to whole seconds and use Twitch's ?t=Ns format",
);
assert.match(text, /^doogile's stream: .*\?t=932s$/m);
// The chapter list goes in bare: YouTube reads the 0:00 lines without a heading over them.
assert.match(text, /\n\n0:00 Start\n2:07 Nether Enter\n\n/, "chapters block must be included verbatim");
assert.ok(!text.includes("Chapters:"), "no heading over the chapter list");
assert.match(
  text,
  /^Match page: https:\/\/magmamcsr\.com\/ranked\/player\/edcr\/matches\/12730175(\?season=\d+)?$/m,
);

// The links, one per line, in this order: the two streams, the match page, then the opt-in two.
const links = text.split("\n\n")[2]!.split("\n");
assert.deepEqual(
  links.map((l) => l.split(":")[0]),
  ["edcr's stream", "doogile's stream", "Match page"],
  "no playlist or tip-jar line until the URLs are configured",
);
{
  const url = "https://www.youtube.com/playlist?list=PLHG-jSA-dWDo";
  const withBoth = build(match(), {
    playlistUrl: url,
    supportUrl: "https://ko-fi.com/mcsrreplayoffs",
  });
  assert.deepEqual(withBoth.split("\n\n")[2]!.split("\n").slice(3), [
    `All the matches: ${url}`,
    "Tip jar: https://ko-fi.com/mcsrreplayoffs",
  ]);
}

// The closer: who this is, and where to report a sync slip. Then the hashtags, and nothing else.
assert.equal(
  text.split("\n\n").slice(-2).join("\n\n"),
  "This is a fan channel, not run by MCSR Ranked. If the sync looks off anywhere, say so in the comments and I'll fix it.\n\n#MCSRRanked #MCSR #MinecraftSpeedrunning",
);

// VOD links sit below the chapters, so the preview is prose rather than URLs.
assert.ok(text.indexOf("0:00 Start") < text.indexOf("edcr's stream"), "chapters must precede the VOD links");

// Exactly the three hashtags, and nothing per-player or per-checkpoint.
assert.match(text, /^#MCSRRanked #MCSR #MinecraftSpeedrunning$/m);
assert.equal((text.match(/#/g) ?? []).length, 3, "exactly three hashtags — 3-5 is optimal, 10 was not");
for (const gone of ["#edcr", "#doogile", "#Nether", "#Bastion", "#Fortress", "#End", "#Minecraft "]) {
  assert.ok(!text.includes(gone), `${gone} must be gone`);
}

// Nor a forfeit: that is the ending too.
const ff = build(match({ forfeited: true, result: { uuid: DOOGILE, time: 0 } }));
assert.ok(!/forfeit|Result:/.test(ff.split("\n")[0]), "a forfeit is not announced either");

// No recorded winner: drop the clause rather than render a bogus one.
const draw = build(match({ result: { uuid: null, time: 0 } }));
assert.ok(!draw.split("\n")[0].includes("Result:"), "no winner means no result clause");
assert.match(draw.split("\n")[0], /^edcr vs doogile, MCSR Ranked 1v1/);

// A playoff game: the round and game number replace "1v1", the seeds paragraph follows the
// opening, and the series score is nowhere.
{
  const po = build(match(), {
    playoff: {
      season: 11,
      round: "Round of 16",
      gameNo: 2,
      bestOf: 5,
      seeds: [
        { uuid: EDCR, nickname: "edcr", label: "#1 seed", seasonEloRate: 2546 },
        {
          uuid: DOOGILE,
          nickname: "doogile",
          label: "#16 seed",
          seasonEloRate: 2440,
        },
      ],
    },
  });
  const [poOpening, poParagraph] = po.split("\n\n");
  assert.equal(
    poOpening,
    "edcr vs doogile, MCSR Ranked S11 Playoffs, Round of 16 · Game 2 of 5. Both streams run side by side with the split timer between them. edcr came in at 2546 elo, doogile at 2440.",
  );
  assert.match(poParagraph!, /^Season 11 Playoffs, Round of 16 · Game 2 of 5: edcr \(#1 seed, 2546 elo\)/);
  assert.ok(!/\b[0-9][–-][0-9]\b/.test(po), "no series score anywhere");
}

// --- Seed type ---------------------------------------------------------------------------
// The base match carries no seedType, so the assertions above already cover "omit it entirely".
assert.ok(opening.endsWith("doogile at 2440."), "no seedType means no seed sentence");
assert.ok(!/bastion/.test(opening), "no bastionType means no bastion clause");

const seeded = build(match({ seedType: "VILLAGE", bastionType: "BRIDGE" })).split("\n")[0];
assert.match(seeded, /Village seed, bridge bastion\./, "both halves, first letter capitalised");
assert.match(seeded, /^edcr vs doogile, MCSR Ranked 1v1/, "nicknames still lead the preview");
assert.ok(
  seeded.indexOf("Village seed") > seeded.indexOf("doogile at 2440"),
  "seed follows the elo sentence",
);
assert.ok(seeded.trimEnd().endsWith("bastion."), "and ends the opening");

const seedOnly = build(match({ seedType: "DESERT_TEMPLE" })).split("\n")[0];
assert.match(seedOnly, /Desert temple seed\./, "underscores become spaces");
assert.ok(!seedOnly.includes("bastion"), "a null bastion drops only its own half");

// An enum value nobody has seen yet must render, not throw.
assert.match(build(match({ seedType: "NEW_THING_HERE" })).split("\n")[0], /New thing here seed\./);

// --- Tags ----------------------------------------------------------------------------------
const tagsFor = (m: MatchInfo, left = "edcr", right = "doogile", max?: number) =>
  buildTags(m, user(EDCR, left, 2615), user(DOOGILE, right, 2370), max);

assert.deepEqual(tagsFor(match({ seedType: "VILLAGE", bastionType: "BRIDGE" })), [
  "edcr",
  "doogile",
  "mcsr ranked",
  "mcsr",
  "minecraft speedrun",
  "minecraft speedrunning",
  "ranked 1v1",
  "speedrun race",
  "village seed",
  "bridge bastion",
  "minecraft",
]);

// No seed known: the two seed tags are simply absent and nothing else shifts.
const plain = tagsFor(match());
assert.ok(!plain.some((t) => t.includes("seed") || t.includes("bastion")), "null seed adds no tags");
assert.equal(plain.at(-1), "minecraft", "the broadest term stays last");
assert.ok(!plain.some((t) => t.includes("#")), "tags are not hashtags");

// A nickname that collides with a keyword must appear once, in the nickname's slot.
const collide = tagsFor(match(), "MCSR", "doogile");
assert.equal(collide[0], "MCSR");
assert.equal(collide.filter((t) => t.toLowerCase() === "mcsr").length, 1, "dedupe is case-insensitive");

// Over 30 characters YouTube rejects the tag; drop that one rather than the whole list.
const longName = "a".repeat(31);
assert.ok(!tagsFor(match(), longName).includes(longName), "a 31-char nickname is dropped");
assert.ok(tagsFor(match(), "a".repeat(30)).includes("a".repeat(30)), "30 is still fine");

// The joined-length guard stops adding rather than truncating a tag mid-word.
// 24 is exactly "edcr,doogile,mcsr ranked" — the next tag would overflow, so the list ends there.
const capped = tagsFor(match(), "edcr", "doogile", 24);
assert.deepEqual(capped, ["edcr", "doogile", "mcsr ranked"], "stops before the limit is exceeded");
assert.equal(capped.join(",").length, 24);
assert.ok(tagsFor(match({ seedType: "VILLAGE", bastionType: "BRIDGE" })).join(",").length <= 450);

console.log("description: all checks passed");
