/**
 * Silent comment-count nudges (22 Oct 2026, "silent notifications but yes"): a long-form in its
 * first 48h public crosses 1, 5, 10 or 25 comments and the operator gets one line, delivered
 * without a sound — the title's hook and pair, the count, how long since publishing, and the
 * Studio comments link. Counts only: no comment text, no author, ever.
 *
 * Runs on the dashboard's 15-minute tick (src/dashboard/server.ts) behind `config.commentNudges`
 * (file-only, default off). Dedupe is `.telegram.json`'s `commentNudges` — per video, the highest
 * threshold already sent — so a count that jumps past two thresholds between ticks sends the
 * highest one only, and nothing is ever repeated. A Data API failure costs the tick nothing: it is
 * logged and the next tick tries again.
 */
import { blockedIn, config } from "../config.js";
import { describeError } from "../errorText.js";
import { videoStats, type VideoStats } from "../youtube/youtube.js";
import { allUploads, splitTitle, type UploadRecord } from "../youtube/youtubeStore.js";
import { escapeHtml, hasChat, sendMessage, type SendOptions } from "./bot.js";
import { readTelegramState, updateTelegramState } from "./state.js";

export const NUDGE_THRESHOLDS = [1, 5, 10, 25] as const;
const PUBLIC_WINDOW_MS = 48 * 3_600_000;

export interface NudgeDeps {
  uploads: () => Promise<Array<{ matchId: number; record: UploadRecord }>>;
  stats: (ids: string[]) => Promise<VideoStats[]>;
  send: (text: string, opts: SendOptions) => Promise<void>;
  now: () => number;
}

const realDeps: NudgeDeps = { uploads: allUploads, stats: videoStats, send: sendMessage, now: Date.now };

/** The highest threshold `count` reaches, or null below the first. */
export const thresholdReached = (count: number): number | null =>
  [...NUDGE_THRESHOLDS].reverse().find((t) => count >= t) ?? null;

/** "2 h after publishing" / "35 min after publishing" — whole units, never a decimal. */
export const sinceText = (ms: number): string => {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 60 ? `${min} min after publishing` : `${Math.round(min / 60)} h after publishing`;
};

export function nudgeText(title: string, videoId: string, count: number, sinceMs: number): string {
  const parts = splitTitle(title);
  const head = parts ? `${parts.hook} | ${parts.left} vs ${parts.right}` : title;
  const noun = count === 1 ? "comment" : "comments";
  return (
    `${escapeHtml(head)}: ${count} ${noun}, ${sinceText(sinceMs)} · ` +
    `<a href="https://studio.youtube.com/video/${videoId}/comments">Studio</a>`
  );
}

export async function commentNudgeTick(deps: NudgeDeps = realDeps): Promise<void> {
  if (!config.commentNudges || !hasChat()) return;
  const uploads = await deps.uploads();
  // One record per video id: a series' games all carry game 1's id.
  const byVideo = new Map(uploads.map((u) => [u.record.videoId, u.record]));
  if (byVideo.size === 0) return;
  let live: VideoStats[];
  try {
    live = await deps.stats([...byVideo.keys()]);
  } catch (err) {
    console.error(`comment nudges: ${describeError(err)} — next tick`);
    return;
  }
  const now = deps.now();
  const sent = readTelegramState().commentNudges;
  for (const v of live) {
    if (v.privacyStatus !== "public") continue;
    const record = byVideo.get(v.videoId);
    if (!record) continue;
    const publicAt = v.publishAt || record.publishAt || v.publishedAt;
    const sinceMs = publicAt ? now - Date.parse(publicAt) : Number.NaN;
    if (!(sinceMs >= 0 && sinceMs <= PUBLIC_WINDOW_MS)) continue;
    const pair = splitTitle(record.title);
    if (pair && blockedIn([pair.left, pair.right])) continue;
    const threshold = thresholdReached(v.comments);
    if (threshold === null || (sent[v.videoId] ?? 0) >= threshold) continue;
    await deps.send(nudgeText(record.title, v.videoId, v.comments, sinceMs), { html: true, silent: true });
    updateTelegramState((s) => {
      s.commentNudges[v.videoId] = threshold;
    });
  }
}
