// Comment nudges (src/telegram/commentNudge.ts): each threshold sends once, silently; a public
// video older than 48h, a private one, a blocked pair and a Data API failure send nothing; the
// text carries counts and the Studio link only; `commentNudges` is a file-only boolean, off.
// Run: npx tsx src/telegram/commentNudge.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, DEFAULTS } from "../config.js";
import type { VideoStats } from "../youtube/youtube.js";
import type { UploadRecord } from "../youtube/youtubeStore.js";
import type { SendOptions } from "./bot.js";
import { commentNudgeTick, nudgeText, sinceText, thresholdReached } from "./commentNudge.js";

const media = mkdtempSync(path.join(tmpdir(), "tg-nudge-"));
config.mediaDir = media;
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.TELEGRAM_CHAT_ID = "1";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const record = (videoId: string, title: string, publishAt: string | null): UploadRecord => ({
  videoId,
  uploadedAt: "2026-10-22T00:00:00Z",
  publishAt,
  privacyStatus: "private",
  thumbnailVariant: null,
  title,
});
const stat = (videoId: string, comments: number, extra: Partial<VideoStats> = {}): VideoStats => ({
  videoId,
  title: "",
  publishedAt: "2026-10-22T00:00:00Z",
  privacyStatus: "public",
  publishAt: "2026-10-22T10:00:00Z",
  views: 0,
  likes: 0,
  comments,
  duration: "PT10M",
  ...extra,
});

const sent: Array<{ text: string; opts: SendOptions }> = [];
let counts: Record<string, number> = {};
let fail = false;
const uploads = [
  {
    matchId: 1,
    record: record("aaa", "WHO BLINKS | Pinne vs lowk3y_ | MCSR Ranked", "2026-10-22T10:00:00Z"),
  },
  { matchId: 2, record: record("old", "HOOK | A vs B", "2026-10-19T10:00:00Z") },
  { matchId: 3, record: record("blk", "HOOK | Aquacorde vs B", "2026-10-22T10:00:00Z") },
  { matchId: 4, record: record("prv", "HOOK | C vs D", "2026-10-22T10:00:00Z") },
];
const deps = {
  uploads: async () => uploads,
  stats: async (ids: string[]) => {
    if (fail) throw new Error("quotaExceeded");
    return ids.map((id) =>
      stat(id, counts[id] ?? 0, {
        publishAt: uploads.find((u) => u.record.videoId === id)?.record.publishAt ?? null,
        ...(id === "prv" ? { privacyStatus: "private" } : {}),
      }),
    );
  },
  send: async (text: string, opts: SendOptions) => {
    sent.push({ text, opts });
  },
  now: () => NOW,
};

try {
  /* --- config contract: file-only boolean, off by default ---------------------------------- */
  assert.equal(DEFAULTS.commentNudges, false);
  const example = JSON.parse(readFileSync(path.join(process.cwd(), "mcsr-vid.config.example.json"), "utf8"));
  assert.equal(example.commentNudges, false, "npm run config:example carries the key");
  const settingsSrc = readFileSync(path.join(process.cwd(), "src/dashboard/settings.ts"), "utf8");
  assert.ok(!settingsSrc.includes('"commentNudges"'), "not writable from the Settings tab");

  /* --- off: nothing read, nothing sent ----------------------------------------------------- */
  config.commentNudges = false;
  counts = { aaa: 3, old: 9, blk: 9, prv: 9 };
  await commentNudgeTick(deps);
  assert.equal(sent.length, 0, "off by default sends nothing");

  /* --- helpers ----------------------------------------------------------------------------- */
  assert.equal(thresholdReached(0), null);
  assert.equal(thresholdReached(1), 1);
  assert.equal(thresholdReached(7), 5);
  assert.equal(thresholdReached(40), 25);
  assert.equal(sinceText(35 * 60_000), "35 min after publishing");
  assert.equal(sinceText(2 * 3_600_000 + 20 * 60_000), "2 h after publishing");
  const text = nudgeText("WHO BLINKS | Pinne vs lowk3y_ | MCSR Ranked", "aaa", 5, 2 * 3_600_000);
  assert.equal(
    text,
    'WHO BLINKS | Pinne vs lowk3y_: 5 comments, 2 h after publishing · <a href="https://studio.youtube.com/video/aaa/comments">Studio</a>',
  );
  assert.equal(
    nudgeText("x <y>", "v", 1, 0),
    'x &lt;y&gt;: 1 comment, 0 min after publishing · <a href="https://studio.youtube.com/video/v/comments">Studio</a>',
  );

  /* --- on: first comment, silent, once; old / blocked / private skipped -------------------- */
  config.commentNudges = true;
  counts = { aaa: 1, old: 9, blk: 9, prv: 9 };
  await commentNudgeTick(deps);
  assert.equal(sent.length, 1, "only the fresh public unblocked video nudges");
  assert.match(sent[0]!.text, /^WHO BLINKS \| Pinne vs lowk3y_: 1 comment, 2 h after publishing/);
  assert.deepEqual(sent[0]!.opts, { html: true, silent: true }, "delivered silently");
  await commentNudgeTick(deps);
  assert.equal(sent.length, 1, "the same threshold never repeats");

  /* --- a jump past two thresholds sends the highest, once ---------------------------------- */
  counts.aaa = 12;
  await commentNudgeTick(deps);
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.text, /: 12 comments, /);
  await commentNudgeTick(deps);
  assert.equal(sent.length, 2);
  const state = JSON.parse(readFileSync(path.join(media, ".telegram.json"), "utf8"));
  assert.deepEqual(state.commentNudges, { aaa: 10 }, "dedupe lives in .telegram.json");

  /* --- a Data API failure costs the tick nothing: no throw, no state change ---------------- */
  fail = true;
  counts.aaa = 30;
  await commentNudgeTick(deps);
  assert.equal(sent.length, 2);
  fail = false;
  await commentNudgeTick(deps);
  assert.equal(sent.length, 3, "the next tick catches up");
  assert.match(sent[2]!.text, /: 30 comments, /);
  for (const s of sent)
    assert.doesNotMatch(s.text, /youtube\.com\/watch|youtu\.be/, "Studio, never the watch page");

  console.log("commentNudge.test.ts: ok");
} finally {
  rmSync(media, { recursive: true, force: true });
}
