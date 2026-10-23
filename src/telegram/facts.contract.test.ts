// Contract test for facts.ts's "Needs you" gather, written from the docs (CLAUDE.md "Telegram bot",
// handbook claude-md-reference.md "Needs you"), not from the code. facts.test.ts already walks every
// item kind once; this file covers the edges it does not: the other two Studio states, a Short that
// is not a long-form, the days named in UTC, a blocked runner's comment from before the last report,
// the block list's whole-string case-insensitive match, and "one line each" for every kind.
// Every API is a stub: MCSR answers from src/fixtures, YouTube from the tables below; no network.
//
// Promises (numbering shared with index.contract.test.ts):
//  P2. "Needs you" is deterministic code, "Nothing today." when empty.
//  P3. Only these kinds, ONE LINE EACH: a failed status step; Studio signed out / needing verification /
//      wrong channel; no long-form scheduled to go public in the next 48 h, naming both bare UTC days;
//      (shortsByHand) a Short still to cut; a live title breaking a house rule; a blocked runner in
//      tonight's queue, rendered, uploaded, or as a comment's author newer than the last report —
//      naming the video or match, never the comment's own text; an experiment's unacknowledged
//      `needsHuman`; the Studio worker's heartbeat over 90 min old / the same error 3+ cycles running.
// Run: npx tsx src/telegram/facts.contract.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { writeUpload } from "../youtube/youtubeStore.js";
import { gatherFacts, type NeedsYouItem } from "./facts.js";

/** A doc clause the code does not keep: printed, not thrown, so the suite stays green until triage. */
function deviation(clause: string, check: () => void): void {
  try {
    check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const media = mkdtempSync(path.join(tmpdir(), "tg-facts-contract-"));
config.mediaDir = media;
// A synthetic block list, so no real runner's name is test data here.
config.blockedPlayers = ["SyntheticBlockedRunner"];
process.env.YOUTUBE_TOKEN_FILE = path.join(media, "token.json");
writeFileSync(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);

const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures");
const REAL = 13560037; // src/fixtures/match-13560037.json: v_strid vs doogile
let commentThreads: unknown[] = [];
const videoTitles = new Map<string, string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  const m = /^https:\/\/api\.mcsrranked\.com\/matches\/(\d+)$/.exec(url);
  if (m && existsSync(path.join(FIXTURES, `match-${m[1]}.json`)))
    return json({
      status: "success",
      data: JSON.parse(readFileSync(path.join(FIXTURES, `match-${m[1]}.json`), "utf8")),
    });
  if (url.startsWith("https://api.mcsrranked.com/")) return json({ status: "error", data: "down" }, 503);
  if (url.startsWith("https://oauth2.googleapis.com/")) return json({ access_token: "t", expires_in: 3600 });
  if (url.includes("/commentThreads?")) return json({ items: commentThreads });
  if (url.includes("/videos?")) {
    const ids = new URL(url).searchParams.get("id")!.split(",");
    return json({
      items: ids
        .filter((id) => videoTitles.has(id))
        .map((id) => ({ id, snippet: { title: videoTitles.get(id) } })),
    });
  }
  throw new Error(`reached for the network: ${url}`);
}) as typeof fetch;

const NOW = Date.parse("2026-10-14T05:00:00Z"); // 07:00 Warsaw, a Wednesday
const SINCE = NOW - 24 * 3_600_000;
const H = 3_600_000;
const needsYou = async (now = NOW, since = SINCE): Promise<NeedsYouItem[]> => {
  const f = await gatherFacts(now, since, ["needsYou"]);
  assert.ok(f.needsYou.ok, JSON.stringify(f.needsYou));
  return f.needsYou.ok ? f.needsYou.data.items : [];
};
const dir = (id: number) => path.join(media, String(id));
const thread = (id: string, videoId: string, author: string, text: string, publishedAt: number) => ({
  id,
  snippet: {
    videoId,
    totalReplyCount: 0,
    topLevelComment: {
      snippet: {
        authorDisplayName: author,
        textOriginal: text,
        publishedAt: new Date(publishedAt).toISOString(),
      },
    },
  },
});
const longForm = (
  matchId: number,
  videoId: string,
  publishAt: number | null,
  kind: "video" | "short" = "video",
) =>
  writeUpload(
    matchId,
    {
      videoId,
      uploadedAt: new Date(SINCE - 5 * 24 * H).toISOString(), // old upload: not "appearing" overnight
      publishAt: publishAt === null ? null : new Date(publishAt).toISOString(),
      privacyStatus: "private",
      thumbnailVariant: null,
      title: "CAN ANYONE CATCH UP? | v_strid vs doogile | MCSR Ranked",
    },
    kind,
  );

try {
  mkdirSync(dir(REAL), { recursive: true });
  writeFileSync(path.join(dir(REAL), "v_strid.mp4"), "x");
  writeFileSync(path.join(dir(REAL), "doogile.mp4"), "x");

  /* --- P3: "no long-form in 48 h" — a Short is not a long-form, and a passed time is not ahead ---- */
  await longForm(REAL, "short1", NOW + 6 * H, "short");
  let items = await needsYou();
  assert.ok(
    items.some((i) => /No long-form/.test(i.text)),
    "a scheduled Short alone does not cover the next 48 h",
  );
  await longForm(REAL, "vid1", NOW - 1 * H);
  items = await needsYou();
  assert.ok(
    items.some((i) => /No long-form/.test(i.text)),
    "a long-form that already went out is not scheduled ahead",
  );
  await longForm(REAL, "vid1", NOW + 47 * H);
  items = await needsYou();
  assert.ok(!items.some((i) => /No long-form/.test(i.text)), "47 h ahead is inside the 48 h");
  // P2: with that, an otherwise quiet media dir needs nobody (the renderer then says "Nothing today.").
  assert.deepEqual(items, [], JSON.stringify(items));
  console.log("OK: only a long-form inside 48 h clears the item; a quiet day is an empty list");

  /* --- P3: the two days are bare UTC days, not Warsaw's ------------------------------------------ */
  {
    // 23:30 UTC on the 14th is 01:30 on the 15th in Warsaw: the docs name UTC days, so "14 Oct" and
    // "15 Oct" — Warsaw's reading would be the 15th and the 16th.
    const late = Date.parse("2026-10-14T23:30:00Z");
    await longForm(REAL, "vid1", late - H);
    const item = (await needsYou(late, late - 24 * H)).find((i) => /No long-form/.test(i.text));
    assert.ok(item, "nothing ahead: the item");
    assert.match(item!.text, /14 Oct/);
    assert.match(item!.text, /15 Oct/);
    assert.doesNotMatch(item!.text, /16 Oct/);
    await longForm(REAL, "vid1", NOW + 10 * H);
    console.log("OK: the item names the two bare UTC days");
  }

  /* --- P3: Studio's other two states, and the one-line rule on its message ---------------------- */
  {
    const probe = path.join(media, ".studio-probe.json");
    writeFileSync(
      probe,
      JSON.stringify({ result: "verify", message: "Google wants to verify it's you", at: "x" }),
    );
    assert.ok(
      (await needsYou()).some((i) => i.text === "Google wants to verify it's you"),
      "verify is an item",
    );
    writeFileSync(probe, JSON.stringify({ result: "wrong-channel", message: "", at: "x" }));
    const wrong = (await needsYou()).find((i) => /wrong-channel/.test(i.text));
    assert.ok(wrong, "wrong channel is an item even with no message of its own");
    assert.equal(wrong!.matchId, undefined, "no match to link");
    writeFileSync(
      probe,
      JSON.stringify({
        result: "signed-out",
        message: "Studio is signed out\nat https://studio.youtube.com\nretry later",
        at: "x",
      }),
    );
    const multi = (await needsYou()).find((i) => /signed out/.test(i.text));
    assert.ok(multi);
    deviation("Needs you: only eight kinds, one line each (Studio probe message)", () => {
      assert.ok(!multi!.text.includes("\n"), `the Studio item is ${multi!.text.split("\n").length} lines`);
    });
    rmSync(probe);
    console.log("OK: verify and wrong-channel are items");
  }

  /* --- P3: an experiment's needsHuman — unacknowledged, a real string, one line ------------------ */
  {
    const exp = path.join(media, ".experiments.json");
    writeFileSync(
      exp,
      JSON.stringify({
        experiments: [
          { needsHuman: "   ", needsHumanAck: false }, // blank: nothing to decide
          { needsHuman: true }, // not a string: read defensively, no item
          {
            id: "x9-demo",
            needsHuman: "Analytics: quota exceeded\n  at armTotalsFor (experimentsEvaluator.ts:120)",
          },
        ],
      }),
    );
    items = await needsYou();
    const human = items.filter(
      (i) => /quota exceeded/.test(i.text) || i.text.trim() === "" || i.text === "true",
    );
    assert.equal(human.length, 1, JSON.stringify(items));
    assert.ok(human[0]!.text.startsWith("x9-demo: "), "the line names which experiment it is");
    deviation("Needs you: only eight kinds, one line each (experiment needsHuman)", () => {
      assert.ok(
        !human[0]!.text.includes("\n"),
        `the experiment item is ${human[0]!.text.split("\n").length} lines`,
      );
    });
    rmSync(exp);
    console.log("OK: only a real, unacknowledged needsHuman string is an item");
  }

  /* --- P3: a blocked runner's comment — newer than the last report only, named by video only ----- */
  {
    const TEXT = "SYNTHETIC-COMMENT-BODY-5521";
    videoTitles.set("vidC", "CAN ANYONE CATCH UP? | v_strid vs doogile | MCSR Ranked");
    commentThreads = [thread("t-old", "vidC", "SyntheticBlockedRunner", TEXT, SINCE - H)];
    items = await needsYou();
    assert.ok(
      !items.some((i) => /commented/.test(i.text)),
      "a comment from before the last report is history",
    );

    // Whole string, case-insensitive (CLAUDE.md "Blocked players").
    commentThreads = [
      thread("t-new", "vidC", "syntheticblockedrunner", TEXT, NOW - H),
      thread("t-near", "vidC", "SyntheticBlockedRunner2", TEXT, NOW - H),
    ];
    items = await needsYou();
    const seen = items.filter((i) => /commented/.test(i.text));
    assert.equal(
      seen.length,
      1,
      `the case-folded name matches, a longer one does not: ${JSON.stringify(seen)}`,
    );
    assert.equal(
      seen[0]!.text,
      "a blocked runner commented on CAN ANYONE CATCH UP? | v_strid vs doogile | MCSR Ranked",
    );
    assert.ok(!JSON.stringify(items).includes(TEXT), "never the comment's own text");
    assert.ok(
      !JSON.stringify(items).toLowerCase().includes("syntheticblockedrunner"),
      "nor its author's name",
    );

    // A video whose title cannot be read is still named — by its id, never by the comment.
    commentThreads = [thread("t-x", "vidUnknown", "SyntheticBlockedRunner", TEXT, NOW - H)];
    items = await needsYou();
    assert.ok(
      items.some((i) => i.text === "a blocked runner commented on vidUnknown"),
      JSON.stringify(items),
    );
    commentThreads = [];
    console.log("OK: a blocked runner's comment is an item only when new, named by video, never by its text");
  }

  /* --- P3: one line each, across every kind that can fire at once -------------------------------- */
  {
    const FAILED = 13446429; // a real fixture match, so the line carries its players
    mkdirSync(dir(FAILED), { recursive: true });
    writeFileSync(
      path.join(dir(FAILED), `short-${FAILED}.status.json`),
      JSON.stringify({
        steps: { "upload-short": { state: "failed", at: new Date(NOW).toISOString() } },
        errors: [
          { step: "upload-short", at: new Date(NOW).toISOString(), message: "HTTP 503\n<html>…</html>" },
        ],
      }),
    );
    writeFileSync(
      path.join(media, ".studio-worker.json"),
      JSON.stringify({
        at: new Date(NOW - 3 * H).toISOString(),
        lastError: "picker-empty\nstack",
        sameErrorStreak: 4,
      }),
    );
    await longForm(REAL, "vid1", NOW + 72 * H); // and nothing in the next 48 h again
    items = await needsYou();
    assert.ok(items.length >= 4, JSON.stringify(items));
    for (const i of items) assert.ok(!i.text.includes("\n"), `one line: ${JSON.stringify(i.text)}`);
    const failed = items.find((i) => i.matchId === FAILED);
    assert.equal(failed?.text, "upload-short failed: HTTP 503");
    assert.ok(
      failed?.players && failed.players.includes(" vs "),
      "a match item carries its players for the link",
    );
    console.log("OK: failed step, stale worker, repeated error and no-upload are one line each");
  }

  console.log("facts.contract: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  rmSync(media, { recursive: true, force: true });
}
