import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { requireArg } from "./cliArgs.js";
import { getMatch, parseMatchId } from "./mcsrApi.js";
import { computeSyncOffset } from "./sync.js";
import { downloadMatchVods, type VodWindow } from "./vodAcquisition.js";

const matchId = parseMatchId(requireArg("validate-sync"));
const match = await getMatch(matchId);

if (match.vod.length < 2) {
  console.error(
    `Match ${matchId} has ${match.vod.length}/2 VODs attached; sync validation needs both.`,
  );
  process.exit(1);
}

const outDir = path.join("media", String(matchId));
let windows: VodWindow[];
const [vodA, vodB] = match.vod;
const expectedPathA = path.join(outDir, `${match.players.find((p) => p.uuid === vodA!.uuid)?.nickname ?? vodA!.uuid}.mp4`);
const expectedPathB = path.join(outDir, `${match.players.find((p) => p.uuid === vodB!.uuid)?.nickname ?? vodB!.uuid}.mp4`);

if (existsSync(expectedPathA) && existsSync(expectedPathB)) {
  console.error(`Reusing existing downloads in ${outDir}/`);
  windows = match.vod.map((vod) => {
    const nickname = match.players.find((p) => p.uuid === vod.uuid)?.nickname ?? vod.uuid;
    // Mirrors vodAcquisition.ts: `date` is the match's completion timestamp, so the start
    // has to be derived by subtracting the run duration.
    const matchEndIntoVodSec = match.date - vod.startsAt;
    const runSec = match.result.time > 0 ? match.result.time / 1000 : 900;
    const matchStartIntoVodSec = matchEndIntoVodSec - runSec;
    return {
      playerUuid: vod.uuid,
      playerNickname: nickname,
      sourceUrl: vod.url,
      path: path.join(outDir, `${nickname}.mp4`),
      matchOffsetIntoVodSec: matchStartIntoVodSec,
      matchOffsetIntoClipSec: 150, // PRE_ROLL_SEC from vodAcquisition.ts
    };
  });
} else {
  console.error(`Downloading VODs for match ${matchId}...`);
  windows = await downloadMatchVods(match, outDir);
}

const [clipA, clipB] = windows;
if (!clipA || !clipB) throw new Error("expected two downloaded clips");

console.error(
  `Cross-correlating ${clipA.playerNickname} (ref) against ${clipB.playerNickname} (search)...`,
);
const result = await computeSyncOffset(
  clipA.path,
  clipB.path,
  clipA.matchOffsetIntoClipSec,
  clipB.matchOffsetIntoClipSec,
);

const correctionSec = result.clipBCueTimeSec - clipB.matchOffsetIntoClipSec;

console.log(
  JSON.stringify(
    {
      matchId,
      clipA: { player: clipA.playerNickname, cueTimeSec: clipA.matchOffsetIntoClipSec },
      clipB: {
        player: clipB.playerNickname,
        expectedCueTimeSec: clipB.matchOffsetIntoClipSec,
        correctedCueTimeSec: result.clipBCueTimeSec,
        correctionSec,
      },
      confidence: result.confidence,
    },
    null,
    2,
  ),
);

if (result.confidence < 0.15) {
  console.error(
    `\nWarning: low correlation confidence (${result.confidence.toFixed(3)}). The match-start ` +
      `sound cue may be disabled or inaudible in one of these VODs — verify manually.`,
  );
}

const previewPath = path.join(outDir, "sync-preview.mp4");
console.error(`Rendering side-by-side sync preview to ${previewPath}...`);

await new Promise<void>((resolve, reject) => {
  const proc = spawn(
    "ffmpeg",
    [
      "-y",
      "-ss",
      String(Math.max(0, clipA.matchOffsetIntoClipSec - 2)),
      "-t",
      "15",
      "-i",
      clipA.path,
      "-ss",
      String(Math.max(0, result.clipBCueTimeSec - 2)),
      "-t",
      "15",
      "-i",
      clipB.path,
      "-filter_complex",
      "[0:v]scale=960:540[l];[1:v]scale=960:540[r];[l][r]hstack=inputs=2[v]",
      "-map",
      "[v]",
      "-map",
      "0:a",
      previewPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  proc.on("error", reject);
  proc.on("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`ffmpeg preview render failed: ${stderr.slice(-500)}`));
  });
});

console.error(`Done. Scrub ${previewPath} to confirm both POVs show the same in-game moment.`);
