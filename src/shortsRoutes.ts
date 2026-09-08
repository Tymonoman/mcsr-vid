/**
 * The dashboard's Shorts endpoints.
 *
 * Its own job map rather than jobs.ts, following exportRoutes.ts, audit.ts and youtubeRoutes.ts:
 * jobs.ts is keyed by matchId alone, so a Short and a pipeline run on the same match would
 * collide — `startJob` would hand back the render job, and "stop" would abort the wrong one.
 * A fourth small map is zero risk to the render path; unifying them is a refactor for the day
 * something actually needs shared scheduling.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describeError } from "./errorText.js";
import type { ExportRouteContext } from "./exportRoutes.js";
import { getMatch, getUser } from "./mcsrApi.js";
import { distinctShortMoments, SHORT_WINDOW_SEC } from "./shortMoment.js";
import { buildShortHook, resolveShortHookFor } from "./shortHook.js";
import { sendVideo } from "./rangeStream.js";
import { readChatTimes } from "./twitchChat.js";

/** One Short render in flight. Lines are retained so a browser joining late replays the run. */
interface ShortJob {
  matchId: number;
  lines: string[];
  done: boolean;
  error: string | null;
  subscribers: Set<ServerResponse>;
  proc: ChildProcess;
}

const jobs = new Map<number, ShortJob>();

/** A Short render writing into this match's directory right now. */
export const shortRunning = (matchId: number): boolean => jobs.get(matchId)?.done === false;

const shortPath = (dir: string, matchId: number) => path.join(dir, `short-${matchId}.mp4`);

/** The first line of a written file, or null when it is missing — a file nothing wrote yet. */
const firstLine = (file: string): Promise<string | null> =>
  readFile(file, "utf8").then(
    (text) => text.split("\n")[0]!.trim() || null,
    () => null,
  );

function broadcast(job: ShortJob, payload: unknown): void {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of job.subscribers) res.write(frame);
}

/**
 * Spawns the render. Injectable so the route tests can exercise dispatch and input handling
 * without starting seven real renders — which is exactly what the first version of that test
 * did, and it takes minutes per call.
 */
export type ShortRunner = (matchId: number, pick: number) => ChildProcess;

/** The one way a Short is rendered: exported so the nightly job chains this and not a second spawn. */
const spawnShortCli: ShortRunner = (matchId, pick) =>
  // The CLI is the one code path that renders a Short, so the dashboard drives it rather than
  // duplicating the moment-picking and ffmpeg assembly. Same reason exportRoutes shells out to
  // export.sh instead of reimplementing melt's invocation.
  spawn("npm", ["run", "--silent", "short", "--", String(matchId), `--pick=${pick}`], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
  });

/**
 * The runner the nightly chains: the same spawn, registered in this file's job table, so the
 * delete guard refuses and the progress stream answers while the chained Short is writing —
 * exactly as they do for a Short the button started. Bypassing the table left a two-minute
 * window in which DELETE /api/match could remove the directory under the running CLI.
 */
export const spawnShortJob: ShortRunner = (matchId, pick) => startShort(matchId, pick, spawnShortCli).proc;

function startShort(matchId: number, pick: number, run: ShortRunner): ShortJob {
  const existing = jobs.get(matchId);
  if (existing && !existing.done) return existing;

  const proc = run(matchId, pick);

  const job: ShortJob = {
    matchId,
    lines: [],
    done: false,
    error: null,
    subscribers: new Set(),
    proc,
  };
  jobs.set(matchId, job);

  const push = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const text = line.trim();
      if (text === "") continue;
      job.lines.push(text);
      broadcast(job, { line: text });
    }
  };
  proc.stdout?.on("data", push);
  proc.stderr?.on("data", push);

  proc.on("error", (err) => {
    job.error = describeError(err);
  });
  proc.on("close", (code) => {
    job.done = true;
    if (code !== 0 && job.error === null) job.error = `short render exited with code ${code}`;
    broadcast(job, { done: true, error: job.error });
    for (const res of job.subscribers) res.end();
    job.subscribers.clear();
  });

  return job;
}

export async function handleShortsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  ctx: ExportRouteContext,
  run: ShortRunner = spawnShortCli,
): Promise<boolean> {
  const [, resource, action, idRaw] = segments;
  if (resource !== "shorts") return false;

  const matchId = ctx.parseId(idRaw);
  if (matchId === null) {
    ctx.json(res, 400, { error: "bad match id" });
    return true;
  }
  const dir = ctx.matchDir(matchId);

  // Which moments are on offer, and whether one has already been rendered.
  if (action === "moments" && req.method === "GET") {
    try {
      const match = await getMatch(matchId);
      const [left, right] = match.players;
      if (!left || !right) {
        ctx.json(res, 404, { error: "match does not have two players" });
        return true;
      }
      // The same options the CLI cuts with — chat included — or the panel would offer one list
      // and "Cut this" would render another.
      const moments = distinctShortMoments(
        match,
        {
          leftUuid: left.uuid,
          rightUuid: right.uuid,
          runMs: match.result.time || 900_000,
          windowSec: SHORT_WINDOW_SEC,
          chatAtSec: readChatTimes(dir),
        },
        5,
      );

      // What a render would actually burn in, which is usually not the per-moment line: an
      // edited title hook or a ranked suggestion outranks it, and the panel showing the third
      // choice while the render uses the first is how you disagree with a hook you never saw.
      // Resolved for the top moment, the one the panel offers as the default — a lower pick
      // differs only in the fallback, which is the case that loses to both other sources anyway.
      const top = moments[0];
      let hook: string | null = null;
      if (top) {
        const [userLeft, userRight] = await Promise.all([getUser(left.uuid), getUser(right.uuid)]);
        hook = await resolveShortHookFor({ matchId, match, moment: top, userLeft, userRight, matchDir: dir });
      }

      const file = shortPath(dir, matchId);
      ctx.json(res, 200, {
        moments: moments.map((m, index) => ({
          index,
          startMs: m.startMs,
          endMs: m.endMs,
          score: Number(m.score.toFixed(2)),
          reason: m.reason,
          hook: buildShortHook(m, left.nickname, right.nickname),
        })),
        rendered: existsSync(file) ? path.basename(file) : null,
        hook,
        // The title the last render wrote, for the manual upload. Absent until something has
        // been rendered, which is exactly when there is nothing to paste anywhere.
        title: await firstLine(path.join(dir, `short-${matchId}.title.txt`)),
      });
    } catch (err) {
      ctx.json(res, 502, { error: describeError(err) });
    }
    return true;
  }

  // Playback, byte-ranged like the export preview. A Short is ~10 MB rather than ~800 MB, but
  // it still needs ranges: without them a <video> cannot seek, and scrubbing a 30-second clip is
  // the whole point of previewing one.
  if (action === "preview" && (req.method === "GET" || req.method === "HEAD")) {
    const file = shortPath(dir, matchId);
    if (!existsSync(file)) {
      ctx.json(res, 404, { error: "no Short rendered yet" });
      return true;
    }
    await sendVideo(req, res, file, path.basename(file));
    return true;
  }

  if (action === "render" && req.method === "POST") {
    const body = await ctx.readBody(req);
    let pick = 0;
    try {
      const parsed = JSON.parse(body || "{}") as { pick?: unknown };
      // A path is built from this downstream, so it is a trust boundary: coerce to a small
      // non-negative integer rather than passing whatever arrived into a shell argument.
      if (typeof parsed.pick === "number" && Number.isInteger(parsed.pick)) {
        pick = Math.max(0, Math.min(4, parsed.pick));
      }
    } catch {
      // An unparseable body just means "render the best one".
    }
    startShort(matchId, pick, run);
    ctx.json(res, 202, { started: true, pick });
    return true;
  }

  if (action === "progress" && req.method === "GET") {
    const job = jobs.get(matchId);
    if (!job) {
      ctx.json(res, 404, { error: "no short render for that match" });
      return true;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    for (const line of job.lines) res.write(`data: ${JSON.stringify({ line })}\n\n`);
    if (job.done) {
      res.write(`data: ${JSON.stringify({ done: true, error: job.error })}\n\n`);
      res.end();
      return true;
    }
    job.subscribers.add(res);
    res.on("close", () => job.subscribers.delete(res));
    return true;
  }

  return false;
}
