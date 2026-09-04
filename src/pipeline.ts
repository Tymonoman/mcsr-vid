import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { getMatch, getUser, getVersus, parseMatchId } from "./mcsrApi.js";
import { buildKdenliveProject, type KdenliveClipInput, type KdenliveMarkerInput } from "./kdenliveProject.js";
import {
  BOTTOM_BAND_HEIGHT,
  BOTTOM_BAND_Y,
  TOP_BAND_HEIGHT,
  LEFT_POV_RECT,
  RIGHT_POV_RECT,
} from "../remotion/layout.js";
import { computeSplits } from "./overlayProps.js";
import { buildChapters, formatChapters } from "./chapters.js";
import { buildDescription } from "./description.js";
import { buildTitle, formatTitle } from "./title.js";
import { renderOverlay } from "./overlayRender.js";
import { renderThumbnailVariants, variantFile } from "./thumbnailVariants.js";
import { describeError } from "./errorText.js";
import {
  aggregateDownloadPercent,
  createStageTracker,
  RENDER_PHASE_LABELS,
  RENDER_PHASE_WEIGHTS,
  THUMBNAIL_PHASE_WEIGHTS,
  weighted,
  type StageEvent,
  type StageExtra,
  type StageId,
  type StageTracker,
} from "./stageProgress.js";
import { computeSyncOffset } from "./sync.js";
import { downloadMatchVods, PRE_ROLL_SEC, type VodWindow } from "./vodAcquisition.js";

const FPS = 60;
const WIDTH = 1920;
const HEIGHT = 1080;

/**
 * Stage vocabulary, tracker and progress weighting live in ./stageProgress.js — pipeline.ts
 * crossed the 500-line cap and that half is pure, so it is unit-testable on its own. Re-exported
 * here so the seven existing importers of this module do not have to change.
 */
export {
  STAGE_LABELS,
  STAGE_ORDER,
  type StageEvent,
  type StageId,
  type StageStatus,
} from "./stageProgress.js";

export interface PipelineResult {
  matchId: number;
  projectPath: string;
  thumbnailPath: string;
  chaptersPath: string;
  descriptionPath: string;
  titlePath: string;
}

export interface PipelineOptions {
  onEvent?: (e: StageEvent) => void;
  signal?: AbortSignal;
}

function run(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"], signal });
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function probeDurationSec(filePath: string, signal?: AbortSignal): Promise<number> {
  const out = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    signal,
  );
  return parseFloat(out.trim());
}

export async function runPipeline(input: string, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const tracker = createStageTracker(opts.onEvent ?? (() => {}));
  try {
    return await runStages(input, opts, tracker);
  } catch (err) {
    // An abort is a deliberate stop, not a failure, and reporting it as one made "Stop" in the
    // dashboard read as a crash. The distinction is only visible here, because aborting rejects
    // the same promise a genuine error does — so the stage that was interrupted settles as a
    // warning (interrupted) rather than an error (broken).
    const aborted = opts.signal?.aborted === true;
    tracker.emit(
      aborted
        ? tracker.settle(tracker.current(), "warn", { message: "stopped" })
        : tracker.settle(tracker.current(), "error", { message: describeError(err) }),
    );
    throw err;
  }
}

async function runStages(
  input: string,
  opts: PipelineOptions,
  tracker: StageTracker,
): Promise<PipelineResult> {
  const { signal } = opts;
  const { emit, active } = tracker;
  const done = (stage: StageId, extra: StageExtra = {}) => tracker.settle(stage, "done", extra);
  const warn = (stage: StageId, extra: StageExtra = {}) => tracker.settle(stage, "warn", extra);

  emit(active("fetch"));
  const matchId = parseMatchId(input);
  const match = await getMatch(matchId);

  const [playerLeft, playerRight] = match.players;
  if (!playerLeft || !playerRight) {
    throw new Error(`Match ${matchId} does not have two players.`);
  }
  if (match.vod.length < 2) {
    throw new Error(
      `Match ${matchId} has ${match.vod.length}/2 VODs attached; the Kdenlive project needs both.`,
    );
  }

  const vodForPlayer = (uuid: string) => match.vod.find((v) => v.uuid === uuid);
  const vodLeft = vodForPlayer(playerLeft.uuid);
  const vodRight = vodForPlayer(playerRight.uuid);
  if (!vodLeft || !vodRight) {
    throw new Error(`Match ${matchId}: could not find a VOD for both players[0] and players[1].`);
  }

  const [userLeft, userRight, versus] = await Promise.all([
    getUser(playerLeft.uuid),
    getUser(playerRight.uuid),
    getVersus(playerLeft.uuid, playerRight.uuid),
  ]);
  emit(done("fetch", { message: `${playerLeft.nickname} vs ${playerRight.nickname}` }));

  const outDir = path.join(config.mediaDir, String(matchId));
  const pathFor = (nickname: string) => path.join(outDir, `${nickname}.mp4`);

  const downloadPercents = new Map<number, number>();
  emit(active("download", { percent: 0 }));
  let windows: VodWindow[];
  if (existsSync(pathFor(playerLeft.nickname)) && existsSync(pathFor(playerRight.nickname))) {
    windows = [
      {
        playerUuid: vodLeft.uuid,
        playerNickname: playerLeft.nickname,
        sourceUrl: vodLeft.url,
        path: pathFor(playerLeft.nickname),
        matchOffsetIntoVodSec: 0,
        matchOffsetIntoClipSec: PRE_ROLL_SEC,
      },
      {
        playerUuid: vodRight.uuid,
        playerNickname: playerRight.nickname,
        sourceUrl: vodRight.url,
        path: pathFor(playerRight.nickname),
        matchOffsetIntoVodSec: 0,
        matchOffsetIntoClipSec: PRE_ROLL_SEC,
      },
    ];
    emit(done("download", { percent: 100, message: "reused cached downloads" }));
  } else {
    windows = await downloadMatchVods(
      match,
      outDir,
      (p) => {
        // Both downloads run concurrently (vodAcquisition.ts uses Promise.all), so their
        // progress lines interleave. Averaging the latest percent per player is monotonic;
        // the previous `(index + pct/100) / total` mapped player 0 to 0-50% and player 1 to
        // 50-100%, which made the bar jump between the two bands for the whole download.
        downloadPercents.set(p.index, p.percent);
        emit(
          active("download", {
            percent: aggregateDownloadPercent(downloadPercents, p.total),
            message: `${p.playerNickname} (${p.index + 1}/${p.total}): ${p.percent.toFixed(0)}%`,
          }),
        );
      },
      signal,
    );
    emit(done("download", { percent: 100 }));
  }

  const leftWindow = windows.find((w) => w.playerUuid === playerLeft.uuid);
  const rightWindow = windows.find((w) => w.playerUuid === playerRight.uuid);
  if (!leftWindow || !rightWindow) {
    throw new Error("Downloaded windows don't match players[0]/players[1].");
  }

  emit(active("sync"));
  let rightOffsetSec = rightWindow.matchOffsetIntoClipSec;
  let syncConfidence: number | undefined;
  try {
    const sync = await computeSyncOffset(
      leftWindow.path,
      rightWindow.path,
      leftWindow.matchOffsetIntoClipSec,
      rightWindow.matchOffsetIntoClipSec,
      signal,
    );
    syncConfidence = sync.confidence;
    if (sync.confidence >= config.syncConfidenceThreshold) {
      rightOffsetSec = sync.clipBCueTimeSec;
      emit(done("sync", { message: `confidence ${sync.confidence.toFixed(3)} (refined)` }));
    } else {
      emit(
        warn("sync", {
          message: `confidence ${sync.confidence.toFixed(3)} (too low, kept coarse offset)`,
        }),
      );
    }
  } catch (err) {
    emit(warn("sync", { message: `refinement failed: ${describeError(err)}` }));
  }

  const overlayPath = path.join(outDir, "overlay.mov");
  const overlayTopPath = path.join(outDir, "overlay-top.png");
  const overlayIntroPath = path.join(outDir, "overlay-intro.mov");
  if (existsSync(overlayPath) && existsSync(overlayTopPath) && existsSync(overlayIntroPath)) {
    emit(done("render", { percent: 100, message: "reused existing render" }));
  } else {
    emit(active("render", { percent: 0 }));
    await renderOverlay({
      match,
      userLeft,
      userRight,
      versus,
      outPath: overlayPath,
      topOutPath: overlayTopPath,
      introOutPath: overlayIntroPath,
      signal,
      onProgress: (p) =>
        emit(
          active("render", {
            percent: weighted(RENDER_PHASE_WEIGHTS, p.phase, p.percent),
            message: `${RENDER_PHASE_LABELS[p.phase]}: ${p.percent}%`,
          }),
        ),
    });
    emit(done("render", { percent: 100 }));
  }

  // Every configured pose pair, so there is something to A/B test once the channel has the
  // audience for it. Skipping is per variant rather than per match, so adding a pose renders
  // only the new one; when they are all present this stage is as cheap as it always was.
  const thumbnailPath = path.join(outDir, "thumbnail.png");
  const variants = config.thumbnailVariants;
  const allRendered =
    existsSync(thumbnailPath) && variants.every((p) => existsSync(path.join(outDir, variantFile(p))));
  if (allRendered) {
    emit(done("thumbnail", { message: `reused ${variants.length} variants` }));
  } else {
    emit(active("thumbnail", { percent: 0 }));
    const manifest = await renderThumbnailVariants({
      match,
      userLeft,
      userRight,
      outDir,
      poses: variants,
      signal,
      onProgress: (p) =>
        emit(
          active("thumbnail", {
            percent: weighted(THUMBNAIL_PHASE_WEIGHTS, p.phase, p.percent),
            message: `${p.phase}: ${p.percent}%`,
          }),
        ),
    });
    // Worth saying out loud: when Starlight Skins is down every pose falls back to the same
    // static NMSR render, so "3 variants" would otherwise imply three different images.
    const posed = manifest.variants.filter(
      (v) => v.leftProvider === "starlight" || v.rightProvider === "starlight",
    ).length;
    emit(
      done("thumbnail", {
        message:
          posed === manifest.variants.length
            ? `${manifest.variants.length} variants`
            : `${manifest.variants.length} variants (${manifest.variants.length - posed} fell back to a static pose)`,
      }),
    );
  }

  emit(active("write"));
  const [leftDurationSec, rightDurationSec, overlayDurationSec, introDurationSec] = await Promise.all([
    probeDurationSec(leftWindow.path, signal),
    probeDurationSec(rightWindow.path, signal),
    probeDurationSec(overlayPath, signal),
    probeDurationSec(overlayIntroPath, signal),
  ]);

  const leftClip: KdenliveClipInput = {
    path: path.resolve(leftWindow.path),
    durationSec: leftDurationSec,
    matchOffsetIntoClipSec: leftWindow.matchOffsetIntoClipSec,
    clipName: `${leftWindow.playerNickname} POV`,
    positionRect: LEFT_POV_RECT,
  };
  const rightClip: KdenliveClipInput = {
    path: path.resolve(rightWindow.path),
    durationSec: rightDurationSec,
    matchOffsetIntoClipSec: rightOffsetSec,
    clipName: `${rightWindow.playerNickname} POV`,
    positionRect: RIGHT_POV_RECT,
  };
  // The overlay ships as three layers rather than one full-frame video: a static top band held
  // as a still, the animated bottom band, and the opaque intro card. Rendering the empty middle
  // of the frame (and ~17k identical copies of the static band) is what made this slow.
  // `matchOffsetIntoClipSec` is the lead-in, not PRE_ROLL_SEC, so they start later on the
  // timeline than the VOD clips do (see overlayRender.ts).
  const overlayClips: KdenliveClipInput[] = [
    {
      path: path.resolve(overlayTopPath),
      durationSec: overlayDurationSec,
      matchOffsetIntoClipSec: config.overlayLeadInSec,
      clipName: "Stat Overlay (top)",
      positionRect: `0 0 ${WIDTH} ${TOP_BAND_HEIGHT} 1`,
      isImage: true,
    },
    {
      path: path.resolve(overlayPath),
      durationSec: overlayDurationSec,
      matchOffsetIntoClipSec: config.overlayLeadInSec,
      clipName: "Stat Overlay (splits)",
      positionRect: `0 ${BOTTOM_BAND_Y} ${WIDTH} ${BOTTOM_BAND_HEIGHT} 1`,
    },
    {
      path: path.resolve(overlayIntroPath),
      durationSec: introDurationSec,
      matchOffsetIntoClipSec: config.overlayLeadInSec,
      clipName: "Intro",
    },
  ];

  // Marker positions use the same maxOffset-relative math buildKdenliveProject's buildTrack
  // uses to place each clip on the timeline, so markers land in sync with the actual footage.
  const maxOffset = Math.max(
    leftClip.matchOffsetIntoClipSec,
    rightClip.matchOffsetIntoClipSec,
    ...overlayClips.map((c) => c.matchOffsetIntoClipSec),
  );
  const splits = computeSplits(match, playerLeft.uuid, playerRight.uuid);
  const markers: KdenliveMarkerInput[] = [];
  for (const row of splits) {
    if (row.leftMs !== null) {
      markers.push({
        positionSec: maxOffset - leftClip.matchOffsetIntoClipSec + row.leftMs / 1000,
        comment: `${row.label} — ${leftWindow.playerNickname}`,
      });
    }
    if (row.rightMs !== null) {
      markers.push({
        positionSec: maxOffset - rightClip.matchOffsetIntoClipSec + row.rightMs / 1000,
        comment: `${row.label} — ${rightWindow.playerNickname}`,
      });
    }
  }
  if (syncConfidence !== undefined) {
    const lowConfidence = syncConfidence < config.syncConfidenceThreshold;
    markers.push({
      positionSec: maxOffset,
      comment: `Sync confidence: ${(syncConfidence * 100).toFixed(0)}%${lowConfidence ? " — LOW, verify alignment" : ""}`,
    });
  }

  const projectXml = buildKdenliveProject({
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    leftClip,
    rightClip,
    overlayClips,
    projectName: `Match ${matchId} - ${leftWindow.playerNickname} vs ${rightWindow.playerNickname}`,
    markers,
  });

  const projectPath = path.join(outDir, `match-${matchId}.kdenlive`);
  await writeFile(projectPath, projectXml, "utf8");

  const chapters = buildChapters(splits, match, config.overlayLeadInSec);
  const chaptersPath = path.join(outDir, `match-${matchId}.chapters.txt`);
  await writeFile(chaptersPath, formatChapters(chapters), "utf8");

  const description = buildDescription({
    matchId,
    match,
    userLeft,
    userRight,
    leftWindow,
    rightWindow,
    chapters,
  });
  const descriptionPath = path.join(outDir, `match-${matchId}.description.txt`);
  await writeFile(descriptionPath, description, "utf8");

  const title = buildTitle({
    leftNickname: leftWindow.playerNickname,
    rightNickname: rightWindow.playerNickname,
  });
  const titlePath = path.join(outDir, `match-${matchId}.title.txt`);
  await writeFile(titlePath, formatTitle(title), "utf8");
  emit(done("write"));

  return {
    matchId,
    projectPath: path.resolve(projectPath),
    thumbnailPath: path.resolve(thumbnailPath),
    chaptersPath: path.resolve(chaptersPath),
    descriptionPath: path.resolve(descriptionPath),
    titlePath: path.resolve(titlePath),
  };
}
