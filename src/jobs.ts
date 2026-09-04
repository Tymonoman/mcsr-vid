/**
 * Pipeline runs in flight, and the SSE plumbing that reports them.
 *
 * Lifted out of server.ts to keep that file under the 500-line cap as it grows a route group
 * per dashboard feature. Nothing here decides anything: it starts `runPipeline`, retains its
 * events, and fans them out.
 *
 * Events are retained rather than streamed-and-forgotten so a browser that connects late — or
 * reconnects from a phone after the screen locked — replays the whole run instead of joining
 * blind partway through an hour-long render.
 */
import type { ServerResponse } from "node:http";
import { describeError } from "./errorText.js";
import { runPipeline, type StageEvent, type StageId } from "./pipeline.js";

export interface Job {
  matchId: number;
  events: StageEvent[];
  done: boolean;
  /** Failure text, or null when the run succeeded *or* was deliberately aborted. */
  error: string | null;
  /** Which stage the failure belongs to, so the browser can mark that row rather than guess. */
  errorStage: StageId | null;
  /** A deliberate stop via DELETE /api/render/:id, which is not a failure. */
  aborted: boolean;
  subscribers: Set<ServerResponse>;
  controller: AbortController;
}

const jobs = new Map<number, Job>();

export const getJob = (matchId: number): Job | undefined => jobs.get(matchId);

export function abortJob(matchId: number): void {
  jobs.get(matchId)?.controller.abort();
}

export function startJob(matchId: number): Job {
  const existing = jobs.get(matchId);
  if (existing && !existing.done) return existing;

  const controller = new AbortController();
  const job: Job = {
    matchId,
    events: [],
    done: false,
    error: null,
    errorStage: null,
    aborted: false,
    subscribers: new Set(),
    controller,
  };
  jobs.set(matchId, job);

  const push = (event: StageEvent) => {
    job.events.push(event);
    // The pipeline names the stage that died, so the browser can colour that row instead of
    // dumping a multi-KB stderr tail into a one-line status field.
    if (event.status === "error") job.errorStage = event.stage;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of job.subscribers) res.write(frame);
  };

  runPipeline(String(matchId), { onEvent: push, signal: controller.signal })
    .then(() => {
      job.done = true;
    })
    .catch((err: unknown) => {
      job.done = true;
      // Aborting rejects the same promise a real failure does, so without this check pressing
      // Stop reported "failed: The operation was aborted" and read as a crash.
      job.aborted = controller.signal.aborted;
      job.error = job.aborted ? null : describeError(err);
    })
    .finally(() => {
      for (const res of job.subscribers) {
        res.write(endFrame(job));
        res.end();
      }
      job.subscribers.clear();
    });

  return job;
}

function endFrame(job: Job): string {
  const payload = { error: job.error, stage: job.errorStage, aborted: job.aborted };
  return `event: end\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function streamProgress(res: ServerResponse, job: Job): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    // Proxies buffer SSE into uselessness; harmless when nothing proxies us.
    "x-accel-buffering": "no",
  });

  // Replay first, so a late or reconnecting client sees the whole run.
  for (const event of job.events) res.write(`data: ${JSON.stringify(event)}\n\n`);

  if (job.done) {
    res.write(endFrame(job));
    res.end();
    return;
  }

  job.subscribers.add(res);
  res.on("close", () => job.subscribers.delete(res));
}
