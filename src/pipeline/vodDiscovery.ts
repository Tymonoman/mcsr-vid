import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { cacheMatch, getUser } from "../api/mcsrApi.js";
import type { MatchInfo, MatchVod } from "../api/types.js";
import { estimatedRunSec } from "./vodAcquisition.js";

/**
 * Finds a player's Twitch VOD by match time when the API attaches none. Private-room matches
 * (every Playoffs game) carry `vod: []` even when both players streamed, and a ranked match
 * often has only one player's VOD linked. The channel's recent archives are listed with their
 * start timestamps and the one whose span covers the estimated match start is taken; the entry
 * it yields is shaped exactly like an API one, so the download, the description's deep links
 * and the chat save need no special case.
 */

/** Streamers' Twitch ids in a VOD listing look like `v2869571022`; the watch URL drops the `v`. */
const vodUrl = (id: string): string => `https://www.twitch.tv/videos/${id.replace(/^v/, "")}`;

/** A stream that started this long after the estimated match start is still a plausible VOD of it. */
const LATE_START_TOLERANCE_SEC = 5 * 60;
/**
 * How far back the archives listing reaches. Eight covered a fresh ranked match; a playoff game
 * packaged a week later sits behind every stream since (Feinberg's Round of 16 VOD was his ninth
 * by the 21st), and the listing is one request either way.
 */
const ARCHIVE_COUNT = 40;

export interface Archive {
  id: string;
  timestamp: number;
  duration: number;
}

/** Parses `yt-dlp --print "%(id)s\t%(timestamp)s\t%(duration)s"` output; a still-live VOD may print `NA`. */
export function parseArchives(stdout: string): Archive[] {
  return stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((f) => f.length === 3 && f[0]!.length > 0)
    .map(([id, timestamp, duration]) => ({
      id: id!,
      timestamp: Number(timestamp),
      duration: Number(duration) || 0,
    }))
    .filter((a) => Number.isFinite(a.timestamp) && a.timestamp > 0);
}

function listArchivesWithYtDlp(twitchName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      [
        "--skip-download",
        "--playlist-end",
        String(ARCHIVE_COUNT),
        "--print",
        "%(id)s\t%(timestamp)s\t%(duration)s",
        `https://www.twitch.tv/${twitchName}/videos?filter=archives&sort=time`,
      ],
      { timeout: 60_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

export interface DiscoveryDeps {
  getUser: typeof getUser;
  /** Raw stdout of the archives listing for a channel; rejects when yt-dlp fails. */
  listArchives: (twitchName: string) => Promise<string>;
  log: (line: string) => void;
}

/**
 * The archive covering the match, or null. Exact cover of the start is preferred, and among
 * those one that also reaches the match end (a VOD cut mid-match is worse than none, but a
 * stream still live simply has not reached the end yet — the caller notes it). A stream that
 * began up to `LATE_START_TOLERANCE_SEC` after the estimate is the delay fallback.
 */
export function pickArchive(
  archives: Archive[],
  startSec: number,
  endSec: number,
): { archive: Archive; lateBySec: number } | null {
  const covers = archives.filter((a) => a.timestamp <= startSec && a.timestamp + a.duration >= startSec);
  const full = covers.find((a) => a.timestamp + a.duration >= endSec);
  const exact = full ?? covers[0];
  if (exact) return { archive: exact, lateBySec: 0 };
  const late = archives
    .filter((a) => a.timestamp > startSec && a.timestamp - startSec <= LATE_START_TOLERANCE_SEC)
    .sort((a, b) => a.timestamp - b.timestamp)[0];
  return late ? { archive: late, lateBySec: late.timestamp - startSec } : null;
}

/**
 * VOD entries for the players `match.vod` lacks. Only the discovered ones are returned; the
 * caller merges. Never throws: a player without Twitch, a failed listing or no covering VOD
 * each log one line and yield nothing, because a missing VOD is the pipeline's existing
 * "fewer than 2" error, not a new one.
 */
export async function discoverVods(match: MatchInfo, deps: Partial<DiscoveryDeps> = {}): Promise<MatchVod[]> {
  const { getUser: fetchUser = getUser, listArchives = listArchivesWithYtDlp, log = console.error } = deps;
  const endSec = match.date;
  const startSec = endSec - estimatedRunSec(match);
  const missing = match.players.filter((p) => !match.vod.some((v) => v.uuid === p.uuid));

  const found = await Promise.all(
    missing.map(async (player): Promise<MatchVod | null> => {
      try {
        const twitch = (await fetchUser(player.uuid)).connections?.twitch?.name;
        if (!twitch) {
          log(`vod: ${player.nickname}: no Twitch connection, skipped`);
          return null;
        }
        const archives = parseArchives(await listArchives(twitch));
        const pick = pickArchive(archives, startSec, endSec);
        if (!pick) {
          log(
            `vod: ${player.nickname}: none of ${archives.length} archives on twitch.tv/${twitch} covers the match`,
          );
          return null;
        }
        const { archive, lateBySec } = pick;
        log(`vod: ${player.nickname}: discovered ${vodUrl(archive.id)} on twitch.tv/${twitch}`);
        if (lateBySec > 0)
          log(
            `vod: ${player.nickname}: stream started ${lateBySec.toFixed(0)}s after the estimated match start (delay?)`,
          );
        if (archive.timestamp + archive.duration < endSec)
          log(
            `vod: ${player.nickname}: VOD ends before the match does — still live? The download may be short.`,
          );
        return { uuid: player.uuid, url: vodUrl(archive.id), startsAt: archive.timestamp };
      } catch (err) {
        log(`vod: ${player.nickname}: discovery failed: ${describeError(err)}`);
        return null;
      }
    }),
  );
  return found.filter((v): v is MatchVod => v !== null);
}

/**
 * Where a match directory remembers the VODs discovery found (`[{uuid, url, startsAt}]`). A
 * Twitch archive outlives a stream by 14 days for most players; the downloaded clips outlive
 * that, and a re-render or a chat save after the archive is gone still needs to know which VOD
 * the clip came from and where the match sat in it.
 */
const vodsFile = (matchId: number): string => path.join(matchDir(matchId), "vods.json");

async function readSavedVods(matchId: number): Promise<MatchVod[]> {
  const file = vodsFile(matchId);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(await readFile(file, "utf8")) as MatchVod[];
  } catch {
    return [];
  }
}

/**
 * The match with discovered VODs merged in when fewer than two are attached; a no-op otherwise.
 * What discovery finds is written to `vods.json` in the match directory (created if needed) and
 * read back first the next time, so a listing is spent once per match and an expired archive
 * does not un-find a VOD whose clip is already on disk.
 */
export async function withDiscoveredVods(
  match: MatchInfo,
  deps?: Partial<DiscoveryDeps>,
): Promise<MatchInfo> {
  if (match.vod.length >= 2) return match;
  const saved = (await readSavedVods(match.id)).filter((v) => !match.vod.some((m) => m.uuid === v.uuid));
  const known = { ...match, vod: [...match.vod, ...saved] };
  const discovered = known.vod.length >= 2 ? [] : await discoverVods(known, deps);
  if (discovered.length > 0) {
    await mkdir(matchDir(match.id), { recursive: true });
    await writeFile(vodsFile(match.id), JSON.stringify([...saved, ...discovered], null, 2), "utf8");
  }
  if (saved.length === 0 && discovered.length === 0) return match;
  // Back into getMatch's cache: a private room never satisfies the no-op above, so without this
  // every caller that asks again (the nightly's eligibility probe, then the download stage that
  // follows it) pays for the same archive listings a second time.
  const merged = { ...known, vod: [...known.vod, ...discovered] };
  cacheMatch(merged);
  return merged;
}
