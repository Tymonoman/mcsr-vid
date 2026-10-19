import { formatShortTime } from "../../remotion/format.js";
import type { SplitRow } from "./overlayProps.js";
import type { MatchInfo } from "../api/types.js";

export interface ChapterMarker {
  label: string;
  timeSec: number;
}

// YouTube requires chapters to be at least 10s apart (and the first at 0:00).
const MIN_CHAPTER_GAP_SEC = 10;

/**
 * Keeps the first chapter and every later one at least `minGapSec` past the previous KEPT one —
 * YouTube's own minimum. Shared by `buildChapters` (one match) and a series' merged, multi-game
 * list (`buildSeriesDescription`, src/pipeline/description.ts): a game's own "Start" chapter can
 * land within the gap of its own header line, or its "Result" within the gap of the next game's.
 */
export function filterChapterGap(
  chapters: readonly ChapterMarker[],
  minGapSec = MIN_CHAPTER_GAP_SEC,
): ChapterMarker[] {
  if (chapters.length === 0) return [];
  const filtered = [chapters[0]!];
  for (const c of chapters.slice(1)) {
    if (c.timeSec - filtered[filtered.length - 1]!.timeSec >= minGapSec) filtered.push(c);
  }
  return filtered;
}

/**
 * Builds YouTube chapter markers from split data, anchored to when the race starts in the
 * published video. `leadInSec` is the fixed gap before RTA 0:00 (see config.overlayLeadInSec) —
 * this assumes the final export is trimmed to start exactly at the overlay/intro clips' own
 * timeline start; shift every timestamp by hand if the export has extra pre-roll. The leading
 * "Start" chapter is always `timeSec: 0` — a single match's own 0:00 — so a series building one
 * game's sub-chapters (`src/playoffs/series.ts`) passes the game's absolute start-in-the-joined-
 * video as `leadInSec` and drops that first entry with `.slice(1)`: the game's header line is
 * its 0:00, not this function's.
 * ponytail: greedy min-gap filter over a true DNF-aware repack — fine for MCSR's checkpoint count.
 */
export function buildChapters(splits: SplitRow[], match: MatchInfo, leadInSec: number): ChapterMarker[] {
  const chapters: ChapterMarker[] = [{ label: "Start", timeSec: 0 }];

  for (const row of splits) {
    const times = [row.leftMs, row.rightMs].filter((t): t is number => t !== null);
    if (times.length === 0) continue;
    chapters.push({ label: row.label, timeSec: leadInSec + Math.min(...times) / 1000 });
  }

  if (match.result.time > 0) {
    chapters.push({ label: "Result", timeSec: leadInSec + match.result.time / 1000 });
  }

  return filterChapterGap(chapters);
}

/** `M:SS`, or `H:MM:SS` past the hour — a series video runs to fifty minutes and more. */
export function formatChapterTime(timeSec: number): string {
  const total = Math.max(0, Math.floor(timeSec));
  if (total < 3600) return formatShortTime(total * 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Formats chapters as YouTube-description-ready `M:SS Label` lines, one per line. */
export function formatChapters(chapters: ChapterMarker[]): string {
  return chapters.map((c) => `${formatChapterTime(c.timeSec)} ${c.label}`).join("\n");
}

/**
 * A description's chapter lines ("M:SS Label") moved `sec` later — a cold open joined in front of
 * the export (src/pipeline/coldOpen.ts); the 0:00 line stays the video's start. Floored like
 * `formatChapterTime`, so a line can land up to a second early, never late.
 */
export function shiftChapterLines(text: string, sec: number): string {
  if (!sec) return text;
  return text.replace(/^(\d+):(\d{2})(?::(\d{2}))?(\s+\S.*)$/gm, (line, a, b, c, rest: string) => {
    const t = c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
    if (t === 0) return line;
    const s = Math.floor(t + sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return `${h > 0 ? `${h}:${String(m).padStart(2, "0")}` : m}:${ss}${rest}`;
  });
}
