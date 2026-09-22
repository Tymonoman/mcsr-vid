/**
 * The match screen's metadata payload: title and description (the edit wins, a 0-byte edit is
 * no edit), chapters, tags, the hook budget and suggestions, the sync offsets, the artifacts on
 * disk. `GET /api/meta/:id` and the PUT that saves an edit both answer with it (server.ts).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { getMatch, getUser, getVersus, matchPageUrl } from "../api/mcsrApi.js";
import { hookSuggestions } from "../pipeline/hooks.js";
import { computeMetrics } from "../pipeline/matchScore.js";
import { readSyncOffsets } from "../pipeline/syncFile.js";
import { buildTitle, metaPaths, type BuiltTitle } from "../pipeline/title.js";
import {
  playoffContextFor,
  playoffContextForId,
  playoffSeriesTail,
  playoffTitleTail,
} from "../playoffs/playoffs.js";
import { readSeriesRecord } from "../playoffs/series.js";
import { readManifest } from "../thumbnails/thumbnailVariants.js";
import { matchStatusFor } from "./matchStatus.js";

/** The file's text, or null when it is absent — or empty: a 0-byte edit is no edit. */
export async function readIfPresent(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  const text = await readFile(filePath, "utf8");
  return text.trim() === "" ? null : text;
}

export async function readMeta(matchId: number) {
  // One API request; the list variant costs one per match directory.
  const entry = await matchStatusFor(matchId);

  const title = metaPaths(matchId, "title");
  const description = metaPaths(matchId, "description");
  const chaptersPath = path.join(matchDir(matchId), `match-${matchId}.chapters.txt`);
  const tagsPath = path.join(matchDir(matchId), `match-${matchId}.tags.txt`);

  // The hook is the one part a human writes (src/pipeline/title.ts:5). buildTitle also returns the
  // character budget that keeps the title in the 70-100 band while leaving both nicknames
  // above YouTube's ~50-char mobile cutoff, which is what the editor counts against. The same
  // tail the pipeline wrote, playoff or ranked: a playoff tail is a third longer, so building the
  // budget on "MCSR Ranked 1v1" would bless a hook ~18 characters too long and preview a title
  // that is not the one on disk.
  const playoff = await playoffContextForId(matchId);
  // A joined series is game 1's directory (src/playoffs/series.ts): its title carries the round without
  // a game number, so the budget is built on that tail.
  const series = await readSeriesRecord(matchDir(matchId));
  const budget = buildTitle({
    leftNickname: entry.leftNickname,
    rightNickname: entry.rightNickname,
    ...(series
      ? { suffix: playoffSeriesTail(series.season, series.round) }
      : playoff
        ? { suffix: playoffTitleTail(playoff) }
        : {}),
  });
  const hookSuggestions = await readHookSuggestions(matchId, budget);

  return {
    matchId,
    leftNickname: entry?.leftNickname ?? null,
    rightNickname: entry?.rightNickname ?? null,
    title: (await readIfPresent(title.edited)) ?? (await readIfPresent(title.generated)),
    titleEdited: existsSync(title.edited),
    description: (await readIfPresent(description.edited)) ?? (await readIfPresent(description.generated)),
    descriptionEdited: existsSync(description.edited),
    chapters: await readIfPresent(chaptersPath),
    // The upload sends these verbatim; empty means the pipeline predates the file, and YouTube
    // then falls back to the Studio defaults that made all seven live videos share one tag set.
    tags: ((await readIfPresent(tagsPath)) ?? "")
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean),
    hook: {
      generated: budget.generated,
      placeholder: budget.title,
      min: budget.hookMin,
      max: budget.hookMax,
      /** Ranked openers built from the match's own numbers; empty when the match is unreadable. */
      suggestions: hookSuggestions,
    },
    // Where the two POVs actually got placed. Both exporters read this file, nothing showed it,
    // and a half-synced match looks exactly like a clean one on the page: when the countdown
    // detector finds one player's freeze and not the other's, the found side is corrected and
    // the other keeps the coarse estimate, so the two POVs can sit seconds apart in a video that
    // is otherwise ready to publish. Null for a match rendered before sync.json existed —
    // `npm run sync-status` derives one from the project.
    sync: readSyncOffsets(matchDir(matchId)),
    syncThreshold: config.syncConfidenceThreshold,
    matchUrl: matchPageUrl(matchId, entry.leftNickname, entry.season),
    // The games inside a joined series, for the head's line: each has its own sync check.
    series: series
      ? {
          round: series.round,
          bestOf: series.bestOf,
          games: series.games.map((g) => ({ matchId: g.matchId, gameNo: g.gameNo })),
          shortFromMatchId: series.shortFromMatchId ?? null,
        }
      : null,
    /** Why the entry is degraded (API unreachable), or null. Surfaced so "?" is never a lie. */
    error: entry.error,
    /**
     * Where the run actually put things. The TUI's success summary lists all of these and the
     * dashboard showed none, so the one artifact you open by hand — the Kdenlive project — was
     * the one thing it could not tell you the path of.
     */
    outputs: outputPaths(matchId, entry.projectPath),
  };
}

/**
 * Hook candidates for the title editor. Uncached, and four requests per metadata read: the match
 * (splits and deaths, which only the full record carries), both users (rank), and the versus
 * record (the rematch line). That is one operator opening one match, against a 500-per-10-minute
 * budget, so it is affordable; it would not be if this ran per row of the suggestions list.
 * A failure degrades to no suggestions rather than failing the whole metadata response, since
 * the title and description are still perfectly editable without them.
 */
async function readHookSuggestions(matchId: number, budget: BuiltTitle): Promise<string[]> {
  try {
    const match = await getMatch(matchId);
    const [left, right] = match.players;
    if (!left || !right) return [];
    const [userLeft, userRight, versus] = await Promise.all([
      getUser(left.uuid),
      getUser(right.uuid),
      // The head-to-head record, for the rematch opener. Its own catch: it is the one fact here
      // that only feeds a single chip, so losing it must not cost the other suggestions.
      getVersus(left.uuid, right.uuid).catch(() => undefined),
    ]);
    const input = {
      metrics: computeMetrics(match),
      match,
      userLeft,
      userRight,
      playoff: await playoffContextFor(match),
      maxChars: budget.hookMax,
      minChars: budget.hookMin,
      versus,
    };
    const hooks = await hookSuggestions(input);
    // Rank chips read live rank and drift within hours; the thumbnail's committed line wins so
    // both halves of a match agree. "Re-render with hook" rewrites the manifest, so choosing
    // differently is still one click.
    const committed = (await readManifest(matchDir(matchId)))?.hookText;
    return committed ? [committed, ...hooks.filter((h) => h !== committed)] : hooks;
  } catch (err) {
    console.error(`hook suggestions unavailable for ${matchId}: ${describeError(err)}`);
    return [];
  }
}

/** Absolute paths of the run's artifacts, each null until the stage that writes it has run. */
function outputPaths(matchId: number, projectPath: string | null) {
  const dir = matchDir(matchId);
  const ifPresent = (p: string) => (existsSync(p) ? path.resolve(p) : null);
  return {
    project: projectPath,
    title: ifPresent(metaPaths(matchId, "title").generated),
    description: ifPresent(metaPaths(matchId, "description").generated),
    chapters: ifPresent(path.join(dir, `match-${matchId}.chapters.txt`)),
    // The single overlay.mov is gone (see CLAUDE.md, "What the render actually produces"); the
    // per-frame artifact is now the timer strip, and the split stills sit beside it.
    overlay: ifPresent(path.join(dir, "overlay-timer.mp4")) ?? ifPresent(path.join(dir, "overlay.mov")),
    thumbnail: ifPresent(path.join(dir, "thumbnail.png")),
    // Written by `npm run validate-sync`, never by the pipeline — worth surfacing because it is
    // the only artifact that lets you eyeball whether the audio sync actually landed.
    syncPreview: ifPresent(path.join(dir, "sync-preview.mp4")),
  };
}
