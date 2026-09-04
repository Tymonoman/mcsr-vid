/**
 * One place to turn a thrown value into text a human can act on.
 *
 * Every call site in this project used to write `(err as Error).message` inline, which throws
 * away three things that matter when a render fails on a headless box you are not sitting at:
 * the HTTP status on `McsrApiError` (nothing read it, so a rate-limit looked like any other
 * failure), the `cause` chain, and non-Error throws. The child processes deliberately build
 * multi-line messages — yt-dlp attaches a 4 KB stderr tail, ffmpeg the last 500 chars — so
 * nothing here truncates; the dashboard renders the result in a <pre>.
 */
import { McsrApiError } from "./mcsrApi.js";

/** 429 is the one status worth naming: it means wait, not retry harder. */
function apiHint(status: number): string {
  if (status === 429) return " — rate limited by the MCSR API (500 requests per 10 minutes)";
  if (status === 404) return " — no such match or player";
  if (status >= 500) return " — the MCSR API is having problems, not you";
  return "";
}

export function describeError(err: unknown): string {
  if (err instanceof McsrApiError) return `${err.message}${apiHint(err.status)}`;

  if (err instanceof Error) {
    // An AbortError reaching here means a stage was cancelled; say so in words rather than
    // leaking Node's "The operation was aborted" through a failure-shaped message.
    if (err.name === "AbortError") return "aborted";
    const cause = err.cause === undefined ? "" : `\ncaused by: ${describeError(err.cause)}`;
    return `${err.message}${cause}`;
  }

  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    // A throw of something circular or exotic. Better than the empty string a template
    // literal would produce.
    return String(err);
  }
}
