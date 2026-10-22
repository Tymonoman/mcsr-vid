/**
 * The record ask (22 Oct 2026, the growth plan's idea 3): a record-leaderboard run past
 * fast-track's 48h window, put to the operator — "Record pace: A vs B, m:ss. Queue it for
 * tonight?" — with Queue / Skip. Queue appends the id to tonight's queue the way the dashboard's
 * own queue button does (`setNightlyQueue`); Skip only closes the ask (an asked id is already
 * seen, never asked again).
 *
 * The only place "record" and the run time are written for a reader: the operator's own chat.
 * Nothing that writes a title, hook, description or model prompt imports this module
 * (recordAsk.contract.test.ts checks).
 *
 * Registered on `fastTrack.ts`'s `setRecordAskHook`, the way `fastTrackAsk.ts` registers on
 * `shortFlow.ts`: this module imports `fastTrack.ts`, never the reverse.
 */
import { matchPageUrl } from "../api/mcsrApi.js";
import {
  readRecordWatch,
  runClock,
  setRecordAskHook,
  updateRecordWatch,
  type RecordAsk,
} from "../dashboard/fastTrack.js";
import { nightlyQueue, setNightlyQueue } from "../dashboard/matchShelf.js";
import { describeError } from "../errorText.js";
import * as bot from "./bot.js";

/** `r:<matchId>:q`/`:s`. */
const CALLBACK_RE = /^r:(\d+):(q|s)$/;

export const recordAskText = (a: RecordAsk): string =>
  [
    `Record pace: ${bot.escapeHtml(`${a.players[0]} vs ${a.players[1]}`)}, ${runClock(a.timeMs)}. Queue it for tonight?`,
    bot.escapeHtml(matchPageUrl(a.matchId, a.players[0])),
  ].join("\n");

export async function sendRecordAsk(a: RecordAsk): Promise<boolean> {
  if (!bot.hasChat()) return false;
  await bot.sendMessage(recordAskText(a), {
    html: true,
    keyboard: {
      inline_keyboard: [
        [
          { text: "Queue", callback_data: `r:${a.matchId}:q` },
          { text: "Skip", callback_data: `r:${a.matchId}:s` },
        ],
      ],
    },
  });
  return true;
}

setRecordAskHook(sendRecordAsk);

/** Gated by `index.ts`'s `handleUpdate` like every other button: the operator's chat, pressed by
 *  the operator. */
export async function handleRecordCallback(cq: bot.TgCallbackQuery): Promise<void> {
  const m = CALLBACK_RE.exec(cq.data ?? "");
  const chat = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  const ask = m ? readRecordWatch().asks[m[1]!] : undefined;
  if (!m || chat === undefined || messageId === undefined || !ask || ask.answer) {
    await bot.answerCallbackQuery(cq.id, "that ask is gone").catch(() => undefined);
    return;
  }
  const matchId = Number(m[1]);
  const queue = m[2] === "q";
  try {
    if (queue) setNightlyQueue([...nightlyQueue(), matchId]);
    updateRecordWatch((s) => {
      s.seen[String(matchId)] ??= new Date().toISOString();
      s.asks[String(matchId)]!.answer = queue ? "queue" : "skip";
    });
    await bot.editMessageText(chat, messageId, `${ask.label}: ${queue ? "queued for tonight" : "skipped"}`);
    await bot.answerCallbackQuery(cq.id, queue ? "queued" : "skipped");
  } catch (err) {
    console.error(`recordAsk: #${matchId} press failed — ${describeError(err)}`);
    await bot.answerCallbackQuery(cq.id, "failed").catch(() => undefined);
  }
}
