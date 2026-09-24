// Self-check for the upload-time text refresh (`uploadTextFor`): a match rendered on an old
// template goes up with today's generated half, while what the operator wrote is kept.
// Run: npx tsx src/youtube/youtubeStore.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { CLOSER } from "../pipeline/description.js";
import { refreshTitle, uploadTextFor } from "./youtubeStore.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-uploadtext-"));
config.mediaDir = media;
config.supportUrl = "https://ko-fi.com/x";
config.titleNames = { Pinne: "Skycrab" };

const write = (matchId: number, files: Record<string, string>) => {
  const dir = path.join(media, String(matchId));
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
};
const warnings: string[] = [];
console.warn = (line: string) => warnings.push(line);

const OLD_CLOSER = "fan channel, mcsr ranked has no idea i exist. if the sync looks off anywhere say where.";
const oldDescription = [
  "7rowl vs Pinne, mcsr ranked season 11 playoffs, round of 16, game 2. a minecraft speedrun race.",
  "",
  "Season 11 Playoffs, Round of 16 · Game 2 of 5: Pinne (#7 seed, 2477 elo) vs 7rowl (LCQ, 2300 elo).",
  "",
  "0:00 intro",
  "",
  "match page: https://magmamcsr.com/ranked/player/7rowl/matches/101?season=12",
  "all the matches: https://www.youtube.com/playlist?list=PL",
  "",
  OLD_CLOSER,
  "",
  "#MCSRRanked #MCSR #MinecraftSpeedrunning",
].join("\n");

// A playoff game rendered before 22-24 Sept: the old tail, "#7 seed", the old closer, no tip jar,
// the API's spelling in the title and no broadcast spelling in the tags.
write(101, {
  "match-101.title.txt":
    "<HOOK> | 7rowl vs Pinne | MCSR Ranked S11 Playoffs · Round of 16 · Game 2\n\nguidance",
  "match-101.title.edited.txt":
    "The LCQ vs the 7th seed | 7rowl vs Pinne | MCSR Ranked S11 Playoffs · Round of 16 · Game 2\n",
  "match-101.description.txt": oldDescription,
  "match-101.tags.txt": "7rowl\nPinne\nmcsr ranked\nminecraft\n",
  "short-101.title.txt": "Can the LCQ take down the 7th seed? #minecraft #mcsr\n",
  "short-101.hook.txt": "Can the LCQ take down the 7th seed?\n",
  "short-101.description.txt": "7rowl vs Pinne. the whole match is on the channel.\n(#7 seed)\n#MCSR",
});
{
  const text = await uploadTextFor(101, "video");
  assert.equal(
    text.title,
    "The LCQ vs the 7th seed | 7rowl vs Skycrab | MCSR Ranked Season 11 Playoffs | Round of 16 | Game 2",
  );
  assert.ok(text.description.includes("Pinne (7th seed, 2477 elo)"), text.description);
  assert.ok(!/#\d+ seed/.test(text.description));
  assert.ok(!text.description.includes(OLD_CLOSER));
  // The tip jar goes where the template puts it: after the links, before the closer.
  assert.ok(
    text.description.includes(
      `all the matches: https://www.youtube.com/playlist?list=PL\ntip jar: https://ko-fi.com/x\n\n${CLOSER}\n`,
    ),
    text.description,
  );
  // The links the render checked are untouched.
  assert.ok(
    text.description.includes("match page: https://magmamcsr.com/ranked/player/7rowl/matches/101?season=12"),
  );
  assert.deepEqual(text.tags, ["7rowl", "Pinne", "Skycrab", "mcsr ranked", "minecraft"]);

  const short = await uploadTextFor(101, "short");
  assert.equal(short.title, "Can the LCQ take down the 7th seed? | 7rowl vs Skycrab #mcsr #minecraft");
  assert.ok(short.description.includes("(7th seed)"));
  assert.ok(!short.description.includes("tip jar"), "a Short's layout gets the seed wording only");
  assert.deepEqual(warnings, []);
}

// An edited description is the operator's: verbatim, "#9 seed" and all; a ranked title gains
// "| Minecraft Speedrun"; a tip jar already there is not added twice.
write(102, {
  "match-102.title.edited.txt": "Rematch: doogile leads 3-1 | doogile vs Feinberg | MCSR Ranked 1v1\n",
  "match-102.description.txt": "generated\n\ntip jar: https://ko-fi.com/x\n\nfan channel, old.\n",
  "match-102.description.edited.txt": "my own words (#9 seed)\nno tip jar here",
  "match-102.tags.txt": "doogile\nFeinberg\n",
});
{
  const text = await uploadTextFor(102, "video");
  assert.equal(
    text.title,
    "Rematch: doogile leads 3-1 | doogile vs Feinberg | MCSR Ranked 1v1 | Minecraft Speedrun",
  );
  assert.equal(text.description, "my own words (#9 seed)\nno tip jar here");
  assert.deepEqual(text.tags, ["doogile", "Feinberg"]);
}

// A rebuilt title over 100 characters goes up as stored, with one log line.
const longHook = "This hook is long enough to overflow";
const stored = `${longHook} | ab vs cd | MCSR Ranked S11 Playoffs · Round of 16 · Game 2`;
assert.ok(stored.length <= 100);
write(103, { "match-103.title.edited.txt": `${stored}\n` });
{
  const text = await uploadTextFor(103, "video");
  assert.equal(text.title, stored);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0]!,
    /match 103: the stored title goes up as it is — the rebuilt title would be 10\d characters/,
  );
}

// A Short with no saved hook cannot upload, so the kit's read of it keeps the stored title and
// logs nothing (it runs on every match the dashboard opens).
write(104, {
  "match-104.title.edited.txt": "Hook | ab vs cd | MCSR Ranked 1v1 | Minecraft Speedrun\n",
  "short-104.title.txt": "An old Short title #minecraft #mcsr\n",
});
{
  const before = warnings.length;
  assert.equal((await uploadTextFor(104, "short")).title, "An old Short title #minecraft #mcsr");
  assert.equal(warnings.length, before, warnings.slice(before).join("\n"));
}

// A joined series takes the round without a game number; an unknown format half is kept.
assert.equal(
  refreshTitle("Game one | ab vs cd | MCSR Ranked Season 11 Playoffs | Round of 16 | Game 1", true),
  "Game one | ab vs cd | MCSR Ranked Season 11 Playoffs | Round of 16",
);
assert.throws(
  () => refreshTitle("hook | ab vs cd | Some Other Tournament", false),
  /neither a ranked nor a playoff/,
);
// The names are the LAST "a vs b": a hook may read like one.
assert.equal(
  refreshTitle("2699 vs 2376 | ab vs cd | MCSR Ranked 1v1", false),
  "2699 vs 2376 | ab vs cd | MCSR Ranked 1v1 | Minecraft Speedrun",
);
// The spelling that pushes the second name past the mobile cut keeps the stored title.
assert.throws(
  () => refreshTitle("A hook of exactly thirty chars | cdefghij vs Pinne | MCSR Ranked 1v1", false),
  /mobile cut/,
);

console.log("youtubeStore.test: ok");
