/**
 * A hand-cut Short (`config.shortsByHand`, 11 Oct 2026 — the operator: "you're gonna make the
 * shorts from now on"): the session watches the match, picks the moment and builds the vertical
 * video itself, outside the pipeline's own render. `buildHandShort` is what turns that finished
 * file into the pair the chain reads (`src/dashboard/shortFlow.ts`) — `short-<id>.mp4` +
 * `short-<id>.hand.json` — plus the same `.title.txt`/`.description.txt` `generateShort.ts`
 * writes, so the upload step cannot tell the two apart. `handShortCli.ts` is its thin CLI.
 */
import { existsSync } from "node:fs";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { SHORT_HEIGHT, SHORT_WIDTH } from "../../remotion/layout.js";
import { getMatch } from "../api/mcsrApi.js";
import type { MatchInfo } from "../api/types.js";
import { blockedIn, config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { playoffContextFor, playoffPhrase } from "../playoffs/playoffs.js";
import { readSeriesRecord } from "../playoffs/series.js";
import { blockedOnDisk } from "../dashboard/matchStatus.js";
import { hookProblem, HOOK_MAX_CHARS } from "./videoPick.js";
import { buildShortDescription, buildShortTitle, TITLE_MAX_CHARS } from "./shortHook.js";
import { shortLog } from "./shortLog.js";
import { shortHookFile } from "./shortPlan.js";

/** What every path waiting on the hand-cut Short says — the chain's log line and `hookRefusal`. */
export const WAITING_FOR_HAND_SHORT = "waiting for the hand-made Short";

/** `short-<id>.hand.json`: what a hand-cut Short is, instead of `generateShort.ts`'s `cut.json`. */
export interface HandShort {
  /** The Short's title hook — passes `hookProblem`, same rule as the model's own suggestion. */
  hook: string;
  builtAt: string;
  /** The window this Short covers, in seconds of the game's match clock. */
  windowMatchSec: [number, number];
  pov: "left" | "right";
  note?: string;
}

export const handShortFile = (dir: string, matchId: number): string =>
  path.join(dir, `short-${matchId}.hand.json`);

/** The hand file, or null (none yet, or unreadable) — read defensively like every other state file here. */
export async function readHandShort(dir: string, matchId: number): Promise<HandShort | null> {
  try {
    return JSON.parse(await readFile(handShortFile(dir, matchId), "utf8")) as HandShort;
  } catch {
    return null;
  }
}

export interface VideoSpec {
  width: number;
  height: number;
  vcodec: string;
  acodec: string;
  durationSec: number;
}

/** ffprobe's own read of a file's first video+audio stream and its duration, or null when either
 *  is missing or the file cannot be read at all — a stand-in file (as the test fixtures use) is
 *  "ffprobe could not read it", same words as a genuinely broken upload. */
export function probeVideo(file: string): Promise<VideoSpec | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height:format=duration",
        "-of",
        "json",
        file,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      try {
        const parsed = JSON.parse(out) as {
          streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
          format?: { duration?: string };
        };
        const video = parsed.streams?.find((s) => s.codec_type === "video");
        const audio = parsed.streams?.find((s) => s.codec_type === "audio");
        const durationSec = Number(parsed.format?.duration);
        resolve(
          video && audio && Number.isFinite(durationSec)
            ? {
                width: video.width ?? 0,
                height: video.height ?? 0,
                vcodec: video.codec_name ?? "",
                acodec: audio.codec_name ?? "",
                durationSec,
              }
            : null,
        );
      } catch {
        resolve(null);
      }
    });
  });
}

export class HandShortRefusal extends Error {}

export interface HandShortOptions {
  mp4Path: string;
  hook: string;
  fromSec: number;
  toSec: number;
  pov: "left" | "right";
  note?: string;
}

type Check =
  | { ok: false; problem: string }
  | { ok: true; match: MatchInfo; left: { nickname: string }; right: { nickname: string }; title: string };

/**
 * Every refusal `buildHandShort` can make, checked before anything is written — cheap/local
 * checks first, so a typo in the hook or a blocked match never spends an ffprobe spawn. Exported
 * so a test can check the exact reason without writing a byte.
 */
export async function checkHandShort(
  matchId: number,
  opts: HandShortOptions,
  probe: typeof probeVideo,
): Promise<Check> {
  const no = (problem: string): Check => ({ ok: false, problem });
  const dir = matchDir(matchId);
  if (!existsSync(dir)) return no(`no working directory for match ${matchId} (${dir})`);
  if (existsSync(path.join(dir, "youtube-short.json")))
    return no(`the Short of ${matchId} is already on the channel — a new cut would need a re-upload`);
  if (!(opts.fromSec >= 0) || !(opts.toSec > opts.fromSec))
    return no("--from must be a whole number of seconds at or above 0, lower than --to");
  if (!existsSync(opts.mp4Path)) return no(`no such file: ${opts.mp4Path}`);

  let match: MatchInfo;
  try {
    match = await getMatch(matchId);
  } catch (err) {
    return no(`the match record could not be read: ${describeError(err)}`);
  }
  const [left, right] = match.players;
  if (!left || !right) return no(`match ${matchId} does not have two players`);
  // The API's pair, and the match's own files (POV clips, chats, title — a renamed runner).
  if (blockedIn([left.nickname, right.nickname]) || blockedOnDisk(dir))
    return no(`match ${matchId} has a blocked player — the Short is not cut`);
  // A series is one video and game 1's directory is the series: the chain and hookRefusal read
  // only that one, so a later game's own directory would wait forever (14 Oct 2026 edge pass).
  // Strict: an unreadable bracket refuses rather than letting a later game through unchecked.
  let ctx: Awaited<ReturnType<typeof playoffContextFor>> = null;
  try {
    ctx = (await readSeriesRecord(dir)) ? null : await playoffContextFor(match, true);
  } catch (err) {
    return no(
      `the playoff bracket could not be read, so a later game cannot be ruled out: ${describeError(err)}`,
    );
  }
  if (ctx && ctx.gameNo > 1)
    return no(
      `match ${matchId} is game ${ctx.gameNo} of a playoff series — register the Short under game 1's id (cutting from this game's footage is fine)`,
    );

  const hook = opts.hook.trim();
  // writeHooks strips these from the dashboard's own Short hook: YouTube refuses < > in a title,
  // and title.txt is one line, so a line break would cut the upload's title at the hook.
  if (/[<>\r\n]/.test(hook))
    return no(
      `"${opts.hook}" has < > or a line break — YouTube refuses < > in a title, and title.txt is one line`,
    );
  const problem = hookProblem(hook, HOOK_MAX_CHARS, match.players);
  if (problem) return no(`"${opts.hook}" ${problem}`);

  const spec = await probe(opts.mp4Path);
  if (!spec) return no(`ffprobe could not read a video+audio stream from ${opts.mp4Path}`);
  if (spec.width !== SHORT_WIDTH || spec.height !== SHORT_HEIGHT)
    return no(
      `${opts.mp4Path} is ${spec.width}x${spec.height} — a Short must be ${SHORT_WIDTH}x${SHORT_HEIGHT}`,
    );
  if (spec.vcodec !== "h264" || spec.acodec !== "aac")
    return no(`${opts.mp4Path} is ${spec.vcodec}+${spec.acodec} video+audio — a Short must be h264+aac`);
  if (spec.durationSec > 60)
    return no(`${opts.mp4Path} runs ${spec.durationSec.toFixed(1)}s — a Short must be 60s or shorter`);

  const title = buildShortTitle(hook, left.nickname, right.nickname);
  if (title.length > TITLE_MAX_CHARS)
    return no(`the Short's title would be ${title.length} characters (YouTube's cap is ${TITLE_MAX_CHARS})`);

  return { ok: true, match, left, right, title };
}

export interface HandShortSeams {
  probe?: typeof probeVideo;
  now?: () => Date;
}

/**
 * `npm run short:hand`'s own logic (`handShortCli.ts` is the thin argv wrapper): validates
 * (`checkHandShort`), then copies the file into place atomically (`.tmp` + rename) and writes the
 * title/description the same way `generateShort.ts` does, so the upload step's `uploadTextFor`
 * cannot tell a hand-cut Short from a rendered one. Throws `HandShortRefusal` with the operator-
 * facing reason on any check; writes nothing until every check has passed.
 */
export async function buildHandShort(
  matchId: number,
  opts: HandShortOptions,
  seams: HandShortSeams = {},
): Promise<{ outPath: string; title: string }> {
  const check = await checkHandShort(matchId, opts, seams.probe ?? probeVideo);
  if (!check.ok) throw new HandShortRefusal(check.problem);
  const { match, left, right, title } = check;
  const dir = matchDir(matchId);

  const outPath = path.join(dir, `short-${matchId}.mp4`);
  const tmpPath = `${outPath}.tmp`;
  await copyFile(opts.mp4Path, tmpPath);
  await rename(tmpPath, outPath);

  await writeFile(path.join(dir, `short-${matchId}.title.txt`), `${title}\n`, "utf8");
  // The saved Short hook follows the Short that ships, so the plan screen and every reader agree
  // with it (15 Oct 2026: 13140492's hook.txt kept the pick's spoiler under a clean hand Short).
  // Only over a hook already saved, and only in hand mode: a new file would mark the hooks saved
  // behind the operator, and outside hand mode a changed hook re-cuts over this mp4 (shortFlow.ts).
  const hookFile = shortHookFile(dir, matchId);
  if (config.shortsByHand && existsSync(hookFile)) await writeFile(hookFile, `${opts.hook.trim()}\n`, "utf8");

  // The same description builder generateShort.ts uses, so "the whole match" link etc. are
  // identical — a series' Short points at the whole series, a playoff game's names the round.
  // `matchId` is always game 1 here (`checkHandShort` refuses a later game's id, wherever the
  // footage came from): `match` already is its own nickname spelling, nothing further to fetch.
  const series = await readSeriesRecord(dir);
  const playoff = series ? null : await playoffContextFor(match);
  await writeFile(
    path.join(dir, `short-${matchId}.description.txt`),
    buildShortDescription(
      matchId,
      left.nickname,
      right.nickname,
      config.youtubePlaylistUrl,
      config.supportUrl,
      series
        ? playoffPhrase(series.season, series.round)
        : playoff
          ? playoffPhrase(playoff.season, playoff.round, playoff.gameNo)
          : undefined,
      match.season,
      series ? "series" : "match",
    ),
    "utf8",
  );

  const hook = opts.hook.trim();
  const hand: HandShort = {
    hook,
    builtAt: (seams.now?.() ?? new Date()).toISOString(),
    windowMatchSec: [opts.fromSec, opts.toSec],
    pov: opts.pov,
    ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
  };
  // Atomic, like every other state file here (updateStatus, short-<id>.status.json): a kill
  // mid-write must never leave a truncated file for readHandShort to trip over.
  const handFile = handShortFile(dir, matchId);
  const handTmp = `${handFile}.tmp`;
  await writeFile(handTmp, JSON.stringify(hand, null, 2), "utf8");
  await rename(handTmp, handFile);

  shortLog(matchId, "render", `hand-made Short built, ${opts.pov}: ${JSON.stringify(hook)}`, {
    detail: `window ${opts.fromSec}s–${opts.toSec}s of the match clock; source ${opts.mp4Path}`,
  });
  return { outPath, title };
}
