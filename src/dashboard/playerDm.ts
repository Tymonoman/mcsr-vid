/**
 * The publish kit's DM to a player whose moment the model picked out (30 Sept 2026, the operator's
 * night goal): that moment as a timestamped link, and one ask for a yes — the rights record a
 * reused-content review wants, and the only protection against a takedown. Without a moment, or
 * with the long-form not on YouTube yet, there is nothing to hand over and the kit keeps the plain
 * line in `public/app.js`, which is why a side with no text here is `null` rather than a fallback.
 */
import { readFile } from "node:fs/promises";
import { matchDir } from "../config.js";
import { exportMatchStartSec } from "../pipeline/exportFast.js";
import { gameMatchStarts, readSeriesRecord, type SeriesRecord } from "../playoffs/series.js";
import { pickFile, type PlayerMoment, type ShortPick } from "../shorts/shortPlan.js";

/** In the operator's voice — lowercase, no apostrophes — with the takedown offer kept in the ask. */
const ASK =
  "ok if i keep posting your matches? both povs synced, credit and links in the description. say the word and it comes down.";

/** Where a game's match start sits in the uploaded file, or null when that game is not in it. */
function matchStartIn(
  dir: string,
  matchId: number,
  series: SeriesRecord | null,
  gameId: number,
): number | null {
  if (!series) return gameId === matchId ? exportMatchStartSec(dir, matchId) : null;
  const i = series.games.findIndex((g) => g.matchId === gameId);
  return i < 0 ? null : gameMatchStarts(series.games)[i]!;
}

/**
 * The DM for each side of a match, left then right. `videoUrl` is the long-form on YouTube
 * (`https://youtu.be/<id>`), null while it is not; the names take the title's spelling.
 */
export async function playerDms(
  matchId: number,
  nicknames: readonly [string, string],
  videoUrl: string | null,
): Promise<[string | null, string | null]> {
  if (!videoUrl) return [null, null];
  const dir = matchDir(matchId);
  const pick = await readFile(pickFile(dir, matchId), "utf8")
    .then((text) => JSON.parse(text) as ShortPick)
    // Unreadable or torn mid-write by a re-pick: no moments, and the kit still loads.
    .catch(() => null);
  if (!pick?.playerMoments) return [null, null];
  const series = await readSeriesRecord(dir);
  const dm = (nick: string, other: string, moment: PlayerMoment | undefined): string | null => {
    if (!moment || typeof moment.line !== "string" || !Number.isFinite(moment.atMs)) return null;
    const start = matchStartIn(dir, matchId, series, moment.gameMatchId ?? matchId);
    // One line whatever the model wrote: a newline in it would make a fourth.
    // Lowercase and without the model's full stop, so it reads in the kit's own voice.
    const line = moment.line
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[A-Z]/, (c) => c.toLowerCase())
      .replace(/\.$/, "");
    if (start === null || line === "") return null;
    return [
      `hi ${nick}, the match against ${other} is up on MCSR Replayoffs: ${videoUrl}?t=${Math.floor(start + moment.atMs / 1000)}`,
      line,
      ASK,
    ].join("\n");
  };
  return [
    dm(nicknames[0], nicknames[1], pick.playerMoments.left),
    dm(nicknames[1], nicknames[0], pick.playerMoments.right),
  ];
}
