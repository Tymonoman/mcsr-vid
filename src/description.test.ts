import assert from "node:assert/strict";
import { buildDescriptionExtras } from "./description.js";
import type { VodWindow } from "./vodAcquisition.js";

const window = (nickname: string, matchOffsetIntoVodSec: number): VodWindow => ({
  playerUuid: nickname,
  playerNickname: nickname,
  sourceUrl: `https://www.twitch.tv/videos/${nickname}VodId`,
  path: `/media/${nickname}.mp4`,
  matchOffsetIntoVodSec,
  matchOffsetIntoClipSec: 20,
});

const text = buildDescriptionExtras({
  leftNickname: "lowk3y_",
  rightNickname: "Aquacorde",
  leftWindow: window("lowk3y_", 1847.4),
  rightWindow: window("Aquacorde", 932),
  chapters: [
    { label: "Start", timeSec: 0 },
    { label: "Nether Enter", timeSec: 127 },
  ],
});

assert.match(
  text,
  /Watch lowk3y_: https:\/\/www\.twitch\.tv\/videos\/lowk3y_VodId\?t=1847s/,
  "deep link must round to whole seconds and use Twitch's ?t=Ns format",
);
assert.match(text, /Watch Aquacorde: .*\?t=932s/);
assert.match(text, /^Chapters:\n0:00 Start\n2:07 Nether Enter$/m, "chapters block must be included verbatim");
assert.match(text, /#lowk3y #Aquacorde/, "both player names must appear as hashtags, punctuation stripped");
assert.match(text, /#MCSRRanked #MinecraftSpeedrun #Minecraft #Speedrunning/, "format hashtags must be present");
assert.match(text, /#Nether #Bastion #Fortress #End/, "checkpoint hashtags must be present");
assert.match(text, /independent fan project, not affiliated with MCSR Ranked/);

console.log("description: all checks passed");
