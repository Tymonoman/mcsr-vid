/**
 * The Telegram title picker (18 Oct 2026, the operator choosing who writes titles: "I send you 3
 * options on Telegram and you pick", then "c and let me answer on telegram with buttons under
 * the message. also show me the thumbnails").
 *
 * A dashboard tick (`titleOfferTick`, 8080 only) offers the operator a match's thumbnail with up
 * to three title buttons the moment it is ready for one; a press either saves the hooks (not yet
 * uploaded) or retitles the live video (already on the channel) — the one exception to "every
 * bot command is read-only" (CLAUDE.md "Telegram bot"; the handbook has the full shape).
 *
 * A fourth row (18 Oct 2026) lets the operator veto: not yet uploaded, it hides the match (never
 * auto-hooked, nightly-repicked or re-offered) with a 24h Undo; already uploaded, nothing here
 * deletes or reschedules it — the message just points at Studio and the match is hidden too.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { getMatch } from "../api/mcsrApi.js";
import type { MatchInfo } from "../api/types.js";
import { blockedIn, config, matchDir } from "../config.js";
import {
  chooseAutoHooks,
  factsOf,
  readStatus,
  saveHooks,
  seriesGameUnjoined,
  setAutoHooksSavedHook,
  syncWeak,
  videoPublishTime,
  type Facts,
} from "../dashboard/shortFlow.js";
import { hiddenMatchIds, setHidden } from "../dashboard/matchShelf.js";
import { blockedOnDisk, listProcessedMatchIds } from "../dashboard/matchStatus.js";
import { describeError } from "../errorText.js";
import { metaPaths, titleName } from "../pipeline/title.js";
import { titleOptions as realTitleOptions, type TitleOptions } from "../pipeline/titleOptions.js";
import { matchIsDnf } from "../playoffs/playoffs.js";
import { retitleHook } from "../youtube/youtube.js";
import * as bot from "./bot.js";
import { dashboardMatchUrl } from "./facts.js";
import { whenWarsaw } from "./report.js";
import { readTelegramState, updateTelegramState } from "./state.js";

/** The deps seam: `titleOptions.ts` is titles/policy's own file, still a stub on this branch. */
export type TitleOptionsFn = (matchId: number, opts?: { fresh?: boolean }) => Promise<TitleOptions>;
let titleOptionsImpl: TitleOptionsFn = realTitleOptions;
export const setTitleOptionsImpl = (fn: TitleOptionsFn): void => {
  titleOptionsImpl = fn;
};

/** `t:<matchId>:<index>` for an option, `t:<matchId>:r` for "New options", `:x` for the veto,
 *  `:u` for its Undo — the title itself never travels here (Telegram's 64-byte `callback_data`
 *  cap); the per-match cache in `.telegram.json`'s `titleOffers` is what a press reads its text
 *  back from. */
const callbackData = (matchId: number, idx: number | "r" | "x" | "u"): string => `t:${matchId}:${idx}`;
const CALLBACK_RE = /^t:(\d+):(\d+|r|x|u)$/;

const offerCaption = (
  matchId: number,
  left: string,
  right: string,
  slotAt: Date,
  opt?: { options: string[]; whys?: string[] },
): string =>
  [
    `<b>${bot.escapeHtml(titleName(left))} vs ${bot.escapeHtml(titleName(right))}</b>`,
    `Next free slot: ${bot.escapeHtml(whenWarsaw(slotAt.toISOString()))}`,
    bot.escapeHtml(`${dashboardMatchUrl()}/#match=${matchId}`),
    // Why each option (19 Oct 2026, the operator's ask); an older cache has no reasons.
    ...(opt?.whys?.some((w) => w)
      ? ["", ...opt.options.map((o, i) => `${i + 1}. <b>${bot.escapeHtml(o)}</b>${opt.whys?.[i] ? ` — ${bot.escapeHtml(opt.whys[i]!)}` : ""}`)]
      : []),
  ].join("\n");

/** `uploaded`: whether the long-form is already on the channel — picks the veto row's wording. */
const offerKeyboard = (
  matchId: number,
  options: readonly string[],
  uploaded: boolean,
): bot.InlineKeyboard => ({
  inline_keyboard: [
    ...options.map((text, i) => [{ text, callback_data: callbackData(matchId, i) }]),
    [{ text: "🔄 New options", callback_data: callbackData(matchId, "r") }],
    [
      {
        text: uploaded ? "🚫 Cancel this upload" : "🚫 Don't post this one",
        callback_data: callbackData(matchId, "x"),
      },
    ],
  ],
});

/** The sole button left on a veto message, for 24h — reverses it. */
const undoKeyboard = (matchId: number): bot.InlineKeyboard => ({
  inline_keyboard: [[{ text: "↩️ Undo", callback_data: callbackData(matchId, "u") }]],
});

const VETO_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

/* --- Who is due ---------------------------------------------------------------------------------
 *
 * Reuses `autoHooksTick`'s own "due" reads (src/dashboard/shortFlow.ts, exported for this) minus
 * its hours wait: the operator wants the offer the moment a pick is readable, not hours later.
 */

export interface DueTitleOffer {
  matchId: number;
  match: MatchInfo;
  f: Facts;
}

export async function dueForTitleOffer(): Promise<DueTitleOffer[]> {
  const hidden = hiddenMatchIds();
  const offered = readTelegramState().titleOffers;
  const out: DueTitleOffer[] = [];
  for (const matchId of listProcessedMatchIds()) {
    if (hidden.has(matchId) || offered[String(matchId)]) continue;
    const status = readStatus(matchId);
    if (status.hooksSavedAt || status.noShort) continue;
    const f = await factsOf(matchId);
    if (!f.pick || f.video || f.short) continue;
    let match: MatchInfo;
    try {
      match = await getMatch(matchId);
    } catch {
      continue; // the API is down — try again next tick
    }
    const [left, right] = match.players;
    if (!left || !right) continue;
    if (blockedIn([left.nickname, right.nickname]) || blockedOnDisk(f.dir)) continue;
    if (await matchIsDnf(matchId)) continue;
    if (await seriesGameUnjoined(match, f.series)) continue;
    if (syncWeak(matchId, f)) continue;
    out.push({ matchId, match, f });
  }
  return out;
}

let ticking = false;

/** Driven by the same 15-minute tick as `shortTick`/`autoHooksTick` (server.ts). A no-op without
 *  a paired chat — there is nobody to send the offer to. */
export async function titleOfferTick(): Promise<void> {
  if (!bot.hasChat() || ticking) return;
  ticking = true;
  try {
    for (const { matchId, match } of await dueForTitleOffer()) {
      try {
        await sendTitleOffer(matchId, match);
      } catch (err) {
        console.error(`titlePicker: offer for #${matchId} failed — ${describeError(err)}`);
      }
    }
  } finally {
    ticking = false;
  }
}

/* --- Sending the offer ---------------------------------------------------------------------------
 *
 * No dedupe check in here on purpose: the tick's own dedupe is `dueForTitleOffer`'s job, and
 * `npm run tg -- titles <id>` (tgCli.ts) calls straight into this to resend a match's offer —
 * including one already on the channel, the retitle case — regardless of whether it was offered
 * before.
 */

export async function sendTitleOffer(
  matchId: number,
  match: MatchInfo,
  opts: { fresh?: boolean } = {},
): Promise<void> {
  const thumb = path.join(matchDir(matchId), "thumbnail.png");
  if (!existsSync(thumb)) {
    console.error(`titlePicker: #${matchId} has no thumbnail.png yet — offered a later tick`);
    return;
  }
  const opt = await titleOptionsImpl(matchId, { fresh: opts.fresh === true });
  if (opt.options.length === 0) return; // nothing to put on a button yet
  const f = await factsOf(matchId);
  const slot = await videoPublishTime(matchId, Date.now());
  const [left, right] = match.players;
  const caption = offerCaption(matchId, left!.nickname, right!.nickname, slot.at, opt);
  const keyboard = offerKeyboard(matchId, opt.options, f.video !== null);
  const sent = await bot.sendPhoto(thumb, caption, { html: true, keyboard });
  updateTelegramState((s) => {
    s.titleOffers[String(matchId)] = {
      messageId: sent.message_id,
      options: opt.options,
      source: opt.source,
      at: new Date().toISOString(),
    };
  });
}

/* --- The press ------------------------------------------------------------------------------- */

/**
 * Handles one button press. Called only for a `callback_query` already checked against
 * `TELEGRAM_CHAT_ID` (index.ts's `handleUpdate`, the same gate a plain message gets) — this
 * function trusts `cq.message.chat.id` once it is here. A malformed `data`, a stale match or a
 * cache miss is answered and otherwise ignored, never thrown.
 */
export async function handleTitleCallback(cq: bot.TgCallbackQuery): Promise<void> {
  const m = CALLBACK_RE.exec(cq.data ?? "");
  const chat = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  if (!m || chat === undefined || messageId === undefined) {
    await answerSafely(cq.id, "that button has expired");
    return;
  }
  const matchId = Number(m[1]);
  const key = m[2]!;
  try {
    if (key === "r") {
      const { message } = await refreshOffer(matchId, chat, messageId);
      await answerSafely(cq.id, message);
    } else if (key === "x") await vetoOffer(matchId, chat, messageId, cq.id);
    else if (key === "u") await undoVeto(matchId, chat, messageId, cq.id);
    else await chooseOption(matchId, chat, messageId, Number(key), cq.id);
  } catch (err) {
    await answerSafely(cq.id, "failed");
    await editSafely(chat, messageId, `Could not save: ${describeError(err)}`);
  }
}

async function answerSafely(id: string, text?: string): Promise<void> {
  await bot
    .answerCallbackQuery(id, text)
    .catch((err: unknown) =>
      console.error(`titlePicker: answerCallbackQuery failed — ${describeError(err)}`),
    );
}

async function editSafely(
  chat: number,
  messageId: number,
  caption: string,
  opts: { html?: boolean; keyboard?: bot.InlineKeyboard } = {},
): Promise<void> {
  await bot
    .editMessageCaption(chat, messageId, caption, opts)
    .catch((err: unknown) => console.error(`titlePicker: editMessageCaption failed — ${describeError(err)}`));
}

function markSettled(matchId: number): void {
  updateTelegramState((s) => {
    const o = s.titleOffers[String(matchId)];
    if (o) o.settled = true;
  });
}

/** Regenerates one match's offer and edits its message in place — the button press's "r" and
 *  `refreshOpenOffers` below both go through this. Returns rather than answers a callback query
 *  itself, since the latter has none to answer. */
async function refreshOffer(
  matchId: number,
  chat: string | number,
  messageId: number,
): Promise<{ ok: boolean; message: string }> {
  const match = await getMatch(matchId);
  const opt = await titleOptionsImpl(matchId, { fresh: true });
  if (opt.options.length === 0) return { ok: false, message: "no fresh options came back" };
  const f = await factsOf(matchId);
  const slot = await videoPublishTime(matchId, Date.now());
  const [left, right] = match.players;
  const caption = offerCaption(matchId, left!.nickname, right!.nickname, slot.at, opt);
  await bot.editMessageCaption(chat, messageId, caption, {
    html: true,
    keyboard: offerKeyboard(matchId, opt.options, f.video !== null),
  });
  updateTelegramState((s) => {
    const o = s.titleOffers[String(matchId)];
    if (o) {
      o.options = opt.options;
      o.source = opt.source;
    }
  });
  return { ok: true, message: "fresh options" };
}

async function chooseOption(
  matchId: number,
  chat: number,
  messageId: number,
  idx: number,
  cqId: string,
): Promise<void> {
  const offer = readTelegramState().titleOffers[String(matchId)];
  const title = offer?.options[idx];
  if (!offer || offer.settled || title === undefined) {
    await answerSafely(cqId, "that offer is gone — try /titles again");
    return;
  }
  const f = await factsOf(matchId);
  const match = await getMatch(matchId);
  if (blockedIn(match.players.map((p) => p.nickname)) || blockedOnDisk(matchDir(matchId))) {
    markSettled(matchId);
    await editSafely(chat, messageId, "Could not save: a blocked runner's match — nothing written");
    await answerSafely(cqId, "blocked");
    return;
  }
  let ok = true;
  let message = title;
  if (f.video) {
    const videoId = f.video.videoId;
    if (!videoId) {
      ok = false;
      message = "no video id on record for this match — retitle it in Studio";
    } else {
      const r = await retitleHook(videoId, title, config.youtubeChannelId);
      await writeFile(metaPaths(matchId, "title").edited, `${r.title}\n`, "utf8");
      message = r.title;
    }
  } else {
    const choice = await chooseAutoHooks(matchId, match, f).catch(() => null);
    const shortHook = choice?.shortHook ?? null;
    const saved = await saveHooks(matchId, { titleHook: title, shortHook, noShort: shortHook === null });
    if (saved && "status" in saved) {
      ok = false;
      message = saved.error;
    }
  }
  markSettled(matchId);
  await editSafely(chat, messageId, ok ? `Saved: ${message}` : `Could not save: ${message}`);
  await answerSafely(cqId, ok ? "saved" : "failed");
}

/* --- The veto ------------------------------------------------------------------------------- */

/**
 * `t:<id>:x`. Not yet uploaded: hides the match (`setHidden` — the same mechanism the dashboard's
 * own Hide/Delete-from-plan use, so auto-hooks, the nightly's pick and `dueForTitleOffer` all stay
 * off it already) and leaves a lone Undo button for `VETO_UNDO_WINDOW_MS`. Already uploaded:
 * changes nothing on YouTube — the operator's standing rule is nothing here deletes a video or
 * touches its privacy — just points at Studio and hides the match too, with no Undo (there is
 * nothing this bot can undo once it is live).
 */
async function vetoOffer(matchId: number, chat: number, messageId: number, cqId: string): Promise<void> {
  const offer = readTelegramState().titleOffers[String(matchId)];
  if (!offer || offer.settled) {
    await answerSafely(cqId, "that offer is gone — try /titles again");
    return;
  }
  const f = await factsOf(matchId);
  setHidden(matchId, true);
  if (f.video) {
    // No undo here (the video is on YouTube), but the decision still buys tonight a render
    // (src/dashboard/renderBudget.ts reads vetoedUploadedAt; undoVeto reads only vetoedAt).
    updateTelegramState((s) => {
      const o = s.titleOffers[String(matchId)];
      if (o) {
        o.settled = true;
        o.vetoedUploadedAt = new Date().toISOString();
      }
    });
    const studio = f.video.videoId ? `https://studio.youtube.com/video/${f.video.videoId}/edit` : null;
    await editSafely(
      chat,
      messageId,
      studio
        ? `Already uploaded — delete or unschedule it in <a href="${studio}">Studio</a>.`
        : "Already uploaded — delete or unschedule it in Studio.",
      { html: true },
    );
    await answerSafely(cqId, "hidden");
    return;
  }
  updateTelegramState((s) => {
    const o = s.titleOffers[String(matchId)];
    if (o) {
      o.settled = true;
      o.vetoedAt = new Date().toISOString();
    }
  });
  await editSafely(chat, messageId, "Vetoed — won't be posted", { keyboard: undoKeyboard(matchId) });
  await answerSafely(cqId, "vetoed");
}

/** `t:<id>:u`, within `VETO_UNDO_WINDOW_MS` of the veto: unhides the match and re-offers the same
 *  3 title buttons. Past the window, or with nothing to undo, leaves the veto standing. */
async function undoVeto(matchId: number, chat: number, messageId: number, cqId: string): Promise<void> {
  const offer = readTelegramState().titleOffers[String(matchId)];
  if (!offer?.vetoedAt) {
    await answerSafely(cqId, "nothing to undo");
    return;
  }
  if (Date.now() - Date.parse(offer.vetoedAt) > VETO_UNDO_WINDOW_MS) {
    await editSafely(chat, messageId, "Vetoed — won't be posted");
    await answerSafely(cqId, "that undo has expired");
    return;
  }
  setHidden(matchId, false);
  const match = await getMatch(matchId);
  const f = await factsOf(matchId);
  const slot = await videoPublishTime(matchId, Date.now());
  const [left, right] = match.players;
  const cached = await titleOptionsImpl(matchId).catch(() => null);
  const caption = offerCaption(matchId, left!.nickname, right!.nickname, slot.at, {
    options: offer.options,
    whys: cached && cached.options.join("\n") === offer.options.join("\n") ? cached.whys : undefined,
  });
  await bot.editMessageCaption(chat, messageId, caption, {
    html: true,
    keyboard: offerKeyboard(matchId, offer.options, f.video !== null),
  });
  updateTelegramState((s) => {
    const o = s.titleOffers[String(matchId)];
    if (o) {
      o.settled = false;
      delete o.vetoedAt;
    }
  });
  await answerSafely(cqId, "restored");
}

/* --- Auto-hooks edits the same message, if there was one -------------------------------------- */

/** Exported for the test: real traffic reaches this only through `setAutoHooksSavedHook` below. */
export async function onAutoHooksSaved(matchId: number, titleHook: string): Promise<void> {
  const offer = readTelegramState().titleOffers[String(matchId)];
  if (!offer || offer.settled || !bot.hasChat()) return;
  markSettled(matchId);
  await bot.editMessageCaption(bot.chatId()!, offer.messageId, `Auto-saved: ${titleHook}`);
}

setAutoHooksSavedHook((matchId, titleHook) => {
  void onAutoHooksSaved(matchId, titleHook).catch((err: unknown) =>
    console.error(`titlePicker: editing the auto-saved offer failed — ${describeError(err)}`),
  );
});

/* --- The CLI (tgCli.ts "titles") ---------------------------------------------------------------- */

/** `npm run tg -- titles <id>`: the same offer for any match, even one already on the channel
 *  (the retitle case) — ignoring the tick's dedupe, since `sendTitleOffer` has none of its own. */
export async function sendTitleOfferForce(matchId: number): Promise<void> {
  const match = await getMatch(matchId);
  await sendTitleOffer(matchId, match, { fresh: true });
}

/** `--dry-run`: the caption and the options, printed instead of sent — no photo, no Telegram
 *  call, no state written. */
export async function titleOfferPreview(matchId: number): Promise<string> {
  const match = await getMatch(matchId);
  const opt = await titleOptionsImpl(matchId, { fresh: true });
  const slot = await videoPublishTime(matchId, Date.now());
  const [left, right] = match.players;
  const caption = offerCaption(matchId, left!.nickname, right!.nickname, slot.at, opt);
  return [
    caption,
    "",
    ...opt.options.map((o, i) => `[${i}] ${o}`),
    opt.options.length === 0 ? "(no options — titleOptions() came back empty)" : "[r] New options",
  ].join("\n");
}

/**
 * Every open offer (not settled), refreshed in place — `npm run tg -- titles --refresh-open`
 * (titles/v2, 18 Oct 2026, the rewritten prompt and repeat check apply to a standing offer only
 * on its next press otherwise). `dryRun`: the same preview `titleOfferPreview` prints, per match,
 * nothing sent or written.
 */
export async function refreshOpenOffers(
  opts: { dryRun?: boolean } = {},
): Promise<Array<{ matchId: number; result: string }>> {
  const pending = Object.entries(readTelegramState().titleOffers)
    .filter(([, o]) => !o.settled)
    .map(([id]) => Number(id));
  if (pending.length === 0) return [];
  const chat = bot.chatId();
  if (!opts.dryRun && !bot.hasChat()) return [];
  const out: Array<{ matchId: number; result: string }> = [];
  for (const matchId of pending) {
    try {
      if (opts.dryRun) out.push({ matchId, result: await titleOfferPreview(matchId) });
      else {
        const offer = readTelegramState().titleOffers[String(matchId)]!;
        const { message } = await refreshOffer(matchId, chat!, offer.messageId);
        out.push({ matchId, result: message });
      }
    } catch (err) {
      out.push({ matchId, result: `failed: ${describeError(err)}` });
    }
  }
  return out;
}
