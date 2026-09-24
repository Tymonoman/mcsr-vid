import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { _setChannelUploadsForTest } from "./channelUploads.js";
import { nextPublishSlot, publishSlotFor } from "./publishSlot.js";

const at = (iso: string) => Date.parse(iso);
const iso = (d: Date) => d.toISOString();

// Morning after a nightly render: today's slot.
assert.equal(iso(nextPublishSlot(at("2026-09-08T06:30:00Z"), 19)), "2026-09-08T19:00:00.000Z");
// Past today's slot: tomorrow's.
assert.equal(iso(nextPublishSlot(at("2026-09-08T19:00:01Z"), 19)), "2026-09-09T19:00:00.000Z");
// Too close to upload for — under an hour away — skips to the next day.
assert.equal(iso(nextPublishSlot(at("2026-09-08T18:30:00Z"), 19)), "2026-09-09T19:00:00.000Z");
assert.equal(
  iso(nextPublishSlot(at("2026-09-08T17:59:00Z"), 19)),
  "2026-09-08T19:00:00.000Z",
  "an hour and a minute is enough",
);
// Exactly on the hour counts as passed (the nightly's own rule), so tomorrow.
assert.equal(iso(nextPublishSlot(at("2026-09-08T19:00:00Z"), 19)), "2026-09-09T19:00:00.000Z");
// --- Days another video has already claimed -----------------------------------------------
// Three matches rendered overnight are three matches ready by breakfast, and every one of them
// used to be offered the same slot: two of the three would have collided in Studio.
const morning = at("2026-09-08T06:30:00Z");
const slot = (day: string) => `2026-09-${day}T19:00:00.000Z`;

assert.equal(iso(nextPublishSlot(morning, 19, [slot("08")])), slot("09"), "today is taken");
assert.equal(
  iso(nextPublishSlot(morning, 19, [slot("08"), slot("09")])),
  slot("10"),
  "and so is tomorrow — walk day by day, do not stack",
);
// Out of order, and a claim in another hour: the slot is the day *and* the hour, so a video
// scheduled for 21:14 on the 8th leaves 19:00 on the 8th free — a series has its own hour
// (`seriesPublishHourUtc`) precisely so it and the ranked match of the day do not push each other
// a day out.
assert.equal(iso(nextPublishSlot(morning, 19, [slot("10"), "2026-09-08T21:14:00Z", slot("09")])), slot("08"));
assert.equal(
  iso(nextPublishSlot(morning, 23, [slot("08"), slot("09"), "2026-09-08T23:00:00Z"])),
  "2026-09-09T23:00:00.000Z",
  "the series hour walks its own days",
);
// A day nothing claims is free even when later ones are taken — the queue does not push forward
// past the first gap.
assert.equal(iso(nextPublishSlot(morning, 19, [slot("09"), slot("10")])), slot("08"));

// What must not move the slot: a claim already in the past (that video is out), and junk from a
// truncated record — a bad date is not a reason to push every upload a day out.
assert.equal(iso(nextPublishSlot(morning, 19, ["2026-09-07T19:00:00Z"])), slot("08"));
assert.equal(iso(nextPublishSlot(morning, 19, ["", "not a date", "2026-13-45T99:00:00Z"])), slot("08"));
assert.equal(iso(nextPublishSlot(morning, 19, [])), slot("08"), "nothing claimed is today's slot");

// The lead time still wins over the search: too close to today's slot skips it, and then the
// claimed days are counted from tomorrow.
assert.equal(iso(nextPublishSlot(at("2026-09-08T18:30:00Z"), 19, [slot("09")])), slot("10"));

// --- A ranked video and a series of the same pair, kept apart -----------------------------
// The doogile–Aquacorde series drew 84 views in 32 h beside their ranked video's 2,095 the same
// day (24 Sept 2026 audit). The gap is counted in UTC calendar days, both ways, past and future.
{
  const day = (d: string, h = 23) => `2026-09-${d}T${String(h).padStart(2, "0")}:00:00.000Z`;
  const ranked8 = [at(day("08", 19))];
  assert.equal(iso(nextPublishSlot(morning, 23, [], undefined, ranked8, 3)), day("11"), "8th → 11th");
  assert.equal(iso(nextPublishSlot(morning, 23, [], undefined, ranked8, 0)), day("08"), "0 is off");
  assert.equal(
    iso(nextPublishSlot(morning, 23, [], undefined, [at(day("12", 19))], 3)),
    day("08"),
    "four days before a scheduled one is far enough",
  );
  assert.equal(
    iso(nextPublishSlot(morning, 23, [], undefined, [at(day("10", 19))], 3)),
    day("13"),
    "two days before is not: after it, then",
  );
  assert.equal(
    iso(nextPublishSlot(morning, 23, [day("11")], undefined, ranked8, 3)),
    day("12"),
    "a claimed slot still walks on",
  );
}

// publishSlotFor, end to end: upload records and the channel in a temp media dir, the MCSR API
// stubbed at fetch.
{
  config.mediaDir = mkdtempSync(path.join(tmpdir(), "mcsr-slot-"));
  config.seriesPublishHourUtc = 23;
  config.seriesPairGapDays = 3;
  const players: Record<number, string[]> = {};
  const dir = (id: number, pair: string[], files: Record<string, unknown> = {}) => {
    players[id] = pair;
    const d = path.join(config.mediaDir, String(id));
    mkdirSync(d, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(d, name), JSON.stringify(body));
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const m = /\/matches\/(\d+)$/.exec(new URL(String(input)).pathname);
    const pair = m ? players[Number(m[1])] : undefined;
    if (!m || !pair) return new Response("not found", { status: 404 });
    const data = { id: Number(m[1]), players: pair.map((uuid) => ({ uuid, nickname: uuid })), timelines: [] };
    return new Response(JSON.stringify({ status: "success", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const record = (publishAt: string | null, privacyStatus = "private") => ({
    "youtube.json": {
      videoId: "v",
      uploadedAt: "2026-09-07T10:00:00Z",
      publishAt,
      privacyStatus,
      title: "t",
    },
  });
  const series = { "series.json": {} };

  // A ranked video of a+b scheduled for the 8th; the series of b+a (a room seats by uuid) waits.
  dir(100, ["a", "b"], record("2026-09-08T19:00:00Z"));
  dir(200, ["b", "a"], series);
  dir(150, ["a", "b"], record("2026-09-30T19:00:00Z")); // too far out to push anything
  const pushed = await publishSlotFor(200, morning);
  assert.equal(iso(pushed.at), "2026-09-11T23:00:00.000Z");
  assert.match(pushed.why ?? "", /3 days from this pair's ranked video \(2026-09-08\)$/);

  // One shared player is not the same pair, and a private video with no time has no day.
  dir(300, ["a", "c"], series);
  assert.deepEqual(await publishSlotFor(300, morning), {
    at: new Date("2026-09-08T23:00:00.000Z"),
    why: null,
  });
  dir(400, ["d", "e"], record(null));
  dir(500, ["d", "e"], series);
  assert.equal((await publishSlotFor(500, morning)).why, null, "private with no time");

  // Already public, known only from the channel (a Studio upload): its day counts, and a ranked
  // video is pushed off a series the same way. A Short does not count.
  dir(600, ["f", "g"]);
  dir(700, ["g", "f"], series);
  dir(800, ["h", "i"]);
  dir(900, ["h", "i"], series);
  const video = (id: number, durationSec: number) => ({
    videoId: `c${id}`,
    title: "t",
    publishedAt: "2026-09-07T23:00:00Z",
    description: `https://mcsrranked.com/matches/${id}`,
    privacyStatus: "public",
    durationSec,
  });
  _setChannelUploadsForTest([video(700, 2400), video(900, 40)]);
  const ranked = await publishSlotFor(600, morning);
  // The 8th's 19:00 is 100's, so the first free one is the 9th; the 7th's series holds it to the 10th.
  assert.equal(iso(ranked.at), "2026-09-10T19:00:00.000Z");
  assert.match(ranked.why ?? "", /this pair's series \(2026-09-07\)/);
  assert.equal((await publishSlotFor(800, morning)).why, null, "a Short does not count");
  config.seriesPairGapDays = 0;
  assert.equal(iso((await publishSlotFor(200, morning)).at), "2026-09-08T23:00:00.000Z", "0 is off");
}

console.log("publishSlot: all checks passed");
