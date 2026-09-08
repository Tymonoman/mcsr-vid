/**
 * The dashboard's export endpoints: the desktop round-trip.
 *
 * The lab renders the assets, you cut in Kdenlive on the desktop, and the lab encodes the
 * finished MP4 — so the project file has to travel both ways. Split from server.ts for the same
 * reason as youtubeRoutes.ts: that file is at the 500-line cap. Transport only; the encode
 * itself lives in scripts/export.sh.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describeError } from "./errorText.js";
import { sendVideo } from "./rangeStream.js";
import { matchStatusFor } from "./matchStatus.js";
import { findExportedVideo } from "./youtubeStore.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

export interface ExportRouteContext {
  json: Json;
  readBody: (req: IncomingMessage) => Promise<string>;
  matchDir: (matchId: number) => string;
  parseId: (raw: string | undefined) => number | null;
}

/**
 * Kdenlive saved the project on the desktop, so `root` points at a path that does not exist on
 * the lab. Rewriting that one attribute relocates the whole timeline — which is the entire
 * reason kdenliveProject.ts emits `root` with relative resources.
 */
export function relocateRoot(xml: string, dir: string): string {
  return xml.replace(/(<mlt\b[^>]*?\broot=")[^"]*(")/, `$1${dir}$2`);
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
  /** Output length the fast export announces up front; 0 until it has, and always for melt. */
  totalSec: number;
}

/** The fast export's opening line names the output length: `ffmpeg: 11 split stills, 597.1s at 60fps, ...`. */
export function announcedTotalSec(line: string): number | null {
  const m = /^ffmpeg: .*?\b(\d+(?:\.\d+)?)s at \d+fps/.exec(line);
  return m ? Number(m[1]) : null;
}

/**
 * The percentage one log line reports, or null for a line that is not progress. Two formats:
 * melt says `percentage: N` outright; ffmpeg's `-stats` line carries `time=HH:MM:SS.ss` of
 * output written, which is a percentage only against the total the fast export announced.
 * Capped at 99 — the promote-on-success rename is what makes it 100.
 */
export function percentOf(line: string, totalSec: number): number | null {
  const melt = /percentage:\s*(\d+)/.exec(line);
  if (melt) return Number(melt[1]);
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

/** The desktop round-trip's encode: melt over the (cut) project, via scripts/export.sh. */
const meltArgv = (matchId: number, dir: string) => [
  "bash",
  "scripts/export.sh",
  projectPath(dir, matchId),
  finalPath(dir),
];

/** The headless encode: one ffmpeg pass, VAAPI, writes final-<id>.mp4 (see CLAUDE.md). */
const fastArgv = (matchId: number) => ["npm", "run", "--silent", "export:fast", "--", String(matchId)];

function startExport(matchId: number, dir: string, argv = meltArgv(matchId, dir)): ExportJob {
  const existing = jobs.get(matchId);
  // Concurrency 1 per match falls out of this. Two *different* matches encoding at once would
  // contend for the lab's two cores; if that ever actually happens, flock in export.sh is the
  // fix rather than a scheduler here.
  if (existing && !existing.done) return existing;

  const [cmd, ...args] = argv as [string, ...string[]];
  const proc = spawn(cmd, args, {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let settle!: (error: string | null) => void;
  const job: ExportJob = {
    matchId,
    lines: [],
    percent: 0,
    done: false,
    error: null,
    subscribers: new Set(),
    proc,
    finished: new Promise((resolve) => (settle = resolve)),
    totalSec: 0,
  };
  jobs.set(matchId, job);

  const consume = (chunk: Buffer) => {
    for (const raw of chunk.toString("utf8").split(/\r?\n|\r/)) {
      const line = raw.trim();
      if (line === "") continue;
      // melt reports every single frame, ffmpeg every second; an hour-long encode is tens of
      // thousands of those. Keep the percentage, drop the noise.
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
    // 137 is the OOM killer. export.sh already says so on stderr, but the browser shows status
    // rather than the log tail, so the distinction has to survive up to here too.
    if (code !== 0) {
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

/**
 * The encode for a render nobody will cut by hand — the nightly's. Same job table as the
 * button's export, so the browser's progress panel shows it running, the delete guard holds
 * while it writes, and the preview finds the file the moment it lands.
 */
export function startFastExport(matchId: number, dir: string): ExportJob {
  return startExport(matchId, dir, fastArgv(matchId));
}

/**
 * The finished video for a match, whichever way it was produced, or null.
 *
 * scripts/export.sh writes final.mp4; `npm run export:fast` writes final-<id>.mp4; and an export
 * cut by hand in Kdenlive can be named anything. findExportedVideo already encodes that last
 * rule (any video in the folder that is not a POV clip or a render intermediate), so this defers
 * to it rather than growing a second list of names to keep in sync.
 */
async function locateExport(matchId: number, dir: string): Promise<string | null> {
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

  // Pull the generated project down to cut it.
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

  // Send the cut project back.
  if (action === "project" && req.method === "POST") {
    const body = await ctx.readBody(req);
    // Untrusted input: this is written to disk and then handed to melt. Refusing anything that
    // is not an MLT document costs nothing compared with discovering it 50 minutes into an
    // encode.
    if (!/^\s*<\?xml/.test(body) || !body.includes("<mlt")) {
      ctx.json(res, 400, { error: "not an MLT/Kdenlive project" });
      return true;
    }
    // Absolute, always. matchDir is only absolute when config.mediaDir is (it is on the lab,
    // "/media"; it is not on a desktop checkout, where it defaults to "media"). A relative root
    // resolves against whatever cwd Kdenlive or melt happens to have, which is how a project
    // opens with every clip offline.
    const root = path.resolve(dir);
    const relocated = relocateRoot(body, root);
    await writeFile(projectPath(dir, matchId), relocated, "utf8");
    ctx.json(res, 200, { matchId, root, rewritten: relocated !== body });
    return true;
  }

  if (action === "run" && req.method === "POST") {
    if (!existsSync(projectPath(dir, matchId))) {
      ctx.json(res, 404, { error: "no project for that match — upload the cut one first" });
      return true;
    }
    const job = startExport(matchId, dir);
    ctx.json(res, 202, { matchId, running: !job.done });
    return true;
  }

  if (action === "run" && req.method === "DELETE") {
    jobs.get(matchId)?.proc.kill("SIGTERM");
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

  // Download. `finalPath` is where scripts/export.sh writes; anything else the export produced
  // is found the same way the upload panel finds it, so `npm run export:fast` output
  // (final-<id>.mp4) is offered here too rather than reading as "not exported yet".
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
    const file = await locateExport(matchId, dir);
    if (file === null) {
      ctx.json(res, 200, { exported: false });
      return true;
    }
    const { size } = await stat(file);
    ctx.json(res, 200, { exported: true, name: path.basename(file), bytes: size });
    return true;
  }

  return false;
}
