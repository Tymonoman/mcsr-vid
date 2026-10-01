// The channel's 33 long-form titles of 17 Aug to 1 Oct 2026 (the 30 Sept post-mortem's table),
// replayed in the order they went up: what `nicknameWarnings` and `lastMeetingFor` would have said
// at each save. TAS is doogile's; the post-mortem found it on BeefSalad, Feinberg and lowkey too,
// and those three saves are the only warnings. Real titles, so a rule that would nag on a correct
// use, or miss a reuse, shows here before it reaches the operator.
// Run: npx tsx src/youtube/youtubeStore.replay.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { lastMeetingFor, nicknameWarnings, type UploadRecord } from "./youtubeStore.js";

config.mediaDir = mkdtempSync(path.join(tmpdir(), "mcsr-replay-"));
config.titleNames = { Pinne: "Skycrab", lowk3y_: "lowkey" };

// date | hook | pair | S for a series
const TITLES = `
2026-08-17|WANNABE vs REAL GOAT|lowkey vs Aquacorde
2026-08-20|They REALLY think they'll get RANK #1|ANJOUU vs silverrruns
2026-08-22|UNC vs CATBOY|Feinberg vs Infume
2026-08-26|YN vs TAS|edcr vs doogile
2026-09-02|INSANELY CLOSE MATCHUP|bbiddd vs BadGamer
2026-09-03|SILENT ACCEPTANCE|BeefSalad vs v_strid
2026-09-05|DON'T DIG STRAIGHT DOWN KIDS|nahhann vs Aquacorde
2026-09-09|LOVERBOY vs TAS|Infume vs BeefSalad
2026-09-10|TAS vs UNC|doogile vs Feinberg
2026-09-12|LOVERBOY VS ROBLOX KID|Infume vs NoHacsJustRoblox
2026-09-14|LOVERBOY vs AWKWARD|Aquacorde vs Infume
2026-09-16|LOVERBOY vs TAS|Infume vs Feinberg
2026-09-17|CARNIVORE vs VEGAN|BeefSalad vs silverrruns
2026-09-19|TAS vs IKEA GUY|doogile vs v_strid
2026-09-22|TAS vs SWEPT|doogile vs Aquacorde
2026-09-22|AWKWARD vs TAS|Aquacorde vs doogile|S
2026-09-23|UNC vs OG|Feinberg vs silverrruns
2026-09-23|WASHED vs IKEA GUY|silverrruns vs v_strid|S
2026-09-24|LOVERBOY vs UNC|Infume vs Feinberg
2026-09-24|LCQ vs YN|lauveer vs edcr|S
2026-09-25|ASIAN VS CARNIVORE|hackingnoises vs BeefSalad
2026-09-25|TAS vs DOG|lowkey vs woofdoggo_|S
2026-09-26|THE DUALITY OF MAN|Infume vs Feinberg
2026-09-27|LOVERBOY vs OG|Infume vs silverrruns
2026-09-28|58 MILLISECONDS|v_strid vs silverrruns
2026-09-28|WHO BLINKS FIRST?|BlazeMind vs bbiddd|S
2026-09-29|LOCKED IN vs UNC|Feinberg vs Infume
2026-09-29|THE CALM BEFORE THE STORM|Infume vs steez|S
2026-09-30|WR HOLDER vs THE GRINDER|romuxii vs Skycrab
2026-09-30|CRAB vs CROW|7rowl vs Skycrab|S
2026-10-01|THE FORTRESS RUNBACK|silverrruns vs dandannyboy
2026-10-01|UNC GOES TO THE PLAYOFFS|nahhann vs Feinberg|S
`
  .trim()
  .split("\n")
  .map((row) => row.split("|") as [string, string, string, string?]);

const warned: Array<[hook: string, warning: string]> = [];
const linked: Array<[hook: string, to: string]> = [];
const hookOf = new Map<string, string>();
for (const [i, [date, hook, pair, series]] of TITLES.entries()) {
  const matchId = 1000 + i;
  const title = `${hook} | ${pair} | ${series ? "MCSR Ranked Season 11 Playoffs | Round of 16" : "MCSR Ranked 1v1 | Minecraft Speedrun"}`;
  for (const warning of await nicknameWarnings(title, matchId)) warned.push([`${date} ${hook}`, warning]);
  const earlier = await lastMeetingFor(matchId, title);
  if (earlier) linked.push([hook, hookOf.get(earlier)!]);
  const dir = path.join(config.mediaDir, String(matchId));
  mkdirSync(dir);
  const record: UploadRecord = {
    videoId: `video${matchId}`,
    uploadedAt: `${date}T19:00:00Z`,
    publishAt: null,
    privacyStatus: "public",
    thumbnailVariant: null,
    title,
  };
  writeFileSync(path.join(dir, "youtube.json"), JSON.stringify(record));
  hookOf.set(record.videoId, hook);
}

assert.deepEqual(warned, [
  // The first reuse: one earlier title, so TAS was edcr's or doogile's.
  ["2026-09-09 LOVERBOY vs TAS", '"TAS" stood for edcr or doogile on 2026-08-26 — one nickname per player'],
  ["2026-09-16 LOVERBOY vs TAS", '"TAS" stood for doogile on 2026-09-10 — one nickname per player'],
  ["2026-09-25 TAS vs DOG", '"TAS" stood for doogile on 2026-09-22 — one nickname per player'],
]);
// The pair's most recent earlier video, a series being one video: six saves in the table repeat a pair.
assert.deepEqual(linked, [
  ["LOVERBOY vs TAS", "UNC vs CATBOY"],
  ["AWKWARD vs TAS", "TAS vs SWEPT"],
  ["LOVERBOY vs UNC", "LOVERBOY vs TAS"],
  ["THE DUALITY OF MAN", "LOVERBOY vs UNC"],
  ["58 MILLISECONDS", "WASHED vs IKEA GUY"],
  ["LOCKED IN vs UNC", "THE DUALITY OF MAN"],
]);
console.log("youtubeStore.replay.test: ok");
