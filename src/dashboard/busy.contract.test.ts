// Contract test for "A re-render or a pending put counts as busy for restart-when-idle and the
// nightly, same as a render or an export" (CLAUDE.md, "Re-render a match's thumbnails beside the
// live set"; promise 11 in src/thumbnails/thumbnailVariants.contract.test.ts), written from the
// docs by an outsider. Drives the real signals — a held re-render job, a "Use this" mid-move, a
// real Put on YouTube held on the wire — and reads them back through the real consumers: busyIn
// (Delete, the re-render, Use this and the swap refuse on it), restart-when-idle's idle() on its
// live wiring, and the nightly's own guard. restartWhenIdle.test.ts fakes every signal and
// nightly.test.ts covers only the re-render; neither wires a put.
// Temp media dir, stubbed fetch, nothing reaches Google or the MCSR API.
// Run: npx tsx src/dashboard/busy.contract.test.ts
import assert from "node:assert/strict";
import { deviation } from "../fixtures/deviation.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { busyIn } from "./busy.js";
import { runNightlyOnce } from "./nightly.js";
import { idle } from "./restartWhenIdle.js";
import { NEW_DIR, promoteNewSet, startRerender, type rerenderThumbnails } from "../thumbnails/rerender.js";
import { swapThumbnail } from "../youtube/thumbnailSwap.js";
import { writeUpload } from "../youtube/youtubeStore.js";

const media = await mkdtemp(path.join(tmpdir(), "mcsr-busy-contract-"));
const saved = {
  mediaDir: config.mediaDir,
  channel: config.youtubeChannelId,
  hour: config.nightlyRenderHourUtc,
  token: process.env.YOUTUBE_TOKEN_FILE,
};
config.mediaDir = media;
config.youtubeChannelId = "UCmine";
// idle() also waits out the 20 minutes before the nightly hour; off, so the clock never decides.
config.nightlyRenderHourUtc = null;
process.env.YOUTUBE_TOKEN_FILE = path.join(media, "token.json");
await writeFile(
  process.env.YOUTUBE_TOKEN_FILE,
  JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }),
);

// thumbnails.set is held until `releaseSet()`: a put genuinely on the wire.
let setReached!: () => void;
const reachedSet = new Promise<void>((r) => (setReached = r));
let releaseSet!: () => void;
const setHeld = new Promise<void>((r) => (releaseSet = r));
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const json = (p: unknown) =>
    new Response(JSON.stringify(p), { headers: { "content-type": "application/json" } });
  if (url.startsWith("https://oauth2.googleapis.com/")) return json({ access_token: "t", expires_in: 3600 });
  if (url.includes("/videos?part=snippet&")) {
    const id = new URL(url).searchParams.get("id")!;
    const thumbnails = { maxres: { url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, width: 1280 } };
    return json({ items: [{ id, snippet: { channelId: "UCmine", title: "Live", thumbnails } }] });
  }
  if (url.startsWith("https://i.ytimg.com/")) return new Response("Y".repeat(9000));
  if (url.includes("/thumbnails/set?")) {
    setReached();
    await setHeld;
    return json({ kind: "youtube#thumbnailSetResponse" });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

// The nightly's pick, counted: reaching it means the nightly went ahead and would start a render.
let picks = 0;
const nightlyDeps = {
  ranked: async () => {
    picks++;
    return null;
  },
  // Midday UTC: outside the NAS window, so the run's archive sweep is a no-op.
  now: () => Date.parse("2026-10-14T12:00:00Z"),
};
const nightlyWentAhead = async (opts: { scheduled?: boolean } = {}): Promise<boolean> => {
  const before = picks;
  await runNightlyOnce("", { ...nightlyDeps, ...opts, thumbnailWaitMs: 50 });
  return picks > before;
};

/** A new set ready to be pressed in: one tile, its still, the manifest last. */
async function newSet(id: number): Promise<string> {
  const dir = path.join(media, String(id));
  await mkdir(path.join(dir, NEW_DIR), { recursive: true });
  await writeFile(path.join(dir, NEW_DIR, "thumbnail.walking-crossed.png"), "NEW");
  await writeFile(
    path.join(dir, NEW_DIR, "thumbnail.json"),
    JSON.stringify({
      chosen: "walking-crossed",
      chosenBy: "auto",
      hookText: null,
      variants: [{ key: "walking-crossed", file: "thumbnail.walking-crossed.png" }],
    }),
  );
  return dir;
}

try {
  for (const id of [600, 601, 602, 603]) await mkdir(path.join(media, String(id)));

  // --- Baseline: nothing in flight is idle, and the nightly goes ahead ------------------------
  // Without this the "not idle" readings below could be the harness, not the signal.
  assert.equal(busyIn(600), null);
  assert.equal(idle(), true, "nothing running: restart-when-idle may restart");
  assert.equal(await nightlyWentAhead(), true, "nothing running: Run now reaches the pick");
  console.log("OK: baseline — idle, and the nightly reaches its pick");

  // --- A re-render in flight ---------------------------------------------------------------------
  {
    let finish!: () => void;
    const job = startRerender(
      600,
      (() =>
        new Promise(
          (r) => (finish = () => r({ chosen: "x", variants: [], hookText: null })),
        )) as typeof rerenderThumbnails,
    );
    // Delete, Use this, the swap and the bulk all read busyIn: it must name the re-render.
    assert.equal(busyIn(600), "a thumbnail re-render or Use this");
    assert.equal(busyIn(601), null, "only that match's folder is busy");
    assert.equal(idle(), false, "a re-render holds restart-when-idle");
    assert.equal(await nightlyWentAhead(), false, "Run now does not start a render beside it");
    finish();
    await job.finished;
    assert.equal(busyIn(600), null, "done: not busy");
    assert.equal(idle(), true);
  }
  console.log("OK: a re-render in flight is busy for busyIn, restart-when-idle and the nightly");

  // --- "Use this" moving the new set over the live one -----------------------------------------
  {
    await newSet(601);
    const moving = promoteNewSet(601, "walking-crossed");
    // Read before the move's first await settles: the folder is being rewritten right now.
    assert.equal(busyIn(601), "a thumbnail re-render or Use this");
    assert.equal(idle(), false, "a Use this mid-move holds restart-when-idle");
    await moving;
    assert.equal(busyIn(601), null);
    assert.equal(idle(), true);
  }
  console.log("OK: a Use this mid-move is busy for busyIn and restart-when-idle");

  // --- A Put on YouTube on the wire (the "pending put") ----------------------------------------
  {
    await newSet(602);
    await writeUpload(602, {
      videoId: "putVid00001",
      uploadedAt: "2026-09-20T19:00:00Z",
      publishAt: null,
      privacyStatus: "public",
      thumbnailVariant: null,
      title: "t",
    });
    const put = swapThumbnail(602, { variant: "walking-crossed" });
    await reachedSet;
    // The swap and a Finish both write the video: the other presses must see it.
    assert.equal(busyIn(602), "a Finish or Put on YouTube");
    assert.equal(busyIn(603), null, "only that match");
    assert.equal(idle(), false, "a pending put holds restart-when-idle (a restart would cut it)");
    // The docs, read literally: a pending put counts as busy for the nightly too. Doc ambiguous —
    // a put is a network write on another match and the nightly waits on no upload either, so the
    // sentence likely means restart-when-idle only. Reported for triage, not as a nightly bug.
    const runNow = await nightlyWentAhead();
    const scheduled = await nightlyWentAhead({ scheduled: true });
    await deviation(
      'CLAUDE.md "Re-render a match\'s thumbnails…": a pending put counts as busy for the nightly (doc ambiguous, likely means restart-when-idle only)',
      () => {
        assert.equal(runNow, false, "Run now went ahead to its pick while a Put on YouTube was on the wire");
      },
    );
    await deviation(
      'CLAUDE.md "Re-render a match\'s thumbnails…": a pending put counts as busy for the (scheduled) nightly (doc ambiguous, likely means restart-when-idle only)',
      () => {
        assert.equal(
          scheduled,
          false,
          "the scheduled nightly went ahead to its pick while a Put on YouTube was on the wire",
        );
      },
    );
    releaseSet();
    await put;
    assert.equal(busyIn(602), null, "the put landed: not busy");
    assert.equal(idle(), true, "and the box is idle again");
  }
  console.log("OK: a pending put is busy for busyIn and restart-when-idle");

  console.log("busy.contract: all checks passed");
} finally {
  globalThis.fetch = realFetch;
  config.mediaDir = saved.mediaDir;
  config.youtubeChannelId = saved.channel;
  config.nightlyRenderHourUtc = saved.hour;
  if (saved.token === undefined) delete process.env.YOUTUBE_TOKEN_FILE;
  else process.env.YOUTUBE_TOKEN_FILE = saved.token;
  await rm(media, { recursive: true, force: true });
}
