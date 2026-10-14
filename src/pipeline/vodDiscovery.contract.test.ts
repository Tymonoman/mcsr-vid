// Contract tests for VOD discovery and its vods.json memory, from the docs (CLAUDE.md "Known
// pitfalls": "A Twitch archive outlives the stream by 14 days … `withDiscoveredVods` caches what it
// finds to `vods.json`"; handbook "Known pitfalls", the same bullet's long form). The promise list
// with shared P-numbers is at the top of src/api/mcsrApi.contract.test.ts; this file pins:
//
//  P8  `withDiscoveredVods` writes what it finds to `<matchDir>/vods.json` (the directory created).
//  P9  …and reads it back first: once the archive is gone a re-render still has both VODs, with no
//      second listing and no "1/2 VODs".
//  P10 The listing reaches 40 archives back (a playoff game packaged a week later sits behind
//      every stream since).
//
// End to end through the real defaults: `getMatch`/`getUser` against a stubbed global fetch, and
// the real `yt-dlp` call against a fake `yt-dlp` on PATH (a shell script that prints a canned
// listing and records its arguments) — no network, no real yt-dlp.
// Run: npx tsx src/pipeline/vodDiscovery.contract.test.ts
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { getMatch } from "../api/mcsrApi.js";
import type { MatchInfo } from "../api/types.js";
import { discoverVods, withDiscoveredVods } from "./vodDiscovery.js";

/** Runs a check the docs promise; a failure is printed as a deviation, not thrown (triage first). */
async function deviation(clause: string, check: () => unknown): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const root = mkdtempSync(path.join(tmpdir(), "vodDiscovery-contract-"));
config.mediaDir = path.join(root, "media"); // vods.json lands here, never in /media
// A failed assertion anywhere below still cleans up (the exit event fires on a thrown top-level await).
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

/* --- A fake yt-dlp: prints <listings>/<channel>.txt, exits 1 when there is none ------------- */
const bin = path.join(root, "bin");
const listings = path.join(root, "listings");
const callLog = path.join(root, "yt-dlp.calls");
mkdirSync(bin);
mkdirSync(listings);
writeFileSync(
  path.join(bin, "yt-dlp"),
  `#!/bin/sh
printf '%s\\n' "$*" >> "${callLog}"
for a in "$@"; do last="$a"; done
name=\${last#https://www.twitch.tv/}
name=\${name%%/*}
[ -f "${listings}/$name.txt" ] || { echo "ERROR: [twitch:videos] $name: no archives" >&2; exit 1; }
cat "${listings}/$name.txt"
`,
);
chmodSync(path.join(bin, "yt-dlp"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
const ytDlpCalls = (): string[] =>
  existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n") : [];

/* --- The match: a private room (vod: [] even though both streamed), as the API serves it ----- */
const LO = "0a11ce00000000000000000000000001";
const HI = "f0b0b000000000000000000000000002";
const MATCH_ID = 9500001;
const END = 1_790_000_000; // `date` is the match's completion time
const RUN_MS = 600_000;
const START = END - RUN_MS / 1000;
const apiMatch = (): MatchInfo =>
  ({
    id: MATCH_ID,
    type: 3,
    season: 12,
    date: END,
    players: [
      { uuid: LO, nickname: "RunnerLo", roleType: 0, eloRate: null, eloRank: null, country: null },
      { uuid: HI, nickname: "RunnerHi", roleType: 0, eloRate: null, eloRank: null, country: null },
    ],
    changes: [],
    vod: [],
    result: { uuid: HI, time: RUN_MS },
    timelines: [
      { uuid: LO, time: 60_000, type: "story.enter_the_nether" },
      { uuid: HI, time: 61_000, type: "story.enter_the_nether" },
    ],
    completions: [],
  }) as unknown as MatchInfo;
const twitchOf: Record<string, string> = { [LO]: "runnerlo_tv", [HI]: "runnerhi_tv" };
const apiCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://api.mcsrranked.com", `only the (stubbed) MCSR API is reached: ${url}`);
  apiCalls.push(url.pathname);
  const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }));
  if (url.pathname === `/matches/${MATCH_ID}`) return ok(apiMatch());
  const user = /^\/users\/([0-9a-f]{32})$/.exec(url.pathname)?.[1];
  if (user) return ok({ uuid: user, connections: { twitch: { id: "1", name: twitchOf[user] } } });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

/** A listing of `n` archives, newest first, one stream a day; `cover` replaces the k-th one. */
const listing = (n: number, cover?: { k: number; id: string; from: number; dur: string }): string =>
  Array.from({ length: n }, (_, i) =>
    cover && i === cover.k
      ? `${cover.id}\t${cover.from}\t${cover.dur}`
      : `v${7_000_000_000 + i}\t${END + 86_400 * 2 - i * 86_400 * 2}\t3600.0`,
  ).join("\n") + "\n";

// RunnerLo has streamed every day since: the covering archive is the 38th of 40 in the listing.
writeFileSync(
  path.join(listings, "runnerlo_tv.txt"),
  listing(40, { k: 37, id: "v2880399328", from: START - 1800, dur: "7200.0" }),
);
// RunnerHi's covering archive is the newest.
writeFileSync(
  path.join(listings, "runnerhi_tv.txt"),
  listing(3, { k: 0, id: "v2880335778", from: START - 600, dur: "5400.0" }),
);
const logs: string[] = [];
const log = (line: string) => logs.push(line);

/* --- First read: discovered through the real listing, remembered on disk ---------------------- */
const vodsJson = path.join(matchDir(MATCH_ID), "vods.json");
assert.equal(existsSync(matchDir(MATCH_ID)), false, "precondition: no match directory yet");
const first = await withDiscoveredVods(await getMatch(MATCH_ID), { log });
const LO_VOD = { uuid: LO, url: "https://www.twitch.tv/videos/2880399328", startsAt: START - 1800 };
const HI_VOD = { uuid: HI, url: "https://www.twitch.tv/videos/2880335778", startsAt: START - 600 };
assert.deepEqual(
  [...first.vod].sort((a, b) => a.uuid.localeCompare(b.uuid)),
  [LO_VOD, HI_VOD],
  `both POVs found, shaped like the API's own entries: ${logs.join(" | ")}`,
);

// P10: every listing asked for 40 archives — the covering one above sat 38th.
const calls = ytDlpCalls();
assert.equal(calls.length, 2, "one listing per player");
for (const c of calls) {
  assert.match(c, /--playlist-end 40 /, `the listing reaches 40 archives back: ${c}`);
  assert.match(c, /--skip-download/, "a listing, never a download");
  assert.match(c, /filter=archives&sort=time$/, "the channel's archives, newest first");
}

// P8: what it found is on disk, in a directory it created.
assert.ok(existsSync(vodsJson), "vods.json is written to the match directory, created for it");
assert.deepEqual(
  (JSON.parse(readFileSync(vodsJson, "utf8")) as { uuid: string }[]).sort((a, b) =>
    a.uuid.localeCompare(b.uuid),
  ),
  [LO_VOD, HI_VOD],
);

// The next caller of getMatch (the nightly's probe, then the download) gets the merged record
// from the cache, without spending the listings or the match fetch again.
const matchFetches = apiCalls.filter((p) => p.startsWith("/matches/")).length;
assert.equal((await getMatch(MATCH_ID)).vod.length, 2, "getMatch now answers with the discovered VODs");
assert.equal(apiCalls.filter((p) => p.startsWith("/matches/")).length, matchFetches, "from its cache");

/* --- P9: the archive expires; a re-render still has both, without listing ---------------------- */
rmSync(listings, { recursive: true });
mkdirSync(listings); // every channel now answers "no archives" (exit 1)
logs.length = 0;
const later = await withDiscoveredVods(apiMatch(), { log }); // the API record, vod: [] as ever
assert.deepEqual(
  [...later.vod].sort((a, b) => a.uuid.localeCompare(b.uuid)),
  [LO_VOD, HI_VOD],
  "both VODs are read back from vods.json once the archive is gone",
);
assert.equal(ytDlpCalls().length, 2, "vods.json is read first: no listing is spent");
assert.deepEqual(logs, [], "nothing to report — no 'covers the match' miss, no failure");

/* --- P9, partially known: only the player vods.json lacks is listed ---------------------------- */
{
  writeFileSync(vodsJson, JSON.stringify([HI_VOD]));
  writeFileSync(
    path.join(listings, "runnerlo_tv.txt"),
    listing(1, { k: 0, id: "v2880399328", from: START - 1800, dur: "7200.0" }),
  );
  const before = ytDlpCalls().length;
  const m = await withDiscoveredVods(apiMatch(), { log });
  assert.equal(m.vod.length, 2);
  assert.equal(ytDlpCalls().length, before + 1, "one listing, for the player not yet remembered");
  assert.match(ytDlpCalls().at(-1)!, /runnerlo_tv/);
  assert.equal(
    (JSON.parse(readFileSync(vodsJson, "utf8")) as unknown[]).length,
    2,
    "the file now remembers both, the old entry kept",
  );
}

/* --- The API's own entry wins over a remembered one; two attached is a no-op ------------------- */
{
  writeFileSync(vodsJson, JSON.stringify([LO_VOD, HI_VOD]));
  const attached = { uuid: LO, url: "https://www.twitch.tv/videos/1", startsAt: START - 100 };
  const m = await withDiscoveredVods({ ...apiMatch(), vod: [attached] }, { log });
  assert.deepEqual(m.vod, [attached, HI_VOD], "a player the API now links keeps the API's entry");
  const both = { ...apiMatch(), vod: [attached, HI_VOD] };
  rmSync(vodsJson);
  assert.equal(await withDiscoveredVods(both, { log }), both, "two attached: returned as is");
  assert.equal(existsSync(vodsJson), false, "…and nothing is written");
}

/* --- An unreadable vods.json reads as empty: discovery runs again, never a throw -------------- */
{
  const before = ytDlpCalls().length;
  writeFileSync(vodsJson, "[{ truncated");
  writeFileSync(
    path.join(listings, "runnerhi_tv.txt"),
    listing(1, { k: 0, id: "v2880335778", from: START - 600, dur: "5400.0" }),
  );
  const m = await withDiscoveredVods(apiMatch(), { log });
  assert.equal(m.vod.length, 2, "a truncated file is no memory, and the listing finds both again");
  assert.equal(ytDlpCalls().length, before + 2);
}

/* --- Edge: a vods.json that parses but is not a list (a hand edit) ----------------------------- */
await deviation(
  'vodDiscovery.ts JSDoc (readSavedVods/withDiscoveredVods): a vods.json that cannot be read is no memory, "read back first" never costs the render',
  async () => {
    writeFileSync(vodsJson, JSON.stringify(LO_VOD)); // one entry written as an object, not a list
    let threw: unknown = null;
    const m = await withDiscoveredVods(apiMatch(), { log }).catch((e: unknown) => {
      threw = e;
      return null;
    });
    assert.equal(threw, null, `withDiscoveredVods threw on a non-array vods.json: ${String(threw)}`);
    assert.equal(m!.vod.length, 2);
  },
);

/* --- Edge: a still-live stream (yt-dlp prints NA for its duration) ----------------------------- */
// parseArchives' JSDoc: "a still-live VOD may print NA"; pickArchive's: "a stream still live simply
// has not reached the end yet — the caller notes it". A match checked minutes after it ended (the
// creator watch's 15-minute tick) is exactly when the streamer is still live.
await deviation(
  'vodDiscovery.ts JSDoc (parseArchives/pickArchive): a still-live VOD "may print NA" and is "not reached the end yet — the caller notes it"',
  async () => {
    logs.length = 0;
    const live = await discoverVods(apiMatch(), {
      getUser: async (uuid) => ({ connections: { twitch: { id: "1", name: twitchOf[uuid] } } }) as never,
      listArchives: async () => `v2880399999\t${START - 3600}\tNA\n`,
      log,
    });
    assert.equal(
      live.length,
      2,
      `a live stream that began an hour before the match was not discovered (found ${live.length}): ${logs[0] ?? ""}`,
    );
  },
);

console.log("vodDiscovery.contract: all checks passed");
