// Self-check: creator watch never puts a DNF (a forfeit, or no winner on record — what a feed entry
// shows) at the front of tonight's queue; a finished match of the same name still goes.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/dashboard/creatorWatch.dnf.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { FeedMatch, MatchInfo } from "../api/types.js";
import { isWatchCandidate } from "./creatorWatch.js";

const {
  timelines: _t,
  completions: _c,
  ...finished
} = JSON.parse(
  readFileSync(new URL("../fixtures/match-12730175.json", import.meta.url), "utf8"),
) as MatchInfo;
const none = new Set<number>();
const ctx = { seen: none, processed: none, hidden: none, queued: none };

assert.equal(isWatchCandidate(finished as FeedMatch, ctx), true, "a finished match is a candidate");
assert.equal(isWatchCandidate({ ...finished, forfeited: true } as FeedMatch, ctx), false, "a forfeit is not");
assert.equal(
  isWatchCandidate({ ...finished, result: { ...finished.result, uuid: null } } as FeedMatch, ctx),
  false,
  "nor a match with no winner",
);
console.log("OK: creator watch passes a DNF by and keeps a finished match");
console.log("creatorWatch.dnf: all checks passed");
