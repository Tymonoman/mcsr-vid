import type { SplitRow } from "./overlayProps.js";
import type { MatchInfo } from "./types.js";

export interface ChapterMarker {
  label: string;
  timeSec: number;
}

// YouTube requires chapters to be at least 10s apart (and the first at 0:00).
const MIN_CHAPTER_GAP_SEC = 10;

/**
 * Builds YouTube chapter markers from split data, anchored to when the race starts in the
 * published video. `leadInSec` is the fixed gap before RTA 0:00 (see config.overlayLeadInSec) —
 * this assumes the final export is trimmed to start exactly at the overlay/intro clips' own
 * timeline start; shift every timestamp by hand if the export has extra pre-roll.
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

  const filtered = [chapters[0]];
  for (const c of chapters.slice(1)) {
    if (c.timeSec - filtered[filtered.length - 1].timeSec >= MIN_CHAPTER_GAP_SEC) filtered.push(c);
  }
  return filtered;
}

function formatTimestamp(sec: number): string {
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Formats chapters as YouTube-description-ready `M:SS Label` lines, one per line. */
export function formatChapters(chapters: ChapterMarker[]): string {
  return chapters.map((c) => `${formatTimestamp(c.timeSec)} ${c.label}`).join("\n");
}
