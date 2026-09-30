// The pairs the channel put out lately (src/dashboard/pairPosts.ts): which uploads count and when,
// who played them, the window the setting cuts, and a refresh that never takes the list down.
// Run: npx tsx src/dashboard/pairPosts.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { allUploads } from "../youtube/youtubeStore.js";
import {
  pairKey,
  recentPairPosts,
  recentPairPostsSnapshot,
  refreshPairPosts,
  type PairPostDeps,
} from "./pairPosts.js";

const NOW = Date.UTC(2026, 8, 30, 20);
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

// --- Who played: the same pair in either order and any case, and nothing looser ----------------
assert.equal(pairKey(["Feinberg", "Infume"]), pairKey(["infume", "FEINBERG"]), "either order, any case");
assert.notEqual(pairKey(["Feinberg", "Infume"]), pairKey(["Feinberg", "doogile"]), "another pair");
assert.notEqual(
  pairKey(["Feinberg", "Infume"]),
  pairKey(["Feinberg", "Infume2"]),
  "a longer name is another player",
);
assert.notEqual(pairKey(["Feinberg", "Infume"]), pairKey(["Feinberg", "Inf"]), "a prefix is not the player");

// --- Which uploads count, and when ---------------------------------------------------------------
const record = (
  over: Partial<{ publishAt: string | null; privacyStatus: string; uploadedAt: string }> = {},
) => ({
  publishAt: null,
  privacyStatus: "public",
  uploadedAt: iso(NOW - 2 * DAY),
  ...over,
});
const players: Record<number, [string, string]> = {
  1: ["Feinberg", "Infume"],
  2: ["doogile", "Aquacorde"],
  3: ["quiet", "upload"],
  4: ["silverrruns", "dandannyboy"],
  5: ["old", "news"],
  6: ["bad", "time"],
  99: ["never", "read"],
};
const uploads: Awaited<ReturnType<PairPostDeps["uploads"]>> = [
  // Scheduled for yesterday, recorded private when it was uploaded: its publishAt is the time.
  { matchId: 1, record: record({ publishAt: iso(NOW - DAY), privacyStatus: "private" }) },
  // Public on upload, no scheduled time: the upload is the time.
  { matchId: 2, record: record({ uploadedAt: iso(NOW - 2 * DAY) }) },
  // Private with no time: no day to keep away from.
  { matchId: 3, record: record({ privacyStatus: "private", uploadedAt: iso(NOW - DAY) }) },
  // Scheduled ahead: a repeat of it is as close as one after it.
  { matchId: 4, record: record({ publishAt: iso(NOW + 2 * DAY), privacyStatus: "private" }) },
  // Beyond the snapshot's horizon.
  { matchId: 5, record: record({ uploadedAt: iso(NOW - 40 * DAY) }) },
  // A time nobody can read.
  { matchId: 6, record: record({ publishAt: "soon" }) },
  // Players nobody could read, and a lookup that throws.
  { matchId: 7, record: record() },
  { matchId: 99, record: record() },
];
const deps = (over: Partial<PairPostDeps> = {}): PairPostDeps => ({
  uploads: async () => uploads,
  namesOf: async (id) => {
    if (id === 99) throw new Error("the API is down");
    return players[id] ?? null;
  },
  ...over,
});

{
  const posts = await recentPairPosts(NOW, deps());
  assert.deepEqual(
    posts.map((p) => [p.players.join(" vs "), p.atMs - NOW]).sort(),
    [
      ["Feinberg vs Infume", -DAY],
      ["doogile vs Aquacorde", -2 * DAY],
      ["silverrruns vs dandannyboy", 2 * DAY],
    ].sort(),
    "scheduled or public, in the horizon, with known players; the rest are no constraint, not an error",
  );
  console.log("OK: the uploads that count, at the time they count");
}

// The same, read off real records on disk: `youtube.json` per match directory, by `allUploads`.
{
  const media = mkdtempSync(path.join(tmpdir(), "mcsr-pairs-"));
  const was = config.mediaDir;
  config.mediaDir = media;
  try {
    const write = (id: number, rec: object | null) => {
      mkdirSync(path.join(media, String(id)));
      if (rec) writeFileSync(path.join(media, String(id), "youtube.json"), JSON.stringify(rec));
    };
    write(1, {
      videoId: "aaaaaaaaaaa",
      title: "t",
      thumbnailVariant: null,
      ...record({ publishAt: iso(NOW - DAY) }),
    });
    write(2, null); // rendered, never uploaded
    const posts = await recentPairPosts(NOW, {
      uploads: allUploads,
      namesOf: async (id) => players[id] ?? null,
    });
    assert.deepEqual(
      posts.map((p) => p.players),
      [players[1]],
      "a match with no youtube.json is not a post",
    );
    console.log("OK: read from youtube.json on disk");
  } finally {
    config.mediaDir = was;
    rmSync(media, { recursive: true, force: true });
  }
}

// The live path: the records on disk, and who played from the API — or, with it down, the clip names.
{
  const media = mkdtempSync(path.join(tmpdir(), "mcsr-pairs-live-"));
  const was = config.mediaDir;
  const realFetch = globalThis.fetch;
  let asked = 0;
  config.mediaDir = media;
  // The API is down: every request fails before it leaves the machine.
  globalThis.fetch = (async () => {
    asked++;
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const upload = (id: number, clips: string[]) => {
      mkdirSync(path.join(media, String(id)));
      const rec = {
        videoId: "aaaaaaaaaaa",
        title: "t",
        thumbnailVariant: null,
        ...record({ publishAt: iso(NOW - DAY) }),
      };
      writeFileSync(path.join(media, String(id), "youtube.json"), JSON.stringify(rec));
      for (const nick of clips) writeFileSync(path.join(media, String(id), `${nick}.mp4`), "");
    };
    upload(201, ["Infume", "Feinberg", "overlay-timer"]); // both POV clips still on disk
    upload(202, []); // the clips are gone: nobody to name
    const posts = await recentPairPosts(NOW);
    assert.deepEqual(
      posts.map((p) => [...p.players]),
      [["Feinberg", "Infume"]],
      "the players come off the clip names, and the pipeline's own MP4 is not one",
    );
    assert.equal(asked, 2, "both matches were asked for");
    await recentPairPosts(NOW);
    assert.equal(asked, 3, "a match already read is not asked again, one that could not be read is");
    console.log("OK: who played, from the API or the clip names, once per match");
  } finally {
    globalThis.fetch = realFetch;
    config.mediaDir = was;
    rmSync(media, { recursive: true, force: true });
  }
}

// --- The snapshot, windowed on every read by the setting ----------------------------------------
await refreshPairPosts(NOW, deps());
const ids = (days?: number, at = NOW) =>
  recentPairPostsSnapshot(at, days)
    .map((p) => p.players[0])
    .sort();
assert.deepEqual(ids(3), ["Feinberg", "doogile", "silverrruns"], "three days either side");
assert.deepEqual(ids(2), ["Feinberg"], "exactly two days is not within two days");
assert.deepEqual(
  ids(30),
  ["Feinberg", "doogile", "silverrruns"],
  "the horizon is the most the setting can ask",
);
assert.deepEqual(ids(0), [], "0 is off");
assert.deepEqual(ids(3, NOW + 10 * DAY), [], "ten days on, none of them is near");
assert.deepEqual(
  ids(3, NOW + 2 * DAY + 1),
  ["silverrruns"],
  "a scheduled video is near until it has gone out",
);
config.pairRepeatDays = 3;
assert.equal(recentPairPostsSnapshot(NOW).length, 3, "the setting is the default window");
config.pairRepeatDays = 0;
assert.equal(recentPairPostsSnapshot(NOW).length, 0, "and changing it needs no refresh");
config.pairRepeatDays = 3;
console.log("OK: the snapshot is windowed by pairRepeatDays on every read");

// --- A refresh: throttled, once at a time, and never a reason for the list to fail --------------
{
  let reads = 0;
  const counting = deps({
    uploads: async () => {
      reads++;
      return uploads;
    },
  });
  const quiet = console.error;
  const logged: string[] = [];
  console.error = (line: string) => logged.push(line);
  try {
    const t = NOW + 10 * 60_000; // the first refresh above was at NOW
    await Promise.all([refreshPairPosts(t, counting), refreshPairPosts(t, counting)]);
    assert.equal(reads, 1, "two at once read once");
    await refreshPairPosts(t + 60_000, counting);
    assert.equal(reads, 1, "a minute later is still fresh");
    await refreshPairPosts(t + 6 * 60_000, counting);
    assert.equal(reads, 2, "five minutes on it reads again");

    // A failed read keeps the last answer, says so once, and tries again in a minute — not on the next poll.
    const t2 = t + 20 * 60_000;
    const failing = deps({
      uploads: async () => {
        reads++;
        throw new Error("the media disk is gone");
      },
    });
    await refreshPairPosts(t2, failing);
    assert.equal(reads, 3);
    assert.match(logged.join("\n"), /the media disk is gone/);
    assert.equal(recentPairPostsSnapshot(NOW).length, 3, "the last answer stands");
    await refreshPairPosts(t2 + 30_000, failing);
    assert.equal(reads, 3, "not again within the minute");
    await refreshPairPosts(t2 + 61_000, counting);
    assert.equal(reads, 4, "but after it");
  } finally {
    console.error = quiet;
  }
  console.log("OK: a refresh is throttled, single-flight and never throws");
}

console.log("pairPosts: all checks passed");
