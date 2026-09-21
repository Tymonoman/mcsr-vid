// Self-check for vodDiscovery.ts. Picking the wrong archive downloads a different stream and the
// sync step silently fails; every fallback here must degrade to "nothing found", never throw.
// Fixture: match 13213922 (steez vs 7rowl, private), covered by steezsr's v2869571022 and
// 7rowl's v2869549443 — verified against the live listing.
// Run: npx tsx src/vodDiscovery.test.ts
import assert from "node:assert/strict";
import { discoverVods, parseArchives, pickArchive, withDiscoveredVods } from "./vodDiscovery.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { MatchInfo, UserDetails } from "../api/types.js";

// withDiscoveredVods writes vods.json into the match directory: keep the test out of /media.
config.mediaDir = mkdtempSync(path.join(tmpdir(), "vodDiscovery-"));

const STEEZ = "a5d83ff042164ff1b862dedc118c1dae";
const ROWL = "70eb9286e3e24153a8b37c8f884f1292";
const match = {
  id: 13213922,
  date: 1788969894,
  result: { uuid: STEEZ, time: 431518 },
  players: [
    { uuid: STEEZ, nickname: "steez" },
    { uuid: ROWL, nickname: "7rowl" },
  ],
  vod: [],
} as unknown as MatchInfo;

const listings: Record<string, string> = {
  steezsr: "v2869571022\t1788965809\t4217.0\nv2867152312\t1788721677\t5752.0\n",
  "7rowl": "v2869549443\t1788963528\t6870.0\n",
};
const twitchOf: Record<string, string | undefined> = { [STEEZ]: "steezsr", [ROWL]: "7rowl" };
const getUser = async (uuid: string) =>
  ({ connections: twitchOf[uuid] ? { twitch: { id: "x", name: twitchOf[uuid] } } : {} }) as UserDetails;
const logs: string[] = [];
const log = (line: string) => logs.push(line);

/* --- The covering VOD is chosen for each player ------------------------------------------- */
const found = await discoverVods(match, { getUser, listArchives: async (n) => listings[n]!, log });
assert.deepEqual(found, [
  { uuid: STEEZ, url: "https://www.twitch.tv/videos/2869571022", startsAt: 1788965809 },
  { uuid: ROWL, url: "https://www.twitch.tv/videos/2869549443", startsAt: 1788963528 },
]);
assert.ok(logs.some((l) => l.includes("steez: discovered") && l.includes("twitch.tv/steezsr")));

// A player already attached is not looked up again, and the merge keeps the attached entry.
const attached = { uuid: ROWL, url: "https://www.twitch.tv/videos/1", startsAt: 1788963528 };
const merged = await withDiscoveredVods(
  { ...match, vod: [attached] },
  { getUser, listArchives: async (n) => listings[n]!, log },
);
assert.deepEqual(merged.vod, [attached, found[0]]);
// …and what it found is remembered on disk, and read back before any listing is spent.
assert.deepEqual(JSON.parse(readFileSync(path.join(config.mediaDir, "13213922", "vods.json"), "utf8")), [
  found[0],
]);
const remembered = await withDiscoveredVods(
  { ...match, vod: [attached] },
  {
    getUser,
    listArchives: async () => {
      throw new Error("listing spent");
    },
    log,
  },
);
assert.deepEqual(remembered.vod, [attached, found[0]]);

/* --- Nothing found → [] ------------------------------------------------------------------- */
assert.deepEqual(
  await discoverVods(match, {
    getUser,
    listArchives: async () => listings.steezsr!.split("\n")[1]! + "\n",
    log,
  }),
  [],
);

/* --- Player without Twitch → skipped, the other still found ------------------------------- */
twitchOf[ROWL] = undefined;
logs.length = 0;
const one = await discoverVods(match, { getUser, listArchives: async (n) => listings[n]!, log });
assert.equal(one.length, 1);
assert.equal(one[0]!.uuid, STEEZ);
assert.ok(logs.some((l) => l.includes("7rowl: no Twitch connection")));
twitchOf[ROWL] = "7rowl";

/* --- yt-dlp failure → [] not throw --------------------------------------------------------- */
const failed = await discoverVods(match, {
  getUser,
  listArchives: async () => {
    throw new Error("yt-dlp exited with code 1");
  },
  log,
});
assert.deepEqual(failed, []);

/* --- Picking: full cover beats partial, delay only as a last resort, NA duration parses ---- */
const start = 1000;
const end = 1400;
const full = { id: "full", timestamp: 500, duration: 1000 };
const partial = { id: "partial", timestamp: 900, duration: 200 };
const late = { id: "late", timestamp: 1100, duration: 5000 };
const tooLate = { id: "tooLate", timestamp: 1000 + 301, duration: 5000 };
assert.equal(pickArchive([partial, full], start, end)?.archive.id, "full");
assert.equal(pickArchive([partial, late], start, end)?.archive.id, "partial", "a cover beats a late start");
assert.deepEqual(pickArchive([late], start, end), { archive: late, lateBySec: 100 });
assert.equal(pickArchive([tooLate], start, end), null);
assert.deepEqual(parseArchives("v1\t1788965809\tNA\n\n"), [{ id: "v1", timestamp: 1788965809, duration: 0 }]);

console.log("vodDiscovery.test.ts: ok");
