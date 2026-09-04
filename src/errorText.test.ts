import assert from "node:assert/strict";
import { describeError } from "./errorText.js";
import { McsrApiError } from "./mcsrApi.js";

// The whole reason McsrApiError carries a status: nothing in the project read it, so being
// rate-limited looked exactly like any other failure and you retried into the same wall.
assert.match(describeError(new McsrApiError("MCSR Ranked API /matches/1 -> 429", 429)), /rate limited/);
assert.match(describeError(new McsrApiError("MCSR Ranked API /matches/1 -> 404", 404)), /no such match/);
assert.match(describeError(new McsrApiError("MCSR Ranked API /matches/1 -> 503", 503)), /not you/);
// A status with no specific advice adds nothing rather than inventing a hint.
assert.equal(describeError(new McsrApiError("teapot", 418)), "teapot");

// yt-dlp attaches a 4 KB stderr tail and ffmpeg the last 500 chars, deliberately. Truncating
// here would throw away the only evidence of why a download died on a headless box.
const multiline = new Error("yt-dlp exited with code 1 (args: --download-sections)\nERROR: unable to\nfetch");
assert.equal(describeError(multiline).split("\n").length, 3);
assert.match(describeError(multiline), /ERROR: unable to/);

// An abort is a deliberate stop, not a failure; Node's own wording reads like a crash.
const aborted = new Error("The operation was aborted");
aborted.name = "AbortError";
assert.equal(describeError(aborted), "aborted");

// cause chains survive, because the useful sentence is usually the innermost one.
const wrapped = new Error("render failed", { cause: new Error("chrome-headless-shell died") });
assert.match(describeError(wrapped), /render failed/);
assert.match(describeError(wrapped), /caused by: chrome-headless-shell died/);

// Non-Error throws used to stringify to "[object Object]" or vanish into an empty template slot.
assert.equal(describeError("plain string"), "plain string");
assert.equal(describeError({ code: "ENOENT" }), '{"code":"ENOENT"}');
const circular: Record<string, unknown> = {};
circular.self = circular;
assert.equal(typeof describeError(circular), "string");

console.log("errorText: all checks passed");
