import assert from "node:assert/strict";
import { buildDescription } from "./description.js";
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

// Real figures from match 12730175 (edcr vs doogile, 24 Aug 2026). The overlay used to read elo
// live at render time and showed 2615/2370; the ratings the players actually carried in were
// 2546/2440. src/overlayProps.test.ts pins the same numbers, so a regression to live elo fails in
// two places at once.
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

const build = (m: MatchInfo) =>
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
  });

const text = build(match());
const opening = text.split("\n")[0];

// The whole point of the rewrite: the first 150-200 characters are all YouTube shows before
// "Show more", and on every live upload so far they were two raw Twitch URLs.
assert.ok(
  opening.length >= 120 && opening.length <= 200,
  `opening must fit the Show-more preview, got ${opening.length}: ${opening}`,
);
assert.ok(!opening.includes("http"), "opening must not lead with a URL");
assert.match(opening, /MCSR Ranked 1v1/, "format keyword must be in the preview");
assert.ok(
  opening.indexOf("edcr") < 50 && opening.indexOf("doogile") < 50,
  "both nicknames must survive the ~50-char mobile truncation",
);

// Elo comes from changes[].eloRate - changes[].change, never the live rating.
assert.match(opening, /2546 vs 2440 elo/, "must use match-time elo, not the live 2615/2370");
assert.match(opening, /Result: edcr 8:52\./, "winner and finish time");

assert.match(
  text,
  /Watch edcr's POV: https:\/\/www\.twitch\.tv\/videos\/edcrVodId\?t=1847s/,
  "deep link must round to whole seconds and use Twitch's ?t=Ns format",
);
assert.match(text, /Watch doogile's POV: .*\?t=932s/);
assert.match(text, /^Chapters:\n0:00 Start\n2:07 Nether Enter$/m, "chapters block must be included verbatim");
assert.match(text, /Match data: https:\/\/mcsrranked\.com\/matches\/12730175/);
assert.match(text, /independent fan project, not affiliated with MCSR Ranked/);
assert.match(text, /synced dual-POV with live split comparison/, "the added-value line YPP review looks for");

// VOD links moved below the chapters, so the preview is prose rather than URLs.
assert.ok(text.indexOf("Chapters:") < text.indexOf("Watch edcr's POV"), "chapters must precede the VOD links");

// Exactly the three hashtags, and nothing per-player or per-checkpoint.
assert.match(text, /^#MCSRRanked #MCSR #MinecraftSpeedrunning$/m);
assert.equal((text.match(/#/g) ?? []).length, 3, "exactly three hashtags — 3-5 is optimal, 10 was not");
for (const gone of ["#edcr", "#doogile", "#Nether", "#Bastion", "#Fortress", "#End", "#Minecraft "]) {
  assert.ok(!text.includes(gone), `${gone} must be gone`);
}

// A forfeited match names the winner without implying they ran the time.
const ff = build(match({ forfeited: true, result: { uuid: DOOGILE, time: 0 } }));
assert.match(ff.split("\n")[0], /Result: doogile wins by forfeit\./);

// No recorded winner: drop the clause rather than render a bogus one.
const draw = build(match({ result: { uuid: null, time: 0 } }));
assert.ok(!draw.split("\n")[0].includes("Result:"), "no winner means no result clause");
assert.match(draw.split("\n")[0], /^edcr vs doogile — MCSR Ranked 1v1/);

console.log("description: all checks passed");
