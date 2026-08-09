import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { getMatch, getUser, getVersus, parseMatchId } from "./mcsrApi.js";
import { buildKdenliveProject, type KdenliveClipInput, type KdenliveMarkerInput } from "./kdenliveProject.js";
import { computeSplits } from "./overlayProps.js";
import { renderOverlay } from "./overlayRender.js";
import { renderThumbnail } from "./thumbnailRender.js";
import { computeSyncOffset } from "./sync.js";
import { downloadMatchVods, PRE_ROLL_SEC, type VodWindow } from "./vodAcquisition.js";

const FPS = 60;
const WIDTH = 1920;
const HEIGHT = 1080;

export type StageId = "fetch" | "download" | "sync" | "render" | "thumbnail" | "write";

export const STAGE_ORDER: StageId[] = ["fetch", "download", "sync", "render", "thumbnail", "write"];

export const STAGE_LABELS: Record<StageId, string> = {
  fetch: "Fetch match data",
  download: "Download VODs",
  sync: "Audio sync check",
  render: "Render overlay",
  thumbnail: "Render thumbnail",
  write: "Write Kdenlive project",
};

export type StageStatus = "pending" | "active" | "done" | "error";

export interface StageEvent {
  stage: StageId;
  status: StageStatus;
  /** 0-100; omitted for near-instant stages. */
  percent?: number;
  message?: string;
  /** Date.now() when this stage's status first became "active"; same value across repeat active-emits. */
  startedAtMs?: number;
}

export interface PipelineResult {
  matchId: number;
  projectPath: string;
  thumbnailPath: string;
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
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    signal,
  );
  return parseFloat(out.trim());
}

export async function runPipeline(input: string, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const { onEvent = () => {}, signal } = opts;
  const emit = (e: StageEvent) => onEvent(e);

  // Tracks when each stage first went "active" so repeat active-emits (download/render
  // progress callbacks) can carry a stable startedAtMs for the TUI's ETA calculation.
  const stageStartTimes = new Map<StageId, number>();
  const active = (stage: StageId, extra: Omit<StageEvent, "stage" | "status" | "startedAtMs"> = {}): StageEvent => {
    if (!stageStartTimes.has(stage)) stageStartTimes.set(stage, Date.now());
    return { stage, status: "active", startedAtMs: stageStartTimes.get(stage), ...extra };
  };

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
  emit({ stage: "fetch", status: "done", message: `${playerLeft.nickname} vs ${playerRight.nickname}` });

  const outDir = path.join(config.mediaDir, String(matchId));
  const pathFor = (nickname: string) => path.join(outDir, `${nickname}.mp4`);

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
    emit({ stage: "download", status: "done", percent: 100, message: "reused cached downloads" });
  } else {
    windows = await downloadMatchVods(
      match,
      outDir,
      (p) =>
        emit(
          active("download", {
            percent: Math.round(((p.index + p.percent / 100) / p.total) * 100),
            message: `${p.playerNickname} (${p.index + 1}/${p.total}): ${p.percent.toFixed(0)}%`,
          }),
        ),
      signal,
    );
    emit({ stage: "download", status: "done", percent: 100 });
  }

  const leftWindow = windows.find((w) => w.playerUuid === playerLeft.uuid);
  const rightWindow = windows.find((w) => w.playerUuid === playerRight.uuid);
  if (!leftWindow || !rightWindow) {
    throw new Error("Downloaded windows don't match players[0]/players[1].");
  }

  emit(active("sync"));
  let rightOffsetSec = rightWindow.matchOffsetIntoClipSec;
  try {
    const sync = await computeSyncOffset(
      leftWindow.path,
      rightWindow.path,
      leftWindow.matchOffsetIntoClipSec,
      rightWindow.matchOffsetIntoClipSec,
      signal,
    );
    if (sync.confidence >= config.syncConfidenceThreshold) {
      rightOffsetSec = sync.clipBCueTimeSec;
      emit({ stage: "sync", status: "done", message: `confidence ${sync.confidence.toFixed(3)} (refined)` });
    } else {
      emit({
        stage: "sync",
        status: "done",
        message: `confidence ${sync.confidence.toFixed(3)} (too low, kept coarse offset)`,
      });
    }
  } catch (err) {
    emit({ stage: "sync", status: "done", message: `refinement failed: ${(err as Error).message}` });
  }

  const overlayPath = path.join(outDir, "overlay.mov");
  if (existsSync(overlayPath)) {
    emit({ stage: "render", status: "done", percent: 100, message: "reused existing render" });
  } else {
    emit(active("render", { percent: 0 }));
    await renderOverlay({
      match,
      userLeft,
      userRight,
      versus,
      outPath: overlayPath,
      signal,
      onProgress: (p) =>
        emit(
          active("render", {
            percent: p.percent,
            message: `${p.phase}: ${p.percent}%`,
          }),
        ),
    });
    emit({ stage: "render", status: "done", percent: 100 });
  }

  const thumbnailPath = path.join(outDir, "thumbnail.png");
  if (existsSync(thumbnailPath)) {
    emit({ stage: "thumbnail", status: "done", message: "reused existing render" });
  } else {
    emit(active("thumbnail"));
    await renderThumbnail({ match, userLeft, userRight, outPath: thumbnailPath, signal });
    emit({ stage: "thumbnail", status: "done" });
  }

  emit(active("write"));
  const [leftDurationSec, rightDurationSec, overlayDurationSec] = await Promise.all([
    probeDurationSec(leftWindow.path, signal),
    probeDurationSec(rightWindow.path, signal),
    probeDurationSec(overlayPath, signal),
  ]);

  const leftClip: KdenliveClipInput = {
    path: path.resolve(leftWindow.path),
    durationSec: leftDurationSec,
    matchOffsetIntoClipSec: leftWindow.matchOffsetIntoClipSec,
    clipName: `${leftWindow.playerNickname} POV`,
  };
  const rightClip: KdenliveClipInput = {
    path: path.resolve(rightWindow.path),
    durationSec: rightDurationSec,
    matchOffsetIntoClipSec: rightOffsetSec,
    clipName: `${rightWindow.playerNickname} POV`,
  };
  const overlayClip: KdenliveClipInput = {
    path: path.resolve(overlayPath),
    durationSec: overlayDurationSec,
    // Not PRE_ROLL_SEC: the overlay renders only a short lead-in before the timer starts,
    // so it begins later on the timeline than the VOD clips do (see overlayRender.ts).
    matchOffsetIntoClipSec: config.overlayLeadInSec,
    clipName: "Stat Overlay",
  };

  // Marker positions use the same maxOffset-relative math buildKdenliveProject's buildTrack
  // uses to place each clip on the timeline, so markers land in sync with the actual footage.
  const maxOffset = Math.max(
    leftClip.matchOffsetIntoClipSec,
    rightClip.matchOffsetIntoClipSec,
    overlayClip.matchOffsetIntoClipSec,
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

  const projectXml = buildKdenliveProject({
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    leftClip,
    rightClip,
    overlayClip,
    projectName: `Match ${matchId} - ${leftWindow.playerNickname} vs ${rightWindow.playerNickname}`,
    markers,
  });

  const projectPath = path.join(outDir, `match-${matchId}.kdenlive`);
  await writeFile(projectPath, projectXml, "utf8");
  emit({ stage: "write", status: "done" });

  return { matchId, projectPath: path.resolve(projectPath), thumbnailPath: path.resolve(thumbnailPath) };
}
