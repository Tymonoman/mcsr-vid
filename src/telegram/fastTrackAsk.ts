/**
 * The fast-track ask (18 Oct 2026). `fastTrack.ts` jumps a really-good match's render ahead of
 * the nightly clock, but its upload still claims an ordinary publish slot — often a day or two
 * out (CLAUDE.md "House rules": the slot-shuffle that would move other matches back is left to
 * the operator on purpose). The operator, told that, asked: "the last part you mentioned is
 * perfect give me a splits view image and a link to magmamcsr and a yes or no to move it and
 * post asap." This is that message.
 *
 * Registered on `shortFlow.ts`'s `setFastTrackUploadedHook` the same way `titlePicker.ts`
 * registers `setAutoHooksSavedHook` — this module imports `shortFlow.ts`, never the reverse, so
 * the chain never has to know this file exists.
 */
import { readFileSync } from "node:fs";
import { getMatch, matchPageUrl } from "../api/mcsrApi.js";
import { matchDir } from "../config.js";
import { readFastTrackState } from "../dashboard/fastTrack.js";
import { setFastTrackUploadedHook, setPublishTime } from "../dashboard/shortFlow.js";
import { describeError } from "../errorText.js";
import { overlayPaths } from "../pipeline/overlayRender.js";
import { titleName } from "../pipeline/title.js";
import { readUpload } from "../youtube/youtubeStore.js";
import * as bot from "./bot.js";
import { whenWarsaw } from "./report.js";
import { readTelegramState, updateTelegramState } from "./state.js";

/** `f:<matchId>:y`/`:n` — never the slot itself (Telegram's 64-byte `callback_data` cap); a
 *  press reads the match's current upload record back off disk instead. */
const callbackData = (matchId: number, choice: "y" | "n"): string => `f:${matchId}:${choice}`;
const CALLBACK_RE = /^f:(\d+):(y|n)$/;

/** Under 2h out, or already public, is "too soon to bother YouTube over" — answered without a
 *  `reschedule` call at all. */
const TOO_SOON_MS = 2 * 60 * 60 * 1000;
/** How far out "post ASAP" schedules it — a real lead time, not "right now", so the upload's own
 *  privacy-at-publish-time plumbing has room to work. */
const ASAP_LEAD_MS = 20 * 60 * 1000;

/** The splits still one state before the subscribe card — CLAUDE.md "the manifest, written
 *  last, means render finished" / "Last state is the subscribe card": that is always the final
 *  entry, so the one before it is the last real view of the race. A single-state manifest (no
 *  card at all) has nothing before it, so that lone state stands in. Null when there is no
 *  manifest yet, which never happens for a match whose long-form has already uploaded. */
function lastSplitsStill(matchId: number): string | null {
  try {
    const stills = JSON.parse(readFileSync(overlayPaths(matchDir(matchId)).manifest, "utf8")) as Array<{
      path: string;
    }>;
    if (stills.length === 0) return null;
    return stills.length > 1 ? stills[stills.length - 2]!.path : stills[0]!.path;
  } catch {
    return null;
  }
}

/** Fired by `shortFlow.ts` after every long-form upload; a no-op for a match the operator never
 *  fast-tracked, or one already asked about. */
export async function sendFastTrackAsk(matchId: number): Promise<void> {
  if (!bot.hasChat()) return;
  if (readTelegramState().fastTrackAsks[String(matchId)]) return;
  const hit = readFastTrackState()
    .hits.filter((h) => h.matchId === matchId)
    .at(-1);
  if (!hit) return; // not fast-tracked — every other match's upload fires this hook too
  const record = await readUpload(matchId, "video");
  if (!record) return; // the hook fired before the record was written — never happens, but no photo without one
  const photo = lastSplitsStill(matchId);
  if (!photo) return; // no splits render on disk — never happens for an already-uploaded match
  const match = await getMatch(matchId);
  const [left, right] = match.players;
  const caption = [
    `<b>${bot.escapeHtml(titleName(left!.nickname))} vs ${bot.escapeHtml(titleName(right!.nickname))}</b>`,
    `Fast-tracked: ${bot.escapeHtml(hit.reason)}`,
    record.publishAt ? `Scheduled: ${bot.escapeHtml(whenWarsaw(record.publishAt))}` : "Not scheduled yet",
    bot.escapeHtml(matchPageUrl(matchId, left!.nickname, match.season)),
  ].join("\n");
  const keyboard: bot.InlineKeyboard = {
    inline_keyboard: [
      [
        { text: "✅ Post ASAP", callback_data: callbackData(matchId, "y") },
        { text: "❌ Keep its slot", callback_data: callbackData(matchId, "n") },
      ],
    ],
  };
  const sent = await bot.sendPhoto(photo, caption, { html: true, keyboard });
  updateTelegramState((s) => {
    s.fastTrackAsks[String(matchId)] = { messageId: sent.message_id, at: new Date().toISOString() };
  });
}

setFastTrackUploadedHook((matchId) => {
  void sendFastTrackAsk(matchId).catch((err: unknown) =>
    console.error(`fastTrackAsk: offer for #${matchId} failed — ${describeError(err)}`),
  );
});

/* --- The press ------------------------------------------------------------------------------- */

/** Gated by `index.ts`'s `handleUpdate` exactly like `handleTitleCallback` — the operator's own
 *  chat, pressed by the operator, before this is trusted. */
export async function handleFastTrackCallback(cq: bot.TgCallbackQuery): Promise<void> {
  const m = CALLBACK_RE.exec(cq.data ?? "");
  const chat = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  if (!m || chat === undefined || messageId === undefined) {
    await answerSafely(cq.id, "that button has expired");
    return;
  }
  const matchId = Number(m[1]);
  try {
    if (m[2] === "y") await postAsap(matchId, chat, messageId, cq.id);
    else await keepSlot(matchId, chat, messageId, cq.id);
  } catch (err) {
    await answerSafely(cq.id, "failed");
    await editSafely(chat, messageId, `Could not update: ${describeError(err)}`);
  }
}

function settle(matchId: number): void {
  updateTelegramState((s) => {
    const o = s.fastTrackAsks[String(matchId)];
    if (o) o.settled = true;
  });
}

async function answerSafely(id: string, text?: string): Promise<void> {
  await bot
    .answerCallbackQuery(id, text)
    .catch((err: unknown) =>
      console.error(`fastTrackAsk: answerCallbackQuery failed — ${describeError(err)}`),
    );
}

async function editSafely(chat: number, messageId: number, caption: string): Promise<void> {
  await bot
    .editMessageCaption(chat, messageId, caption)
    .catch((err: unknown) =>
      console.error(`fastTrackAsk: editMessageCaption failed — ${describeError(err)}`),
    );
}

async function postAsap(matchId: number, chat: number, messageId: number, cqId: string): Promise<void> {
  const offer = readTelegramState().fastTrackAsks[String(matchId)];
  if (!offer || offer.settled) {
    await answerSafely(cqId, "that offer is gone");
    return;
  }
  const record = await readUpload(matchId, "video");
  const tooSoon =
    !record ||
    record.privacyStatus !== "private" ||
    !record.publishAt ||
    Date.parse(record.publishAt) - Date.now() < TOO_SOON_MS;
  settle(matchId);
  if (tooSoon) {
    await editSafely(chat, messageId, "Already soon/public — nothing changed.");
    await answerSafely(cqId, "already soon/public");
    return;
  }
  const nowMs = Date.now();
  // The same `setPublishTime`/`move: true` the dashboard's own Move-on-YouTube button drives:
  // rewrites only this video's `status.publishAt`, moves its Short too if one is already on the
  // channel or scheduled, and leaves an unposted Short alone — it reads the video's new time
  // fresh when it finally uploads, so there is nothing to move there.
  const result = await setPublishTime(
    matchId,
    { publishAt: new Date(nowMs + ASAP_LEAD_MS).toISOString(), move: true },
    nowMs,
  );
  if (result.status !== 200) {
    await editSafely(chat, messageId, `Could not move: ${String(result.body.error)}`);
    await answerSafely(cqId, "failed");
    return;
  }
  await editSafely(chat, messageId, `Posting at ${whenWarsaw(String(result.body.publishAt))}`);
  await answerSafely(cqId, "posting soon");
}

async function keepSlot(matchId: number, chat: number, messageId: number, cqId: string): Promise<void> {
  const offer = readTelegramState().fastTrackAsks[String(matchId)];
  if (!offer || offer.settled) {
    await answerSafely(cqId, "that offer is gone");
    return;
  }
  settle(matchId);
  const record = await readUpload(matchId, "video");
  await editSafely(
    chat,
    messageId,
    `Keeping ${record?.publishAt ? whenWarsaw(record.publishAt) : "its slot"}`,
  );
  await answerSafely(cqId, "keeping its slot");
}
