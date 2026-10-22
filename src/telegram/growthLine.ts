/**
 * The daily growth one-liner (22 Oct 2026, the operator: "b plus button to ask for more info"):
 * ten minutes after the morning report's hour, one silent line — "+N subs yesterday (M total) ·
 * V views · best: <hook> | <pair> (views)" — under a "More" button (`g:more:<date>`) that answers
 * with `/stats 7d` and that line's top 3 long-forms. Counts, titles and Studio links only: never a
 * comment's text or author.
 *
 * N and V are the channel's own counts (`channels.list`) against the snapshot the previous line
 * stored; "best" is the long-form public ≤3 days whose view count (`videos.list` statistics) grew
 * most since then — one with no stored count went public after the last line and counts from 0.
 * The first run only stores that baseline. Runs on the dashboard's 15-minute tick (8080 only)
 * behind `config.growthLine` (file-only, on): due from the report hour + 10 min for three hours,
 * once per Warsaw date (`.telegram.json`'s `growthLine`). A read that fails sends nothing, logs
 * once that day, and the next tick tries again.
 */
import { blockedIn, config } from "../config.js";
import { describeError } from "../errorText.js";
import { dataApiGet, videoStats, type VideoStats } from "../youtube/youtube.js";
import { allUploads, splitTitle, type UploadRecord } from "../youtube/youtubeStore.js";
import { answerCallbackQuery, escapeHtml, hasChat, sendMessage, type TgCallbackQuery } from "./bot.js";
import { parseStatsWindows } from "./commands.js";
import { titleHead } from "./commentNudge.js";
import { gatherFacts, type ChannelSnapshot } from "./facts.js";
import { renderStats } from "./report.js";
import { warsawDateStr, warsawParts } from "./schedule.js";
import { readTelegramState, updateTelegramState } from "./state.js";

const DAY_MS = 24 * 3_600_000;
const PUBLIC_WINDOW_MS = 3 * DAY_MS;
/** A More button older than this many days answers "expired". */
const MORE_DAYS = 7;

export interface TopVideo {
  videoId: string;
  /** "<hook> | <pair>" (`titleHead`). */
  title: string;
  /** Views since the previous line. */
  views: number;
}

export interface GrowthLineState {
  /** The Warsaw date of the last line (or of the first run's baseline) — the dedupe. */
  date: string;
  snapshot: ChannelSnapshot;
  /** Lifetime views then, per long-form public ≤3 days. */
  videoViews: Record<string, number>;
  /** Each line by date, kept `MORE_DAYS`; `more` once its button has answered. */
  lines: Record<string, { label: string; top: TopVideo[]; more?: true }>;
}

export interface GrowthDeps {
  channel: () => Promise<ChannelSnapshot>;
  uploads: () => Promise<Array<{ matchId: number; record: UploadRecord }>>;
  stats: (ids: string[]) => Promise<VideoStats[]>;
  /** `/stats 7d`'s own text, for the More button. */
  statsText: () => Promise<string>;
  now: () => number;
}

async function channelSnapshot(): Promise<ChannelSnapshot> {
  const body = await dataApiGet<{
    items?: Array<{ statistics: { subscriberCount?: string; viewCount?: string; videoCount?: string } }>;
  }>("/channels?part=statistics&mine=true");
  const s = body.items?.[0]?.statistics;
  const snap = {
    subscribers: Number(s?.subscriberCount),
    views: Number(s?.viewCount),
    videos: Number(s?.videoCount),
  };
  if (!Object.values(snap).every(Number.isFinite)) throw new Error("channels.list gave no channel counts");
  return snap;
}

const realDeps: GrowthDeps = {
  channel: channelSnapshot,
  uploads: allUploads,
  stats: videoStats,
  // dispatchCommand's own "/stats 7d", repeated here: index.ts imports this module.
  statsText: async () =>
    renderStats(
      (await gatherFacts(Date.now(), undefined, ["stats"])).stats,
      readTelegramState().prevSnapshot,
      parseStatsWindows("7d"),
    ),
  now: Date.now,
};

const fmt = (n: number): string => n.toLocaleString("en-US");
const studioLink = (v: TopVideo): string =>
  `<a href="https://studio.youtube.com/video/${v.videoId}/analytics/tab-overview/period-default">${escapeHtml(v.title)}</a>`;
export const moreCallbackData = (date: string): string => `g:more:${date}`;

/** Due from the report hour + 10 min until three hours past it (the report's own catch-up span). */
export function growthLineDue(nowMs: number, reportHour: number): boolean {
  const { h, mi } = warsawParts(nowMs);
  const sinceHour = h * 60 + mi - reportHour * 60;
  return sinceHour >= 10 && sinceHour < 180;
}

/** Whole days from a Warsaw date to today's. */
const daysOld = (date: string, nowMs: number): number =>
  (Date.parse(warsawDateStr(nowMs)) - Date.parse(date)) / DAY_MS;

export function growthLineText(
  live: ChannelSnapshot,
  prev: ChannelSnapshot,
  label: string,
  best: TopVideo | undefined,
): string {
  const subs = live.subscribers - prev.subscribers;
  return [
    `${subs >= 0 ? "+" : ""}${fmt(subs)} subs ${label} (${fmt(live.subscribers)} total)`,
    `${fmt(live.views - prev.views)} views`,
    ...(best ? [`best: ${studioLink(best)} (${fmt(best.views)})`] : []),
  ].join(" · ");
}

export function moreText(statsText: string, label: string, top: TopVideo[]): string {
  const list = top.length
    ? top.map((v, i) => `${i + 1}. ${studioLink(v)} — ${fmt(v.views)} views`).join("\n")
    : "No long-form public in the last 3 days.";
  return `${statsText}\n\n<b>Top long-forms, ${escapeHtml(label)}</b>\n${list}`;
}

let failedOn: string | null = null;

export async function growthLineTick(deps: GrowthDeps = realDeps): Promise<void> {
  const hour = config.telegramReportHourWarsaw;
  if (!config.growthLine || hour === null || !hasChat()) return;
  const now = deps.now();
  const date = warsawDateStr(now);
  const prev = readTelegramState().growthLine;
  if (prev?.date === date || !growthLineDue(now, hour)) return;

  let live: ChannelSnapshot;
  let fresh: Array<{ v: VideoStats; title: string }>;
  try {
    live = await deps.channel();
    const byVideo = new Map((await deps.uploads()).map((u) => [u.record.videoId, u.record]));
    const stats = byVideo.size ? await deps.stats([...byVideo.keys()]) : [];
    fresh = stats.flatMap((v) => {
      const record = byVideo.get(v.videoId);
      if (!record || v.privacyStatus !== "public") return [];
      const age = now - Date.parse(v.publishAt || record.publishAt || v.publishedAt);
      const pair = splitTitle(record.title);
      if (!(age >= 0 && age <= PUBLIC_WINDOW_MS) || (pair && blockedIn([pair.left, pair.right]))) return [];
      return [{ v, title: titleHead(record.title) }];
    });
  } catch (err) {
    if (failedOn !== date)
      console.error(`growth line: numbers unreadable, nothing sent — ${describeError(err)}`);
    failedOn = date;
    return;
  }

  const videoViews = Object.fromEntries(fresh.map(({ v }) => [v.videoId, v.views]));
  if (!prev) {
    updateTelegramState((s) => {
      s.growthLine = { date, snapshot: live, videoViews, lines: {} };
    });
    console.error("growth line: first reading saved — the first line goes out tomorrow");
    return;
  }
  const top = fresh
    .map(({ v, title }) => ({
      videoId: v.videoId,
      title,
      views: v.views - (prev.videoViews[v.videoId] ?? 0),
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 3);
  const label = prev.date === warsawDateStr(now - DAY_MS) ? "yesterday" : `since ${prev.date}`;
  await sendMessage(growthLineText(live, prev.snapshot, label, top[0]), {
    html: true,
    silent: true,
    keyboard: { inline_keyboard: [[{ text: "More", callback_data: moreCallbackData(date) }]] },
  });
  updateTelegramState((s) => {
    const lines = Object.fromEntries(
      Object.entries(s.growthLine?.lines ?? {}).filter(([d]) => daysOld(d, now) <= MORE_DAYS),
    );
    lines[date] = { label, top };
    s.growthLine = { date, snapshot: live, videoViews, lines };
  });
}

/** `g:more:<date>`. index.ts's `handleUpdate` lets only the operator's own press through. */
export async function handleGrowthCallback(cq: TgCallbackQuery, deps: GrowthDeps = realDeps): Promise<void> {
  const answer = (text?: string) =>
    answerCallbackQuery(cq.id, text).catch((err: unknown) =>
      console.error(`growth line: answerCallbackQuery failed — ${describeError(err)}`),
    );
  const date = /^g:more:(\d{4}-\d{2}-\d{2})$/.exec(cq.data ?? "")?.[1];
  const line = date ? readTelegramState().growthLine?.lines[date] : undefined;
  if (!date || !line || daysOld(date, deps.now()) > MORE_DAYS) return answer("that button has expired");
  if (line.more) return answer("already sent");
  // Marked before the slow stats read, so a double tap never sends twice.
  const mark = (more: true | undefined) =>
    updateTelegramState((s) => {
      const l = s.growthLine?.lines[date];
      if (l) l.more = more;
    });
  mark(true);
  await answer();
  try {
    await sendMessage(moreText(await deps.statsText(), line.label, line.top), { html: true });
  } catch (err) {
    mark(undefined);
    await sendMessage(`More failed: ${describeError(err)}`).catch(() => undefined);
  }
}
