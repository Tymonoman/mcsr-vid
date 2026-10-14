/**
 * What happened to a match after it left the pipeline: the upload record that joins a thumbnail
 * variant to a videoId and its CTR row.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { listProcessedMatchIds } from "../dashboard/matchStatus.js";
import { readManifest } from "../thumbnails/thumbnailVariants.js";
import { buildTitle, HOOK_PLACEHOLDER, metaPaths, MOBILE_CUTOFF, SEPARATOR } from "../pipeline/title.js";
import {
  closerFor,
  seedPhrase,
  subscribeLineFor,
  SUBSCRIBE_LINE_VARIANTS,
  variantIndex,
  withLastMeeting,
} from "../pipeline/description.js";
import { playoffSeriesTail, playoffTitleTail, seedOrdinal } from "../playoffs/playoffs.js";
import { buildShortTitle, readShortHook, TITLE_MAX_CHARS } from "../shorts/shortHook.js";
import { describeError } from "../errorText.js";
import { getMatch } from "../api/mcsrApi.js";
import { readSeriesRecord, type SeriesRecord } from "../playoffs/series.js";

/** The long-form and the Short are two videos with two records. */
export type UploadKind = "video" | "short";

const UPLOAD_FILE: Record<UploadKind, string> = { video: "youtube.json", short: "youtube-short.json" };

/**
 * Per step: null for done, the error text for failed, absent for not attempted (a Short has no
 * thumbnail, a private video cannot be commented on). What "Finish on YouTube" reports — and what
 * it reads back to know which steps it must not do a second time.
 */
export interface FinishedSteps {
  thumbnail?: string | null;
  playlists?: string | null;
  comment?: string | null;
  tags?: string | null;
  /** Studio automation's own step (config.studioAutomation): pinning the channel's first comment.
   * Absent on every record from before 7 Oct 2026, and on every record ever, while the setting is off. */
  pin?: string | null;
}

export interface UploadRecord {
  videoId: string;
  /** RFC 3339. When the upload completed, not when YouTube publishes it. */
  uploadedAt: string;
  /** RFC 3339 scheduled publish time, or null for "published on upload". */
  publishAt: string | null;
  privacyStatus: string;
  /** Which thumbnail variant was live at upload time — the A/B grouping key. */
  thumbnailVariant: string | null;
  title: string;
  /** Absent on records written before Studio uploads were persisted: those were the dashboard's. */
  source?: "dashboard" | "studio";
  /** What `finishOnYouTube` did to it, once it has run. */
  finished?: FinishedSteps;
  /**
   * The last "Put on YouTube" / "Undo on YouTube" (src/youtube/thumbnailSwap.ts): the tile put on
   * and the folder it came from, or variant null for the image it wore before the first put; and when.
   */
  thumbnailSet?: { variant: string | null; at: string; from?: string };
}

const recordPath = (matchId: number, kind: UploadKind): string =>
  path.join(matchDir(matchId), UPLOAD_FILE[kind]);

export async function readUpload(matchId: number, kind: UploadKind = "video"): Promise<UploadRecord | null> {
  const file = recordPath(matchId, kind);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as UploadRecord;
  } catch {
    // A truncated record must not hide the rest of the dashboard; treated as "not uploaded",
    // which is recoverable by uploading again, rather than throwing on every page load.
    return null;
  }
}

export async function writeUpload(
  matchId: number,
  record: UploadRecord,
  kind: UploadKind = "video",
): Promise<void> {
  await writeFile(recordPath(matchId, kind), JSON.stringify(record, null, 2), "utf8");
}

/** The file's text, or null when absent — or empty: a 0-byte `.edited.txt` is no edit. */
export const readIfPresent = async (file: string): Promise<string | null> => {
  if (!existsSync(file)) return null;
  const text = await readFile(file, "utf8");
  return text.trim() === "" ? null : text;
};

/**
 * The title, description and tags an upload sends, read off the same files the publish kit
 * pastes from (server.ts `readMeta`: the `.edited.txt` sibling wins over the generated text).
 * Title is the first line only — the lines under it are guidance for the terminal (src/pipeline/title.ts)
 * — with the thumbnail manifest's headline standing in for `<HOOK>` when nobody edited one in;
 * a title that still carries the placeholder is the caller's to refuse.
 *
 * The generated half is refreshed on today's templates, because the files are the render's and a
 * match can wait days for its upload (the 24 Sept 2026 audit, fix 4): the title keeps the
 * operator's hook and rebuilds the rest (`refreshTitle`), a description nobody edited gets the
 * known drifts patched (`refreshDescription`) and a "last time they met" line when the pair has
 * an earlier long-form on the channel (`lastMeetingFor`), the tags gain the broadcast spellings
 * (`refreshTags`), and the Short's title follows `buildShortTitle` with the saved Short hook.
 * Each one that cannot be refreshed goes up as stored, with one log line — never a refusal.
 *
 * The Short's text is the render's own (`short-<id>.title.txt`, first line); its tags are the
 * long-form's, so both halves of a match are one channel to YouTube.
 */
export async function uploadTextFor(
  matchId: number,
  kind: UploadKind,
): Promise<{ title: string; description: string; tags: string[] }> {
  const dir = matchDir(matchId);
  const base = kind === "short" ? `short-${matchId}` : `match-${matchId}`;
  // The Short's title and description are the render's own and have no editable sibling; the
  // long-form's convention is `metaPaths`, shared with the title editor and the publish kit.
  const edited = (what: "title" | "description") =>
    kind === "video" ? readIfPresent(metaPaths(matchId, what).edited) : Promise.resolve(null);
  const refreshed = async <T>(what: string, stored: T, rebuild: () => T | Promise<T>): Promise<T> => {
    try {
      return await rebuild();
    } catch (err) {
      console.warn(
        `upload text, match ${matchId}: the stored ${what} goes up as it is — ${describeError(err)}`,
      );
      return stored;
    }
  };
  const titleText =
    (await edited("title")) ?? (await readIfPresent(path.join(dir, `${base}.title.txt`))) ?? "";
  let title = titleText.split("\n")[0]!.trim();
  if (title.includes(HOOK_PLACEHOLDER)) {
    const hook = (await readManifest(dir))?.hookText?.trim();
    if (hook) title = title.replace(HOOK_PLACEHOLDER, hook);
  }
  // A Short with no saved hook cannot go up (`hookRefusal`): its stored title stands, unlogged —
  // the publish kit asks for this text every time a match opens. In hand mode
  // (config.shortsByHand) the saved short-<id>.hook.txt is not what drove the title — the hand
  // file's own hook, already baked into title.txt by `buildHandShort`, is — so it is never read
  // here, or this rebuild would overwrite a hand-cut Short's title with an unrelated one.
  const shortHook = kind === "short" && !config.shortsByHand ? await readShortHook(dir, matchId) : null;
  if (title !== "" && (kind === "video" || shortHook)) {
    const stored = title;
    const isSeries = existsSync(path.join(dir, "series.json"));
    title = await refreshed(`${kind === "short" ? "Short " : ""}title`, stored, async () => {
      if (kind === "short") {
        return refreshShortTitle(shortHook, await longFormTitle(matchId));
      }
      let refreshedTitle = refreshTitle(stored, isSeries);
      if (
        isSeries &&
        !refreshedTitle.includes("Minecraft") &&
        refreshedTitle.length + " | Minecraft Speedrun".length <= TITLE_MAX_CHARS
      ) {
        refreshedTitle += " | Minecraft Speedrun";
      }
      return refreshedTitle;
    });
  }
  const editedDescription = await edited("description");
  let description =
    editedDescription ?? (await readIfPresent(path.join(dir, `${base}.description.txt`))) ?? "";
  // The operator's own words stay theirs: only a description nobody edited is patched.
  if (editedDescription === null) {
    const stored = description;
    description = await refreshed("description", stored, () =>
      refreshDescription(stored, kind, config.supportUrl, dir, matchId),
    );
    // The pair's last meeting is only known now, and only a long-form sends a viewer on.
    if (kind === "video")
      description = withLastMeeting(
        description,
        await refreshed<string | null>("last meeting", null, () => lastMeetingFor(matchId, title)),
      );
  }
  // A Short's description is written when it is cut, before the long-form has an id; by the
  // time it uploads (18 h after the video) the id is in youtube.json, and a Short whose job is
  // to send viewers to the match had better say where the match is (the 22 Sept 2026 audit:
  // three Shorts, 1.8k views, nothing sent on).
  if (kind === "short") {
    const videoId = (await readUpload(matchId, "video"))?.videoId;
    if (videoId && !description.includes(videoId)) {
      const what = existsSync(path.join(dir, "series.json")) ? "the whole series" : "the whole match";
      description = description.replace(/^(.*?)\n/, `$1\n${what}: https://youtu.be/${videoId}\n`);
    }
  }
  const storedTags = ((await readIfPresent(path.join(dir, `match-${matchId}.tags.txt`))) ?? "")
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
  const tags = await refreshed("tags", storedTags, () => refreshTags(storedTags));
  return { title, description, tags };
}

/** The long-form's title line as stored (the edit wins), for the names a Short's title carries. */
async function longFormTitle(matchId: number): Promise<string> {
  const { edited, generated } = metaPaths(matchId, "title");
  return ((await readIfPresent(edited)) ?? (await readIfPresent(generated)) ?? "").split("\n")[0]!.trim();
}

/**
 * A stored title in its three parts: the hook (whatever stands before " | <left> vs <right>",
 * itself possibly carrying a " | "), the two names, and the format half after them. The names
 * segment is the LAST "<a> vs <b>" without spaces, since a hook can read "2699 vs 2376" too.
 */
export function splitTitle(line: string): { hook: string; left: string; right: string; tail: string } | null {
  const segments = line.split(SEPARATOR);
  for (let at = segments.length - 1; at >= 0; at--) {
    const names = /^(\S+) vs (\S+)$/.exec(segments[at]!);
    if (names)
      return {
        hook: segments.slice(0, at).join(SEPARATOR),
        left: names[1]!,
        right: names[2]!,
        tail: segments.slice(at + 1).join(SEPARATOR),
      };
  }
  return null;
}

/**
 * A name as the API spells it, lower case: `titleNames`' Skycrab is Pinne again, so a title
 * written before 22 Sept 2026 and one written after name the same player.
 */
const canonName = (shown: string): string => {
  const name = shown.toLowerCase();
  const api = Object.entries(config.titleNames).find(([, spelled]) => spelled.toLowerCase() === name);
  return api ? api[0].toLowerCase() : name;
};

/** The two players a title names as one key, whichever side each is on; null when it names none. */
function pairKey(line: string): string | null {
  const parts = splitTitle(line);
  return parts ? [parts.left, parts.right].map(canonName).sort().join("|") : null;
}

/**
 * The video of the pair's most recent earlier meeting on the channel, or null for a first one;
 * `withLastMeeting` puts it in the description. "Earlier" is by match id, which runs in game time,
 * so a match uploaded after a newer one of its pair does not point at the newer game. Long-forms
 * only, one record each (a series is game 1's), and a private video with no time is not on the
 * channel for anyone yet.
 * ponytail: the pair comes off each record's title, so a Studio title the kit did not write is
 * skipped, and a deleted video's record counts until the operator clears it.
 */
export async function lastMeetingFor(matchId: number, title: string): Promise<string | null> {
  const pair = pairKey(title);
  if (!pair) return null;
  const earlier = (await allUploads()).filter(
    ({ matchId: other, record }) =>
      other < matchId &&
      (record.privacyStatus !== "private" || !!record.publishAt) &&
      pairKey(record.title ?? "") === pair,
  );
  return earlier[earlier.length - 1]?.record.videoId ?? null;
}

/** The nicknames a title's hook sets against each other ("TAS", "UNC"), and the two players it names. */
function hookNicknames(line: string) {
  const parts = splitTitle(line);
  if (!parts) return null;
  const players = [parts.left, parts.right].map((shown) => ({ key: canonName(shown), shown }));
  const nicknames = parts.hook
    .split(SEPARATOR)
    .map((segment) => segment.split(/\s+vs\.?\s+/i))
    .filter((sides) => sides.length === 2)
    .flat()
    .map((side) => side.trim())
    // A player's own name is no nickname, and nor is a figure ("2699 vs 2376").
    .filter((side) => /\p{L}/u.test(side) && !players.some((p) => p.key === canonName(side)));
  return { nicknames, players };
}

/**
 * Warnings, never refusals, for each nickname in `titleLine`'s hook that earlier uploaded titles
 * used beside other players. A nickname stands for one player ("TAS" is doogile) and a viewer
 * learns which by seeing it again; the 30 Sept 2026 post-mortem found "LOVERBOY vs TAS" on two
 * videos with different second players, and TAS standing for four players across seven titles.
 * Who it means is the player seen beside it in the most earlier titles: a hook's order is not
 * trusted, since "LOVERBOY vs AWKWARD" sits over "Aquacorde vs Infume". The match must have that
 * player in it (after one earlier title the two players tie: either will do). Nothing earlier, no
 * warning, and the match's own record is not earlier. It never throws: a save does not wait on it.
 * ponytail: uploaded titles only, so a hook saved in the same sitting whose upload has not run
 * yet is not seen; read the saved title files too if that bites.
 */
export async function nicknameWarnings(titleLine: string, matchId: number): Promise<string[]> {
  try {
    const now = hookNicknames(titleLine);
    if (!now?.nicknames.length) return [];
    // Ascending by match id, so a player's `shown` spelling below ends as the latest title's.
    const earlier = (await allUploads()).flatMap(({ matchId: other, record }) => {
      const past = other === matchId ? null : hookNicknames(record.title ?? "");
      const at = Date.parse(record.publishAt ?? record.uploadedAt);
      return past ? [{ ...past, at: Number.isFinite(at) ? at : 0 }] : [];
    });
    const warnings: string[] = [];
    for (const nickname of now.nicknames) {
      const beside = new Map<string, { shown: string; titles: number; at: number }>();
      for (const past of earlier) {
        if (!past.nicknames.some((n) => n.toLowerCase() === nickname.toLowerCase())) continue;
        for (const { key, shown } of past.players) {
          const seen = beside.get(key);
          beside.set(key, { shown, titles: (seen?.titles ?? 0) + 1, at: Math.max(seen?.at ?? 0, past.at) });
        }
      }
      const most = Math.max(0, ...[...beside.values()].map((b) => b.titles));
      const owners = [...beside].filter(([, b]) => b.titles === most);
      if (owners.length === 0 || owners.some(([key]) => now.players.some((p) => p.key === key))) continue;
      const day = Math.max(...owners.map(([, b]) => b.at));
      warnings.push(
        `"${nickname}" stood for ${owners.map(([, b]) => b.shown).join(" or ")}${day ? ` on ${new Date(day).toISOString().slice(0, 10)}` : ""} — one nickname per player`,
      );
    }
    return warnings;
  } catch (err) {
    console.warn(`nickname check, match ${matchId}: skipped — ${describeError(err)}`);
    return [];
  }
}

/**
 * A stored long-form title with its generated half built again by `buildTitle`: the names get
 * `titleName`'s spellings (Pinne is Skycrab), "MCSR Ranked 1v1" gains "| Minecraft Speedrun"
 * (22 Sept 2026) and a playoff tail its current form ("S11 Playoffs · Round of 16 · Game 2" was
 * the old one); a joined series (`series`) takes the round without a game number. From the line
 * alone, not the API: the names stay in the order the video shows them, and a bracket read that
 * failed cannot turn a playoff title into a ranked one. Throws — the stored title then goes up —
 * on a line it does not recognise, a hook over today's budget, or a result over 100 characters.
 */
export function refreshTitle(stored: string, series: boolean): string {
  const parts = splitTitle(stored);
  if (!parts) throw new Error(`no "<left> vs <right>" in "${stored}"`);
  const playoff =
    /^MCSR Ranked (?:Season |S)(\d+) Playoffs(?: \| | · )(.+?)(?:(?: \| | · )Game (\d+))?$/.exec(parts.tail);
  if (!playoff && !/^MCSR Ranked 1v1( \| Minecraft Speedrun)?$/.test(parts.tail))
    throw new Error(`the format half "${parts.tail}" is neither a ranked nor a playoff one`);
  const [, season, round, gameNo] = playoff ?? [];
  const suffix = !playoff
    ? undefined
    : series || !gameNo
      ? playoffSeriesTail(Number(season), round!)
      : playoffTitleTail({ season: Number(season), round: round!, gameNo: Number(gameNo) });
  const built = buildTitle({
    leftNickname: parts.left,
    rightNickname: parts.right,
    ...(suffix ? { suffix } : {}),
  });
  // The hook's budget has two sides (`buildTitle`): the 100-character one, checked on the result
  // below, and the mobile cut the second name must end before. Only a new spelling can move the
  // latter (Pinne -> Skycrab), and a hook that fit it must keep fitting; one that never did is
  // the operator's accepted title and changes nothing here.
  const names = built.generated.slice(0, built.generated.indexOf(SEPARATOR));
  const namesEnd = (n: string) => parts.hook.length + SEPARATOR.length + n.length;
  if (
    parts.hook &&
    namesEnd(names) > MOBILE_CUTOFF &&
    namesEnd(`${parts.left} vs ${parts.right}`) <= MOBILE_CUTOFF
  )
    throw new Error(`"${names}" would end past character ${MOBILE_CUTOFF}, the mobile cut, after this hook`);
  const title = parts.hook ? `${parts.hook}${SEPARATOR}${built.generated}` : built.generated;
  if (title.length > TITLE_MAX_CHARS)
    throw new Error(`the rebuilt title would be ${title.length} characters`);
  return title;
}

/** The Short's title by today's rule (`buildShortTitle`): the saved Short hook, then the long-form's two names. */
export function refreshShortTitle(hook: string | null, longTitle: string): string {
  if (!hook) throw new Error("no saved Short hook");
  const parts = splitTitle(longTitle);
  if (!parts) throw new Error(`no names in the long-form's title "${longTitle}"`);
  const title = buildShortTitle(hook, parts.left, parts.right);
  if (title.length > TITLE_MAX_CHARS)
    throw new Error(`the rebuilt title would be ${title.length} characters`);
  return title;
}

/**
 * A generated description with the drifts since its render patched in place, rather than built
 * again: its inputs (the VOD links with their synced offsets, the match-time and frozen seed
 * ratings, the chapters) are the API's and Twitch's, and a Twitch archive is gone after 14 days
 * — the stored links are the ones the render checked. The drifts: "#9 seed" is "9th seed"
 * (`seedOrdinal`, 24 Sept 2026), the closer is today's phrasing (`closerFor`), the tip-jar line
 * (`supportUrl`) goes where the template puts it, before the closer, and the subscribe line
 * (`subscribeLineFor`) becomes its own paragraph after the opening one. For a series (`series.json`
 * beside game 1), old chapter lines of the form "M:SS game N" (or H:MM:SS) that have no " · " yet
 * are relabelled into "M:SS game N · <seed phrase>" using game N's world seed type from the match;
 * reading failure leaves that line unchanged. A Short's description gets the seed wording only;
 * its layout has no closer.
 *
 * `matchId` keys `copyVariety`'s phrasing pick (`uploadTextFor` passes its own); omitted, both
 * lines are always `CLOSER_VARIANTS[0]`/`SUBSCRIBE_LINE_VARIANTS[0]`, today's exact text. The
 * subscribe-line check matches any variant, not only index 0 — otherwise a description that
 * already carries, say, variant 2 would read as missing the line and gain a second copy of it.
 */
export async function refreshDescription(
  text: string,
  kind: UploadKind,
  supportUrl = config.supportUrl,
  series?: SeriesRecord | string | null,
  matchId?: number,
): Promise<string> {
  let out = text.replace(/#(\d+) seed\b/g, (label) => seedOrdinal(label));
  if (kind === "short" || out === "") return out;
  out = out.replace(/^fan channel, .*$/m, closerFor(matchId, config.copyVariety));
  if (supportUrl && !out.includes("tip jar: ")) {
    const at = out.search(/\n\n(?:fan channel, |#MCSR)/);
    const line = `tip jar: ${supportUrl}`;
    out = at < 0 ? `${out}\n${line}` : `${out.slice(0, at)}\n${line}${out.slice(at)}`;
  }
  // The opening is one line, so the first blank line is its end; no blank line is no template.
  if (!SUBSCRIBE_LINE_VARIANTS.some((v) => out.includes(v))) {
    const line = subscribeLineFor(matchId, config.copyVariety);
    out = out.replace("\n\n", `\n\n${line}\n\n`);
  }
  const record = typeof series === "string" ? await readSeriesRecord(series) : series;
  if (record) {
    const lines = out.split("\n");
    const newLines: string[] = [];
    for (const line of lines) {
      const cr = line.endsWith("\r") ? "\r" : "";
      const stripped = cr ? line.slice(0, -1) : line;
      const match = /^(\d+:\d{2}(?::\d{2})?)\s+game\s+(\d+)$/i.exec(stripped);
      if (match && !stripped.includes(" · ")) {
        const timestamp = match[1]!;
        const gameNo = Number(match[2]!);
        const seriesGame = record.games.find((g) => g.gameNo === gameNo);
        if (seriesGame) {
          try {
            const m = await getMatch(seriesGame.matchId);
            const phrase = seedPhrase(m);
            if (phrase) {
              newLines.push(`${timestamp} game ${gameNo} · ${phrase}${cr}`);
              continue;
            }
          } catch {
            // reading it would need a network call that can fail; a failure leaves that line unchanged
          }
        }
      }
      newLines.push(line);
    }
    out = newLines.join("\n");
  }
  return out;
}

/**
 * The stored tags with the broadcast's spelling of a name (`config.titleNames`: Skycrab for
 * Pinne) right after the nicknames, where `buildTags` has put a player's Twitch name since
 * 21 Sept 2026 — a match rendered before then carries only the API's spelling. Other players'
 * Twitch names need the API and are not recovered here.
 */
export function refreshTags(tags: string[]): string[] {
  const have = new Set(tags.map((t) => t.toLowerCase()));
  const extra = tags
    .slice(0, 2)
    .map((t) => config.titleNames[t])
    .filter((n): n is string => !!n && !have.has(n.toLowerCase()));
  const out = [...tags.slice(0, 2), ...extra, ...tags.slice(2)];
  return out.join(",").length <= 450 ? out : tags;
}

/** `variantIndex`'s salt for this pool — distinct from the description's closer/subscribe salts. */
const SALT_SYNC = 2;

/**
 * The sync sentence, byte-identical on 29 of 76 pinned comments for 7 weeks — the loudest
 * "this is scripted" tell the 6 Oct 2026 packaging audit found (`packaging.md` #1, confirmed by
 * two posting bursts seconds apart across already-published videos). `SYNC_SENTENCE_VARIANTS`
 * gives it 3 more phrasings of the same facts (both POVs are the players' own streams, synced on
 * the countdown, report a bad timestamp and it gets fixed), picked by match id when
 * `copyVariety` is on — salted differently from the description's closer and subscribe lines
 * (`variantIndex`, src/pipeline/description.ts) so the two surfaces don't always change together.
 * Index 0 is unchanged: `copyVariety` off is byte for byte today's.
 */
export const SYNC_SENTENCE_VARIANTS: readonly string[] = [
  "both povs are the players own streams, synced on the countdown. if the timer looks off anywhere drop the timestamp here and ill fix it",
  "both povs are the players own streams, lined up on the countdown. if the timer looks off anywhere drop the timestamp below and ill fix it",
  "both povs are the players own streams, matched up on the countdown. spot the timer off anywhere? drop the timestamp here and ill fix it",
  "both povs are the players own streams, synced off the countdown. if the timer looks off anywhere just drop the timestamp and ill fix it",
];

/**
 * The first comment on a match video, which the operator pins in Studio (pinning has no API).
 * The publish kit shows the same text (`pinnedCommentFor`, src/youtube/youtubeUpload.ts, gathers
 * what it is handed here). In the operator's own voice and never the winner: a spoiler-free
 * question to answer (`pinnedQuestion`, 30 Sept 2026), where to report a sync slip, a playlist to
 * watch next, and the tip-jar line, which follows supportUrl like the descriptions. The subscribe
 * ask is the description's and the cards', not a third copy here.
 *
 * `matchId` keys `copyVariety`'s pick of `SYNC_SENTENCE_VARIANTS`; omitted (every call before
 * this existed, and every test that does not pass it) is always index 0.
 */
export function pinnedComment(
  {
    question,
    playlistUrl,
    matchId,
  }: { question?: string | null; playlistUrl?: string | null; matchId?: number } = {},
  supportUrl = config.supportUrl,
): string {
  const sentence =
    !config.copyVariety || matchId === undefined
      ? SYNC_SENTENCE_VARIANTS[0]!
      : SYNC_SENTENCE_VARIANTS[variantIndex(matchId, SALT_SYNC, SYNC_SENTENCE_VARIANTS.length)]!;
  return [
    ...(question ? [question] : []),
    sentence,
    ...(playlistUrl ? [`more matches like this: ${playlistUrl}`] : []),
    ...(supportUrl ? [`tip jar: ${supportUrl}`] : []),
  ].join("\n");
}

/**
 * The match whose record already names this video id, across BOTH kinds, or null.
 *
 * `allUploads` reads only `youtube.json`, so a check built on it cannot see a Short — and the
 * Short of a match is exactly the id an operator is most likely to paste by mistake, since both
 * sit next to each other in Studio.
 */
export async function videoIdOwner(videoId: string): Promise<{ matchId: number; kind: UploadKind } | null> {
  for (const matchId of listProcessedMatchIds()) {
    for (const kind of ["video", "short"] as const) {
      if ((await readUpload(matchId, kind))?.videoId === videoId) return { matchId, kind };
    }
  }
  return null;
}

/**
 * Resolves a CLI target that must name a Short — by match id (reads its `youtube-short.json`) or
 * by video id directly, refusing one on record as that match's *long-form* instead of its Short.
 *
 * `videoIdOwner`'s own doc already names the mistake this guards: "the Short of a match is
 * exactly the id an operator is most likely to paste by mistake, since both sit next to each
 * other in Studio" — true the other way too. Resolving by raw id used to trust whatever kind
 * `videoIdOwner` actually found, so a long-form id pasted where a Short's was expected (or the
 * two swapped on a command line) silently carried on labelled `shortId` rather than being refused
 * — the root the "related video" picker (`studioCli.ts`'s own `resolveShort`) builds on.
 */
export async function resolveShortVideoId(
  target: string,
): Promise<{ matchId: number; shortId: string } | { error: string }> {
  if (/^\d+$/.test(target)) {
    const matchId = Number(target);
    const record = await readUpload(matchId, "short");
    if (!record) return { error: `match ${matchId} has no recorded Short upload (youtube-short.json)` };
    return { matchId, shortId: record.videoId };
  }
  const owner = await videoIdOwner(target);
  if (!owner)
    return {
      error: `${target} is not a known video id (no match records it in youtube.json/youtube-short.json)`,
    };
  if (owner.kind !== "short")
    return { error: `${target} is recorded as match ${owner.matchId}'s long-form video, not its Short` };
  return { matchId: owner.matchId, shortId: target };
}

/** Every match that has been uploaded, for the stats table. */
export async function allUploads(): Promise<Array<{ matchId: number; record: UploadRecord }>> {
  const entries = await Promise.all(
    listProcessedMatchIds().map(async (matchId) => ({ matchId, record: await readUpload(matchId) })),
  );
  return entries.filter((e): e is { matchId: number; record: UploadRecord } => e.record !== null);
}

/** Every match that has a Short upload — `allUploads`'s own shape with `kind: "short"`, for the
 *  Studio worker's related-video linking (11 Oct 2026). */
export async function allShortUploads(): Promise<Array<{ matchId: number; record: UploadRecord }>> {
  const entries = await Promise.all(
    listProcessedMatchIds().map(async (matchId) => ({ matchId, record: await readUpload(matchId, "short") })),
  );
  return entries.filter((e): e is { matchId: number; record: UploadRecord } => e.record !== null);
}

/**
 * This match's long-form record, when the video's thumbnail is this folder's to set. A series'
 * games 2..n may carry game 1's video id, and the series' thumbnail is game 1's: the lowest match
 * id holding the id owns it. A Short is never here — `youtube.json` is the long-form's record.
 */
export async function longFormRecord(matchId: number): Promise<UploadRecord | null> {
  const record = await readUpload(matchId);
  if (!record) return null;
  const holders = (await allUploads()).filter((u) => u.record.videoId === record.videoId);
  return Math.min(matchId, ...holders.map((u) => u.matchId)) < matchId ? null : record;
}

/**
 * Finish on YouTube, Put/Undo on YouTube and Move on YouTube each read the record, write to the
 * video and write the record back: one at a time per match, or one sets its image over the other's,
 * drops its ledger or puts back the old publish time.
 */
const writing = new Map<number, Promise<void>>();
export function onVideo<T>(matchId: number, write: () => Promise<T>): Promise<T> {
  const run = (writing.get(matchId) ?? Promise.resolve()).then(write).finally(() => {
    if (writing.get(matchId) === settled) writing.delete(matchId);
  });
  const settled = run.then(
    () => {},
    () => {},
  );
  writing.set(matchId, settled);
  return run;
}
/** A Finish or a Put on this match's video in flight (or waiting its turn). */
export const videoWriting = (matchId: number): boolean => writing.has(matchId);
/** Any match's Finish or Put/Undo in flight — restartWhenIdle.ts's gate. */
export const anyVideoWriting = (): boolean => writing.size > 0;

/**
 * The finished video to upload, or null.
 *
 * Whatever video in the match folder is not a POV clip (`<nickname>.mp4`), a render intermediate
 * or a Short: `npm run export:fast` writes `final-<id>.mp4`, the retired melt export wrote
 * `final.mp4`, and a hand export can be named anything.
 *
 * Ambiguity is reported rather than guessed at: uploading the wrong four-gigabyte file to a
 * public channel is not a mistake worth being clever about.
 */
export function findExportedVideo(
  matchId: number,
  povNicknames: string[],
): { path: string } | { error: string } {
  const dir = matchDir(matchId);
  if (!existsSync(dir)) return { error: `No working directory for match ${matchId}` };

  const povFiles = new Set(povNicknames.map((n) => `${n}.mp4`));
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(mp4|mov|mkv|webm)$/i.test(e.name))
    .map((e) => e.name)
    // Everything named overlay* is a render intermediate, not the finished video: the timer
    // strip, the intro card and the split stills. Matched by prefix rather than by name so the
    // codec changes those artifacts have been through (overlay.mov -> overlay-timer.mp4,
    // overlay-intro.mov -> overlay-intro.webm) cannot turn one of them into an upload candidate.
    //
    // `.part.` catches anything still being written. Both writers in this project rename into
    // place on success — src/pipeline/atomicOutput.ts writes `<name>.part<ext>`, exportFast.ts writes
    // `final-<id>.part.mp4` — precisely so a truncated file is never mistaken for a finished one.
    // Without this the upload panel would offer `final.part.mp4` while an export was still
    // running, and publish half a video.
    .filter(
      (name) =>
        !povFiles.has(name) &&
        !name.startsWith("overlay") &&
        // A Short is its own deliverable, uploaded as a separate video — not a candidate for
        // "the finished match export". Without this the Shorts pipeline makes every rendered
        // match ambiguous, which silently disables the upload panel and the preview player.
        !name.startsWith("short-") &&
        // `export:fast --seconds` writes smoke-<id>.mp4: a range, never the deliverable.
        !name.startsWith("smoke-") &&
        !name.includes(".part.") &&
        name !== "sync-preview.mp4",
    );

  // A playoff series is the deliverable of its first game's directory (src/playoffs/series.ts): the
  // joined video beside the game's own export, and the one to upload.
  const series = candidates.find((name) => name === `series-${matchId}.mp4`);
  if (series) return { path: path.join(dir, series) };

  if (candidates.length === 0) {
    return {
      error:
        `No exported video in ${dir}. Export the finished render from Kdenlive into that folder ` +
        `(any name except the two POV clips), or give an explicit path.`,
    };
  }
  if (candidates.length > 1) {
    return { error: `Several possible videos in ${dir}: ${candidates.join(", ")}. Give an explicit path.` };
  }
  return { path: path.join(dir, candidates[0]!) };
}
