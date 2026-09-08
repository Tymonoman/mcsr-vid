/**
 * One place to turn a thrown value into text a human can act on.
 *
 * Keeps the three things a bare `(err as Error).message` throws away: the HTTP status on
 * `McsrApiError`, the `cause` chain, and non-Error throws. Nothing here truncates, because the
 * child processes attach stderr tails on purpose; the dashboard renders the result in a <pre>.
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
