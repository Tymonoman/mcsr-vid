/**
 * One X post a day for the channel (the operator, 14 Oct 2026: "go ahead and build the x
 * integration"): the hand-cut Short of the newest public long-form, its hook and the pair, and the
 * long-form's watch link. The clip is `short-<id>.mp4` from `npm run short:hand`, which already
 * passed the hook rules and ends before the result; nothing else is ever posted.
 *
 * Refused, before anything is signed: a blocked player, a long-form not public yet, no hand-cut
 * Short or one marked "No Short for this one" (`noShort`), a hook that fails `hookProblem`
 * (spoiler, label, seed/rank/elo), a post over 280, and a match already posted (`x.json`).
 * `xTick` is the dashboard's 15-minute tick's call, a no-op unless `config.xAutoPost` is on and
 * the four keys are in /app/.env.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getMatch } from "../api/mcsrApi.js";
import { blockedIn, config, matchDir } from "../config.js";
import { describeError } from "../errorText.js";
import { hiddenMatchIds } from "../dashboard/matchShelf.js";
import { readStatus } from "../dashboard/shortFlow.js";
import { blockedOnDisk, listProcessedMatchIds } from "../dashboard/matchStatus.js";
import { SEPARATOR, titleName } from "../pipeline/title.js";
import { dnfRefusal, matchIsDnf } from "../playoffs/playoffs.js";
import { readHandShort } from "../shorts/handShort.js";
import { hookProblem, HOOK_MAX_CHARS } from "../shorts/videoPick.js";
import { allUploads, readUpload, type UploadRecord } from "../youtube/youtubeStore.js";
import { createPost, isXConfigured, uploadVideo, X_API, xKeys } from "./xApi.js";

/** X's cap, and what it counts any link as (t.co), whatever its length. */
export const X_MAX_CHARS = 280;
const X_URL_CHARS = 23;

export interface XPlan {
  matchId: number;
  text: string;
  clipPath: string;
  videoId: string;
}

/** `x.json` in the match directory: the post that went out. Its presence means "posted". */
export interface XRecord {
  postId: string;
  at: string;
  text: string;
  mediaId: string;
}

export class XRefusal extends Error {}

const xFile = (matchId: number) => path.join(matchDir(matchId), "x.json");

/** When the long-form became public: its publish time, or its upload if it went up public. */
function publicSince(record: UploadRecord): number | null {
  const at = record.publishAt ?? (record.privacyStatus === "public" ? record.uploadedAt : null);
  return at ? Date.parse(at) : null;
}

/** What would be posted for this match, or why nothing is. Disk checks first, the API last. */
export async function planXPost(matchId: number, now = Date.now()): Promise<XPlan | string> {
  const dir = matchDir(matchId);
  const blocked = `match ${matchId} has a blocked player — never posted`;
  if (blockedOnDisk(dir)) return blocked;
  if (existsSync(xFile(matchId))) return `match ${matchId} is already on X (x.json)`;
  const record = await readUpload(matchId);
  const since = record && publicSince(record);
  if (!record || !since || since > now) return `match ${matchId}'s long-form is not public yet`;
  const clipPath = path.join(dir, `short-${matchId}.mp4`);
  const hand = await readHandShort(dir, matchId);
  if (!hand || !existsSync(clipPath)) return `match ${matchId} has no hand-cut Short (npm run short:hand)`;
  // "No Short for this one" leaves the hand file and mp4 on disk; the operator's no still holds.
  if (readStatus(matchId).noShort) return `match ${matchId} is marked no Short — never posted`;

  const { players } = await getMatch(matchId);
  const [left, right] = players;
  if (!left || !right) return `match ${matchId} does not have two players`;
  if (blockedIn([left.nickname, right.nickname])) return blocked;
  if (await matchIsDnf(matchId)) return dnfRefusal(matchId, "never posted");
  // hookProblem runs spoilsTheResult on the hook itself; the whole text is not run through it
  // again, since a question hook stops ending in "?" once the names and link follow it.
  const problem = hookProblem(hand.hook, HOOK_MAX_CHARS, players);
  if (problem) return `the Short's hook "${hand.hook}" ${problem}`;

  const link = `https://youtu.be/${record.videoId}`;
  const text = `${hand.hook.trim()}${SEPARATOR}${titleName(left.nickname)} vs ${titleName(right.nickname)}\n${link}\n#mcsr #minecraft`;
  const counted = text.length - link.length + X_URL_CHARS;
  if (counted > X_MAX_CHARS) return `the post runs ${counted} characters (X's cap is ${X_MAX_CHARS})`;
  return { matchId, text, clipPath, videoId: record.videoId };
}

/** Posts one match (or, dry, only plans it — nothing signed). Throws `XRefusal` with the reason. */
export async function postMatch(
  matchId: number,
  opts: { dryRun?: boolean; base?: string } = {},
): Promise<{ plan: XPlan; record: XRecord | null }> {
  const plan = await planXPost(matchId);
  if (typeof plan === "string") throw new XRefusal(plan);
  if (opts.dryRun) return { plan, record: null };
  const keys = xKeys();
  if (!keys)
    throw new XRefusal("X is not configured (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET)");
  const mediaId = await uploadVideo(plan.clipPath, keys, opts.base ?? X_API);
  const postId = await createPost(keys, plan.text, mediaId, opts.base ?? X_API);
  const record: XRecord = { postId, at: new Date().toISOString(), text: plan.text, mediaId };
  await writeFile(xFile(matchId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { plan, record };
}

/** The latest post on record across the media dir, or null. */
export async function lastXPost(): Promise<(XRecord & { matchId: number }) | null> {
  const posts = await Promise.all(
    listProcessedMatchIds().map(async (matchId) => {
      try {
        return { matchId, ...(JSON.parse(await readFile(xFile(matchId), "utf8")) as XRecord) };
      } catch {
        return null;
      }
    }),
  );
  return posts.filter((p) => p !== null).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

/** The newest public, unhidden long-form that `planXPost` lets through, or null. */
export async function pickXCandidate(now = Date.now()): Promise<XPlan | null> {
  const hidden = hiddenMatchIds();
  const uploads = (await allUploads())
    .map(({ matchId, record }) => ({ matchId, since: publicSince(record) ?? Infinity }))
    .filter((u) => !hidden.has(u.matchId) && u.since <= now)
    .sort((a, b) => b.since - a.since);
  for (const { matchId } of uploads) {
    // A read error (MCSR 429/5xx/timeout) skips this candidate; thrown, it would cost xTick the day.
    const plan = await planXPost(matchId, now).catch((err: unknown) => {
      console.error(`x: match ${matchId} skipped: ${describeError(err)}`);
      return "";
    });
    if (typeof plan !== "string") return plan;
  }
  return null;
}

/** At most one post per UTC day: the candidate, unless any `x.json` is already dated today. */
export async function autoPost(
  opts: { dryRun?: boolean; now?: number; base?: string } = {},
): Promise<string> {
  const now = opts.now ?? Date.now();
  const last = await lastXPost();
  if (last && last.at.slice(0, 10) === new Date(now).toISOString().slice(0, 10))
    return `already posted today (match ${last.matchId})`;
  const plan = await pickXCandidate(now);
  if (!plan) return "nothing to post";
  if (opts.dryRun) return `would post match ${plan.matchId}:\n${plan.text}`;
  const { record } = await postMatch(plan.matchId, { base: opts.base });
  return `posted match ${plan.matchId}: https://x.com/i/status/${record!.postId}`;
}

let ticking = false;
/** A failed attempt waits for the next UTC day (or a hand `npm run x -- post`), not 15 minutes. */
let failedOn = "";

/** The dashboard's 15-minute tick. Off, or without keys, it does nothing and says nothing. */
export async function xTick(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (!config.xAutoPost || !isXConfigured() || ticking || failedOn === today) return;
  ticking = true;
  try {
    const said = await autoPost();
    if (said.startsWith("posted")) console.error(`x: ${said}`);
  } catch (err) {
    failedOn = today;
    console.error(`x: ${describeError(err)} — next try tomorrow`);
  } finally {
    ticking = false;
  }
}
