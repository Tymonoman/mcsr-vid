/**
 * The dashboard's export endpoints: the headless encode, its progress, and the files it makes.
 *
 * Split from server.ts for size, like youtubeRoutes.ts. Transport only; the encode lives in
 * src/pipeline/exportFast.ts (ffmpeg). The Kdenlive round-trip (upload the cut project, melt it here)
 * was retired unused — the GET for the project stays, for a match that needs a human.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describeError } from "../errorText.js";
import { assembleSeries } from "../playoffs/series.js";
import { sendVideo } from "./rangeStream.js";
import { matchStatusFor } from "./matchStatus.js";
import { inPublishSet } from "./publishSet.js";
import { findExportedVideo } from "../youtube/youtubeStore.js";
import { ensurePick } from "./shortFlow.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

export interface ExportRouteContext {
  json: Json;
  readBody: (req: IncomingMessage) => Promise<string>;
  matchDir: (matchId: number) => string;
  parseId: (raw: string | undefined) => number | null;
}

/** One encode in flight. Lines are retained so a browser joining late replays the whole run. */
export interface ExportJob {
  matchId: number;
  lines: string[];
  percent: number;
  done: boolean;
  error: string | null;
  subscribers: Set<ServerResponse>;
  proc: ChildProcess;
  /** Settles when the encode does, with `error` — the nightly awaits this, the browser polls. */
  finished: Promise<string | null>;
  /** Output length the fast export announces up front; 0 until it has. */
  totalSec: number;
}

/** The fast export's opening line names the output length: `ffmpeg: 11 split stills, 597.1s at 60fps, ...`. */
export function announcedTotalSec(line: string): number | null {
  const m = /^ffmpeg: .*?\b(\d+(?:\.\d+)?)s at \d+fps/.exec(line);
  return m ? Number(m[1]) : null;
}

/**
 * The percentage one log line reports, or null for a line that is not progress. ffmpeg's
 * `-stats` line carries `time=HH:MM:SS.ss` of output written, which is a percentage only against
 * the total the fast export announced. Capped at 99 — the promote-on-success rename is what
 * makes it 100.
 */
export function percentOf(line: string, totalSec: number): number | null {
  const at = /\btime=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!at || totalSec <= 0) return null;
  const secs = Number(at[1]) * 3600 + Number(at[2]) * 60 + Number(at[3]);
  return Math.min(99, Math.floor((secs / totalSec) * 100));
}

const jobs = new Map<number, ExportJob>();

/** An export writing into this match's directory right now. */
export const exportRunning = (matchId: number): boolean => jobs.get(matchId)?.done === false;

const projectPath = (dir: string, matchId: number) => path.join(dir, `match-${matchId}.kdenlive`);
const finalPath = (dir: string) => path.join(dir, "final.mp4");

function broadcast(job: ExportJob, payload: unknown): void {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of job.subscribers) res.write(frame);
}

/** The headless encode: one ffmpeg pass, VAAPI, writes final-<id>.mp4 (see CLAUDE.md). */
const fastArgv = (matchId: number) => ["npm", "run", "--silent", "export:fast", "--", String(matchId)];

/**
 * The encode, from the button or the nightly. One job table, so the browser's progress panel
 * shows either running, the delete guard holds while it writes, and the preview finds the file
 * the moment it lands.
 */
export function startFastExport(matchId: number): ExportJob {
  const existing = jobs.get(matchId);
  // Concurrency 1 per match falls out of this. Two *different* matches encoding at once would
  // contend for the lab's four cores; if that ever actually happens, a lock in exportFast.ts is
  // the fix rather than a scheduler here.
  if (existing && !existing.done) return existing;

  const [cmd, ...args] = fastArgv(matchId) as [string, ...string[]];
  const proc = spawn(cmd, args, {
    cwd: path.resolve(new URL("../..", import.meta.url).pathname),
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group: the argv is `npm run`, and a SIGTERM to npm alone left the tsx and
    // ffmpeg underneath it encoding for the rest of the hour. Stop kills the group (`-pid`).
    detached: true,
  });

  let settleExport!: (error: string | null) => void;
  const job: ExportJob = {
    matchId,
    lines: [],
    percent: 0,
    done: false,
    error: null,
    subscribers: new Set(),
    proc,
    finished: new Promise((resolve) => (settleExport = resolve)),
    totalSec: 0,
  };
  // A playoff game's export may complete its series (src/playoffs/series.ts): joined here, the one place
  // every export settles — the nightly's chain, the Re-encode button, a series run. Anything
  // but a full series is a no-op; a failed join is a log line and the export stands.
  // Then the model picks the Short's moment from the finished video: the match's own, or the
  // series' once its last game is in — queued before `finished` settles, so the nightly can wait
  // for it. A match that already has a pick keeps it (src/dashboard/shortFlow.ts `ensurePick`).
  const settle = (error: string | null): void => {
    if (error !== null) return settleExport(error);
    assembleSeries(matchId)
      .then((r) => {
        if (r.kind === "joined") console.error(`series ${r.firstGameId}: joined (${r.games.length} games)`);
        const pickFor =
          r.kind === "not-a-series"
            ? matchId
            : r.kind === "joined" || r.kind === "current"
              ? r.firstGameId
              : null;
        if (pickFor !== null) void ensurePick(pickFor);
      })
      .catch((err: unknown) =>
        console.error(`series: join after export ${matchId} failed — ${describeError(err)}`),
      )
      .finally(() => settleExport(null));
  };
  jobs.set(matchId, job);

  const consume = (chunk: Buffer) => {
    for (const raw of chunk.toString("utf8").split(/\r?\n|\r/)) {
      const line = raw.trim();
      if (line === "") continue;
      // ffmpeg reports every second; a long encode is thousands of those. Keep the percentage,
      // drop the noise.
      job.totalSec = announcedTotalSec(line) ?? job.totalSec;
      const pct = percentOf(line, job.totalSec);
      if (pct !== null) {
        if (pct !== job.percent) {
          job.percent = pct;
          broadcast(job, { percent: pct });
        }
        continue;
      }
      job.lines.push(line);
      if (job.lines.length > 200) job.lines.shift();
      broadcast(job, { line });
    }
  };

  proc.stdout?.on("data", consume);
  proc.stderr?.on("data", consume);

  proc.on("close", (code) => {
    job.done = true;
    // 137 is the OOM killer. The browser shows status rather than the log tail, so the
    // distinction has to survive up to here.
    // A null code is a signal — the Stop button, or a restart — not a broken encode.
    if (code === null) job.error = "stopped";
    else if (code !== 0) {
      job.error = code === 137 ? "killed by the OOM killer" : `export failed (exit ${code})`;
    }
    broadcast(job, { done: true, error: job.error, percent: job.error ? job.percent : 100 });
    for (const res of job.subscribers) res.end();
    job.subscribers.clear();
    settle(job.error);
  });

  proc.on("error", (err) => {
    job.done = true;
    job.error = describeError(err);
    broadcast(job, { done: true, error: job.error });
    for (const res of job.subscribers) res.end();
    job.subscribers.clear();
    settle(job.error);
  });

  return job;
}

/** Stops a running encode: the whole group, so ffmpeg goes with the npm that started it. */
function stopExport(matchId: number): void {
  const job = jobs.get(matchId);
  if (!job || job.done || job.proc.pid === undefined) return;
  try {
    process.kill(-job.proc.pid, "SIGTERM");
  } catch {
    // Already gone; `close` is on its way.
  }
}

/**
 * The finished video for a match, whichever way it was produced, or null.
 *
 * `npm run export:fast` writes final-<id>.mp4; the retired melt path wrote final.mp4 (older
 * matches still have one); and an export cut by hand in Kdenlive can be named anything.
 * findExportedVideo already encodes that last rule (any video in the folder that is not a POV
 * clip or a render intermediate), so this defers to it rather than growing a second list of
 * names to keep in sync.
 */
export async function locateExport(matchId: number, dir: string): Promise<string | null> {
  const canonical = finalPath(dir);
  if (existsSync(canonical)) return canonical;
  try {
    const status = await matchStatusFor(matchId);
    const located = findExportedVideo(matchId, [status.leftNickname, status.rightNickname]);
    return "error" in located ? null : located.path;
  } catch {
    // The MCSR API being down must not stop you watching a file that is already on disk.
    return null;
  }
}

export async function handleExportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  ctx: ExportRouteContext,
): Promise<boolean> {
  const [, resource, action, idRaw] = segments;
  if (resource !== "export") return false;

  const matchId = ctx.parseId(idRaw);
  if (matchId === null) {
    ctx.json(res, 400, { error: "bad match id" });
    return true;
  }
  const dir = ctx.matchDir(matchId);

  // The generated project, for a match that needs a human in Kdenlive.
  if (action === "project" && req.method === "GET") {
    const file = projectPath(dir, matchId);
    if (!existsSync(file)) {
      ctx.json(res, 404, { error: "no project for that match" });
      return true;
    }
    res.writeHead(200, {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="match-${matchId}.kdenlive"`,
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
    return true;
  }

  // The headless encode from the browser: what the nightly does for its own pick, for any
  // rendered match the operator wants today. The preview panel had told the operator to "run
  // the export, then reload" for months without offering a way to run one.
  if (action === "fast" && req.method === "POST") {
    if (!existsSync(path.join(dir, "overlay-timer.mp4"))) {
      ctx.json(res, 404, { error: "not rendered yet — the encode needs the overlays" });
      return true;
    }
    const job = startFastExport(matchId);
    ctx.json(res, 202, { matchId, running: !job.done });
    return true;
  }

  // Stop: the fast encode is the only one left, so its DELETE sits under the same name.
  if (action === "fast" && req.method === "DELETE") {
    stopExport(matchId);
    ctx.json(res, 200, { matchId, aborted: true });
    return true;
  }

  if (action === "progress" && req.method === "GET") {
    const job = jobs.get(matchId);
    if (!job) {
      ctx.json(res, 404, { error: "no export for that match" });
      return true;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    // Replay first: an encode runs for the best part of an hour, so a phone whose screen locked
    // must not rejoin blind partway through.
    for (const line of job.lines) res.write(`data: ${JSON.stringify({ line })}\n\n`);
    res.write(`data: ${JSON.stringify({ percent: job.percent })}\n\n`);
    if (job.done) {
      res.write(`data: ${JSON.stringify({ done: true, error: job.error })}\n\n`);
      res.end();
      return true;
    }
    job.subscribers.add(res);
    req.on("close", () => job.subscribers.delete(res));
    return true;
  }

  // Download. Whatever the export produced is found the same way the upload panel finds it, so
  // `npm run export:fast` output (final-<id>.mp4) is offered here rather than reading as "not
  // exported yet".
  if (action === "final" && req.method === "GET") {
    const file = await locateExport(matchId, dir);
    if (file === null) {
      ctx.json(res, 404, { error: "not exported yet" });
      return true;
    }
    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-disposition": `attachment; filename="match-${matchId}.mp4"`,
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
    return true;
  }

  // The whole publish set as one file, for a PC with no ssh to pull with (src/dashboard/publishSet.ts).
  // Uncompressed: the MP4s are already compressed, so gzip would only make the operator wait.
  if (action === "bundle" && req.method === "GET") {
    const file = await locateExport(matchId, dir);
    if (file === null) {
      ctx.json(res, 404, { error: "not exported yet" });
      return true;
    }
    // A hand-named export is in the bundle under its own name — locateExport already knows how
    // to find it, and the pattern list cannot.
    const names = readdirSync(dir)
      .filter((name) => name === path.basename(file) || inPublishSet(matchId, name))
      .sort();
    res.writeHead(200, {
      "content-type": "application/x-tar",
      "content-disposition": `attachment; filename="replayoffs-${matchId}.tar"`,
      "cache-control": "no-store",
    });
    const tar = spawn("tar", ["-C", dir, "-cf", "-", ...names], { stdio: ["ignore", "pipe", "inherit"] });
    tar.stdout.pipe(res);
    // A browser that cancels the download leaves tar writing into a closed socket.
    req.on("close", () => tar.kill());
    return true;
  }

  // Playback. Separate from `final` because the two want opposite headers: a download wants
  // `attachment` and may stream straight through, while a <video> needs `inline` and byte
  // ranges or it cannot seek and re-fetches the whole ~800 MB file on every scrub.
  if (action === "preview" && (req.method === "GET" || req.method === "HEAD")) {
    const file = await locateExport(matchId, dir);
    if (file === null) {
      ctx.json(res, 404, { error: "not exported yet" });
      return true;
    }
    await sendVideo(req, res, file, `match-${matchId}.mp4`);
    return true;
  }

  // Which export exists, and how big it is — so the dashboard can show a player without
  // guessing at a URL that 404s.
  if (action === "preview-meta" && req.method === "GET") {
    // An encode in flight is part of the answer: the panel shows its bar rather than a button
    // that would start a second one (startExport would hand back the same job, but the operator
    // cannot know that).
    const job = jobs.get(matchId);
    const running = job !== undefined && !job.done;
    const file = await locateExport(matchId, dir);
    if (file === null) {
      ctx.json(res, 200, { exported: false, running, percent: running ? job.percent : 0 });
      return true;
    }
    const { size } = await stat(file);
    ctx.json(res, 200, { exported: true, name: path.basename(file), bytes: size, running });
    return true;
  }

  return false;
}
