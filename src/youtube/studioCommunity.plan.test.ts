// Pure checks for the community poll (src/youtube/studioCommunity.ts): what one poll says, which
// long-forms one cycle polls, and the failure streak behind "Needs you". No browser, temp mediaDir.
// Run: npx tsx src/youtube/studioCommunity.plan.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import {
  MAX_POLLS_PER_CYCLE,
  POLL_MAX_FAILURES,
  POLL_WINDOW_MS,
  pollContentFor,
  pollFailureLines,
  pollTargets,
  readCommunityPosts,
  recordCommunityPost,
  type PollCandidate,
} from "./studioCommunity.js";

const NOW = new Date("2026-10-22T12:00:00Z");
const H = 3600_000;

// --- content: the names in the title's order, the question, the link, nothing else -----------
{
  const poll = pollContentFor(
    "SOME HOOK | Skycrab vs doogile | MCSR Ranked 1v1 | Minecraft Speedrun",
    "vid123",
  );
  assert.deepEqual(poll, {
    videoId: "vid123",
    question: "WHO TAKES IT?",
    options: ["Skycrab", "doogile"],
    text: "Skycrab vs doogile is up: https://youtu.be/vid123",
  });
  // `titleNames` spelling applies when the stored title still carries the API name.
  config.titleNames = { Pinne: "Skycrab" };
  const spelled = pollContentFor("HOOK | Pinne vs lowk3y_ | MCSR Ranked", "v2");
  assert.deepEqual(spelled?.options, ["Skycrab", "lowk3y_"]);
  assert.equal(pollContentFor("no pair here", "v3"), null);
  for (const s of [poll!.question, poll!.text, ...poll!.options])
    assert.doesNotMatch(s, /\b(elo|rank|seed|wins?|won|beat|took it)\b/i, `nothing about the match: ${s}`);
  console.log("OK: the poll asks WHO TAKES IT? with the title's two names and the link, nothing more");
}

// --- targets: public, within 36 h, unrecorded, unblocked, one per id, capped at 2 -----------
{
  const v = (videoId: string, extra: Partial<PollCandidate> = {}): PollCandidate => ({
    videoId,
    matchId: Number(videoId.replace(/\D/g, "")) || 1,
    title: "H | a vs b | x",
    privacyStatus: "public",
    publicAt: new Date(NOW.getTime() - 2 * H).toISOString(),
    ...extra,
  });
  const ids = (t: PollCandidate[]) => t.map((c) => c.videoId);
  assert.deepEqual(ids(pollTargets(NOW, [v("v1")], {}, () => false)), ["v1"]);
  assert.deepEqual(
    ids(pollTargets(NOW, [v("v1", { privacyStatus: "private" })], {}, () => false)),
    [],
    "private",
  );
  assert.deepEqual(
    ids(
      pollTargets(
        NOW,
        [v("v1", { publicAt: new Date(NOW.getTime() - POLL_WINDOW_MS - 1).toISOString() })],
        {},
        () => false,
      ),
    ),
    [],
    "older than the window",
  );
  assert.deepEqual(
    ids(
      pollTargets(NOW, [v("v1", { publicAt: new Date(NOW.getTime() + H).toISOString() })], {}, () => false),
    ),
    [],
    "scheduled for later, even if the status reads public",
  );
  assert.deepEqual(ids(pollTargets(NOW, [v("v1", { publicAt: null })], {}, () => false)), [], "no time");
  assert.deepEqual(
    ids(pollTargets(NOW, [v("v1")], { v1: { at: "t", outcome: "posted", matchId: 1 } }, () => false)),
    [],
    "already recorded",
  );
  assert.deepEqual(
    ids(pollTargets(NOW, [v("v1")], { v1: { at: "t", outcome: "skipped: DNF", matchId: 1 } }, () => false)),
    [],
    "a skip is recorded too",
  );
  assert.deepEqual(
    ids(
      pollTargets(
        NOW,
        [v("v1")],
        { v1: { at: "t", outcome: "error: x", matchId: 1, failures: 1 } },
        () => false,
      ),
    ),
    ["v1"],
    "a failed one is retried",
  );
  assert.deepEqual(
    ids(
      pollTargets(
        NOW,
        [v("v1")],
        { v1: { at: "t", outcome: "error: x", matchId: 1, failures: POLL_MAX_FAILURES } },
        () => false,
      ),
    ),
    [],
    "until it has failed three times",
  );
  assert.deepEqual(
    ids(
      pollTargets(
        NOW,
        [v("v1")],
        { v1: { at: "t", outcome: "unconfirmed: Post was pressed but the new poll never appeared", matchId: 1 } },
        () => false,
      ),
    ),
    [],
    "Post pressed but unseen: never a second click",
  );
  assert.deepEqual(ids(pollTargets(NOW, [v("v1"), v("v2")], {}, (m) => m === 1)), ["v2"], "blocked");
  // A series copies the same record into every game's folder: one poll per video id.
  assert.deepEqual(ids(pollTargets(NOW, [v("v1"), v("v1", { matchId: 9 })], {}, () => false)), ["v1"]);
  const many = ["v1", "v2", "v3", "v4"].map((id) => v(id));
  assert.equal(pollTargets(NOW, many, {}, () => false).length, MAX_POLLS_PER_CYCLE, "cap");
  // What a filter drops never holds a slot.
  assert.deepEqual(
    ids(
      pollTargets(NOW, [v("v1", { privacyStatus: "private" }), v("v2"), v("v3"), v("v4")], {}, () => false),
    ),
    ["v2", "v3"],
  );
  console.log("OK: pollTargets is public + within 36 h + unrecorded + unblocked, one per id, at most 2");
}

// --- the ledger and the failure streak -------------------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), "mcsr-community-"));
  const file = path.join(dir, ".community-posts.json");
  try {
    assert.deepEqual(readCommunityPosts(file), {}, "no file is empty");
    recordCommunityPost("v1", 1, "error: no composer", NOW, file);
    recordCommunityPost("v1", 1, "error: no composer", NOW, file);
    assert.equal(readCommunityPosts(file).v1?.failures, 2);
    const lines = () => pollFailureLines(readCommunityPosts(file), NOW.getTime());
    assert.deepEqual(lines(), [], "two failures is not yet Needs you");
    recordCommunityPost("v1", 1, "error: no composer", NOW, file);
    assert.deepEqual(lines(), [{ matchId: 1, text: "Community poll failed 3 times: no composer (v1)" }]);
    // The line has a horizon: a record older than the poll window is no longer reported (the
    // video is outside the window too), so a stale ledger never nags every morning.
    assert.deepEqual(pollFailureLines(readCommunityPosts(file), NOW.getTime() + POLL_WINDOW_MS + 1), []);
    assert.equal(pollFailureLines(readCommunityPosts(file), NOW.getTime() + POLL_WINDOW_MS).length, 1);
    // A success clears the streak; a later failure starts a fresh one.
    recordCommunityPost("v1", 1, "posted", NOW, file);
    assert.equal(readCommunityPosts(file).v1?.failures, undefined);
    assert.equal(readCommunityPosts(file).v1?.outcome, "posted");
    recordCommunityPost("v1", 1, "error: again", NOW, file);
    assert.equal(readCommunityPosts(file).v1?.failures, 1);
    assert.deepEqual(lines(), []);
    // Post pressed but never seen: no streak to count, reported at once.
    recordCommunityPost("v2", 2, "unconfirmed: Post was pressed but the new poll never appeared", NOW, file);
    assert.equal(readCommunityPosts(file).v2?.failures, undefined);
    assert.deepEqual(lines(), [
      { matchId: 2, text: "Community poll: Post was pressed but the new poll never appeared (v2)" },
    ]);
    console.log("OK: three failures or one unconfirmed Post make a Needs-you line, for 36 h; a success resets it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("studioCommunity.plan: all checks passed");
