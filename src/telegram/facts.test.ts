// Self-check for facts.ts's deadline on the worth-rendering section: a gather that never settles
// (a slow MCSR API, a hung yt-dlp) must cost the report one failure line, not the report.
// Run: npx tsx src/telegram/facts.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { armRestart, disarmRestart } from "../dashboard/restartWhenIdle.js";
import { setHidden, setNightlyQueue } from "../dashboard/matchShelf.js";
import { writeUpload } from "../youtube/youtubeStore.js";
import {
  gatherFacts,
  gatherWorthSection,
  restartIdleHealth,
  studioWorkerHealth,
  WORTH_DEADLINE_MS,
  withDeadline,
} from "./facts.js";
import type { WorthFacts } from "./worth.js";

// A gather reads the state file and the scans' cache from the media directory: keep it a scratch one.
const media = mkdtempSync(path.join(tmpdir(), "mcsr-facts-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;

// gatherNeedsYou's comment check spends a real YouTube read: a token file of its own (the fetch
// stub for it is local to that test block below, same as the worth-rendering one already is).
process.env.YOUTUBE_TOKEN_FILE = path.join(media, "token.json");
writeFileSync(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);

const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
const baseline = timers();
let unhandled = 0;
process.on("unhandledRejection", () => unhandled++);

try {
  assert.equal(WORTH_DEADLINE_MS, 120_000);

  // A gather that never settles degrades to the section's one failure line once the deadline passes.
  const started = Date.now();
  const hung = await gatherWorthSection(0, false, 40, () => new Promise<WorthFacts>(() => {}));
  assert.deepEqual(hung, { ok: false, error: "worth rendering timed out" });
  assert.ok(Date.now() - started >= 35, "it waited for the deadline, not less");
  assert.equal(timers(), baseline);

  // A gather inside the deadline passes through with its arguments, and leaves no timer behind: the
  // real deadline is two minutes, and a CLI run must not wait them out after it has printed.
  const facts: WorthFacts = { matches: [], notes: ["a note"] };
  const seen: unknown[] = [];
  const ok = await gatherWorthSection(7, true, undefined, async (now, opts) => (seen.push(now, opts), facts));
  assert.deepEqual(ok, { ok: true, data: facts });
  assert.deepEqual(seen, [7, { fresh: true }]);
  assert.equal(timers(), baseline);

  // A gather that fails says why, not "timed out".
  const failed = await gatherWorthSection(0, false, undefined, async () => {
    throw new Error("boom");
  });
  assert.deepEqual(failed, { ok: false, error: "boom" });
  assert.equal(timers(), baseline);

  // One that overruns and then fails is the race's to handle: an unhandled rejection would take the
  // dashboard process down with it.
  const late = await withDeadline(
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), 60)),
    10,
    "overran",
  ).catch((err: Error) => err.message);
  assert.equal(late, "overran");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(unhandled, 0);

  // And through gatherFacts itself, the way the morning report and /worth reach it: the MCSR API
  // never answers, the report still comes back, with that one section failed.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
  try {
    const gathered = await gatherFacts(Date.parse("2026-09-30T20:00:00Z"), undefined, ["worthRendering"], {
      freshWorth: true,
      worthDeadlineMs: 40,
    });
    assert.deepEqual(gathered.worthRendering, { ok: false, error: "worth rendering timed out" });
    assert.deepEqual(gathered.todo, { ok: false, error: "not requested" }); // nothing else was gathered
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(timers(), baseline);

  // A failed restart-when-idle boot check (src/dashboard/restartWhenIdle.ts) is this process'
  // own state, not a ping — it must surface in `gatherHealth`'s list the same way a down API
  // does, since that is the only way it ever reaches the Telegram report (review fix, 8 Oct 2026).
  assert.equal(restartIdleHealth(), null, "nothing armed — no health line");
  armRestart({
    idleDeps: () => ({
      jobRunning: () => false,
      exportRunning: () => false,
      shortRunning: () => false,
      pickRunning: () => false,
      chainRunning: () => false,
      uploadRunning: () => false,
      uploadSessionFile: () => false,
      archiveRunning: () => false,
      nightlyChainRunning: () => false,
      nightlyHourUtc: null,
    }),
    bootCheck: async () => "src/foo.ts(1,1): error TS1: bogus\nmore detail",
    checkIntervalMs: 10,
    expireMs: 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const restartHealth = restartIdleHealth();
  assert.deepEqual(restartHealth, {
    name: "restart-when-idle",
    ok: false,
    detail: "src/foo.ts(1,1): error TS1: bogus",
  });
  disarmRestart();
  assert.equal(restartIdleHealth(), null, "disarming clears the health line too");

  // The Studio worker's heartbeat folded into one gatherHealth line: no file (never started) is
  // no line; fresh is ok; stale (over 90 min) is down — same file "Needs you" above reads.
  const workerHeartbeat = path.join(media, ".studio-worker.json");
  assert.equal(studioWorkerHealth(), null, "no heartbeat file: no health line");
  writeFileSync(
    workerHeartbeat,
    JSON.stringify({ at: new Date(Date.now() - 5 * 60_000).toISOString(), lastError: null }),
  );
  let workerHealth = studioWorkerHealth();
  assert.equal(workerHealth?.name, "studio worker");
  assert.equal(workerHealth?.ok, true, "a 5 min old heartbeat is ok");
  writeFileSync(
    workerHeartbeat,
    JSON.stringify({ at: new Date(Date.now() - 91 * 60_000).toISOString(), lastError: null }),
  );
  workerHealth = studioWorkerHealth();
  assert.equal(workerHealth?.ok, false, "a 91 min old heartbeat is down");
  assert.match(workerHealth!.detail ?? "", /down/);
  rmSync(workerHeartbeat);
  console.log("OK: studioWorkerHealth is absent, ok or down off the same heartbeat file");

  /* --- Needs you: every kind, the empty case, and the 4096-char budget ------------------------- */
  {
    const dir = (id: number) => path.join(media, String(id));
    const NOW = Date.parse("2026-10-08T07:00:00Z");
    const SINCE = NOW - 24 * 60 * 60 * 1000;
    const needsYouOf = async () => {
      const facts = await gatherFacts(NOW, SINCE, ["needsYou"]);
      assert.ok(facts.needsYou.ok, JSON.stringify(facts.needsYou));
      return facts.needsYou.ok ? facts.needsYou.data.items : [];
    };

    // Every disk-only check here still calls matchStatusFor, which spends one MCSR API read per
    // match — stubbed to fail at once (matchStatusFor's own fallback to the POV filenames on disk
    // is what this test actually exercises) so none of it reaches for the real network; the
    // comment check's own reads (oauth2, commentThreads, videos) are answered from `commentThreads`
    // and `videoTitles` below, mutated per scenario.
    const realFetch = globalThis.fetch;
    let commentThreads: unknown[] = [];
    const videoTitles = new Map<string, string>();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.mcsrranked.com/")) throw new Error("no network in this test");
      if (url.startsWith("https://oauth2.googleapis.com/"))
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      if (url.includes("/commentThreads?")) return new Response(JSON.stringify({ items: commentThreads }));
      if (url.includes("/videos?")) {
        const ids = new URL(url).searchParams.get("id")!.split(",");
        return new Response(
          JSON.stringify({ items: ids.map((id) => ({ id, snippet: { title: videoTitles.get(id) ?? id } })) }),
        );
      }
      throw new Error(`gatherNeedsYou reached for the real network: ${url}`);
    }) as typeof fetch;

    try {
      // Empty: one upload already covers the next 48 h, and nothing else on disk needs a look.
      const CLEAN = 1;
      mkdirSync(dir(CLEAN), { recursive: true });
      await writeUpload(
        CLEAN,
        {
          videoId: "v1",
          uploadedAt: new Date(NOW - 3600_000).toISOString(),
          publishAt: new Date(NOW + 10 * 3600_000).toISOString(),
          privacyStatus: "private",
          thumbnailVariant: null,
          title: "t",
        },
        "video",
      );
      assert.deepEqual(await needsYouOf(), [], "nothing needs the operator on a quiet day");

      // 1. A failed chain step: the match, the step and the error's first line only.
      const FAILED = 2;
      mkdirSync(dir(FAILED), { recursive: true });
      writeFileSync(
        path.join(dir(FAILED), `short-${FAILED}.status.json`),
        JSON.stringify({
          steps: { "upload-video": { state: "failed", at: new Date(NOW).toISOString() } },
          errors: [
            {
              step: "upload-video",
              at: new Date(NOW).toISOString(),
              message: "the sign-in is gone\nrun npm run youtube-auth",
            },
          ],
        }),
      );
      let items = await needsYouOf();
      const failedItem = items.find((i) => i.matchId === FAILED);
      assert.ok(failedItem, "the failed step is an item");
      assert.equal(failedItem!.text, "upload-video failed: the sign-in is gone", "first line only");
      console.log("OK: a failed chain step is one line, first line of its error only");

      // 2. Studio: absent is no item; each non-"ok" result is, in its own words; "ok" is none.
      const probe = path.join(media, ".studio-probe.json");
      assert.ok(!items.some((i) => /studio/i.test(i.text)), "no probe file yet: no item");
      writeFileSync(
        probe,
        JSON.stringify({ result: "signed-out", message: "Studio is signed out — sign in again", at: "x" }),
      );
      items = await needsYouOf();
      assert.ok(items.some((i) => i.text === "Studio is signed out — sign in again"));
      writeFileSync(probe, JSON.stringify({ result: "ok", message: "fine", at: "x" }));
      items = await needsYouOf();
      assert.ok(!items.some((i) => /studio/i.test(i.text)), '"ok" is no item');
      writeFileSync(probe, "not json");
      items = await needsYouOf(); // garbage: no item, no throw (one console.error, not asserted here)
      assert.ok(!items.some((i) => /studio/i.test(i.text)));
      rmSync(probe);
      console.log("OK: Studio is an item for anything but ok, absent or garbage is none");

      // 2b. The Studio worker's own heartbeat: no file (never started) is no item; a stale `at`
      //     and a standing repeated error are independent items; garbage is read defensively.
      const heartbeat = path.join(media, ".studio-worker.json");
      assert.ok(!items.some((i) => /studio worker/i.test(i.text)), "no heartbeat file yet: no item");
      writeFileSync(
        heartbeat,
        JSON.stringify({ at: new Date(NOW - 10 * 60_000).toISOString(), lastError: null }),
      );
      items = await needsYouOf();
      assert.ok(
        !items.some((i) => /studio worker/i.test(i.text)),
        "a fresh heartbeat (10 min old) is no item",
      );
      writeFileSync(
        heartbeat,
        JSON.stringify({ at: new Date(NOW - 91 * 60_000).toISOString(), lastError: null }),
      );
      items = await needsYouOf();
      const stale = items.find((i) => /has stopped/.test(i.text));
      assert.ok(stale, "a heartbeat over 90 min old is an item");
      assert.match(stale!.text, /npm run -s studio -- worker --enable/, "names the restart command");
      writeFileSync(
        heartbeat,
        JSON.stringify({
          at: new Date(NOW - 5 * 60_000).toISOString(),
          lastError: "picker-empty: no rows\nmore detail",
          sameErrorStreak: 2,
        }),
      );
      items = await needsYouOf();
      assert.ok(
        !items.some((i) => /3 cycles running/.test(i.text)),
        "a streak of 2 is not yet worth an item",
      );
      writeFileSync(
        heartbeat,
        JSON.stringify({
          at: new Date(NOW - 5 * 60_000).toISOString(),
          lastError: "picker-empty: no rows\nmore detail",
          sameErrorStreak: 3,
        }),
      );
      items = await needsYouOf();
      const repeated = items.find((i) => /3 cycles running/.test(i.text));
      assert.ok(repeated, "the same error 3 cycles running is its own item");
      assert.equal(
        repeated!.text,
        "the Studio worker has hit the same error 3 cycles running: picker-empty: no rows",
        "first line of the error only",
      );
      writeFileSync(heartbeat, "not json");
      items = await needsYouOf(); // garbage: no item, no throw
      assert.ok(!items.some((i) => /studio worker/i.test(i.text)));
      rmSync(heartbeat);
      console.log(
        "OK: the Studio worker's heartbeat is a stale-item, a repeated-error item, or none, garbage included",
      );

      // 3. No upload in the next 48 h: both days named, by their bare UTC date.
      await writeUpload(
        CLEAN,
        {
          videoId: "v1",
          uploadedAt: new Date(NOW - 3600_000).toISOString(),
          publishAt: new Date(NOW + 72 * 3600_000).toISOString(), // past 48 h now
          privacyStatus: "private",
          thumbnailVariant: null,
          title: "t",
        },
        "video",
      );
      items = await needsYouOf();
      const noUpload = items.find((i) => /no long-form/i.test(i.text));
      assert.ok(noUpload, "nothing lands inside 48 h any more");
      assert.match(noUpload!.text, /8 Oct.*9 Oct|9 Oct.*8 Oct/);
      // Scheduled back inside the window: the item goes away.
      await writeUpload(
        CLEAN,
        {
          videoId: "v1",
          uploadedAt: new Date(NOW - 3600_000).toISOString(),
          publishAt: new Date(NOW + 10 * 3600_000).toISOString(),
          privacyStatus: "private",
          thumbnailVariant: null,
          title: "t",
        },
        "video",
      );
      items = await needsYouOf();
      assert.ok(!items.some((i) => /no long-form/i.test(i.text)), "back inside 48 h: the item clears");
      console.log("OK: no upload in 48 h names both bare UTC days, and clears once one is scheduled");

      // 4. A blocked runner: the queue, a rendered-and-not-hidden match, an upload record, and a
      //    comment's author — each names the match or the video, never the comment's own text.
      const QUEUED = 3;
      mkdirSync(dir(QUEUED), { recursive: true });
      writeFileSync(path.join(dir(QUEUED), "Aquacorde.mp4"), "x");
      writeFileSync(path.join(dir(QUEUED), "someoneElse.mp4"), "x");
      setNightlyQueue([QUEUED]);
      items = await needsYouOf();
      assert.ok(
        items.some((i) => i.matchId === QUEUED && /blocked player/.test(i.text)),
        "a blocked player queued for tonight",
      );
      setNightlyQueue([]);

      const RENDERED = 4;
      mkdirSync(dir(RENDERED), { recursive: true });
      writeFileSync(path.join(dir(RENDERED), "Aquacorde.mp4"), "x");
      writeFileSync(path.join(dir(RENDERED), "someoneElse.mp4"), "x");
      writeFileSync(path.join(dir(RENDERED), `final-${RENDERED}.mp4`), "x");
      items = await needsYouOf();
      assert.ok(
        items.some((i) => i.matchId === RENDERED),
        "rendered and not hidden",
      );
      setHidden(RENDERED, true);
      items = await needsYouOf();
      assert.ok(!items.some((i) => i.matchId === RENDERED), "hidden: no longer an item");
      setHidden(RENDERED, false);

      const UPLOADED_REC = 5;
      mkdirSync(dir(UPLOADED_REC), { recursive: true });
      writeFileSync(path.join(dir(UPLOADED_REC), "Aquacorde.mp4"), "x");
      writeFileSync(path.join(dir(UPLOADED_REC), "someoneElse.mp4"), "x");
      await writeUpload(
        UPLOADED_REC,
        {
          videoId: "v2",
          uploadedAt: new Date(NOW).toISOString(),
          publishAt: null,
          privacyStatus: "private",
          thumbnailVariant: null,
          title: "t",
        },
        "video",
      );
      items = await needsYouOf();
      assert.ok(
        items.some((i) => i.matchId === UPLOADED_REC),
        "has an upload record",
      );

      videoTitles.set("v3", "A clean match");
      commentThreads = [
        {
          id: "c1",
          snippet: {
            videoId: "v3",
            totalReplyCount: 0,
            topLevelComment: {
              snippet: {
                authorDisplayName: "Aquacorde",
                textOriginal: "do not use my footage",
                publishedAt: new Date(NOW - 3600_000).toISOString(),
              },
            },
          },
        },
      ];
      items = await needsYouOf();
      const commentItem = items.find((i) => /commented on/.test(i.text));
      assert.ok(commentItem, "a blocked runner's comment is an item");
      assert.equal(commentItem!.text, "a blocked runner commented on A clean match");
      assert.ok(!commentItem!.matchId, "no deep link for a comment-only sighting");
      assert.ok(
        !JSON.stringify(items).includes("do not use my footage"),
        "the comment's own text never appears",
      );
      commentThreads = [];
      console.log(
        "OK: a blocked runner is named in the queue, on disk, in an upload record and in a comment",
      );

      // 5. A test result needing a human call: `needsHuman` only when not acknowledged; garbage is
      //    read defensively, never thrown.
      const experiments = path.join(media, ".experiments.json");
      writeFileSync(
        experiments,
        JSON.stringify({
          experiments: [
            { needsHuman: "arm A or B for publishHourUtc?", needsHumanAck: false },
            { needsHuman: "already answered", needsHumanAck: true },
          ],
        }),
      );
      items = await needsYouOf();
      assert.ok(items.some((i) => i.text === "arm A or B for publishHourUtc?"));
      assert.ok(!items.some((i) => i.text === "already answered"), "acknowledged: no longer an item");
      writeFileSync(experiments, "not json");
      items = await needsYouOf(); // garbage: no item, no throw
      assert.ok(!items.some((i) => /arm A or B/.test(i.text)));
      rmSync(experiments);
      console.log("OK: an experiment needing a human call is an item until it is acknowledged");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log("facts: all checks passed");
} finally {
  rmSync(media, { recursive: true, force: true });
}
