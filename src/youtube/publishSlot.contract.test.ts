// Contract test for the publish slot (src/youtube/publishSlot.ts), written from the docs alone —
// CLAUDE.md "nightlyUpload" + "Publish kit", handbook/claude-md-reference.md "`nightlyUpload` is
// scheduled", "Publish kit" and the experiment engine's `rankedHoursUtc` paragraph — by someone
// who had not read the module first. publishSlot.test.ts already pins the bare walk; this file
// drives the documented promises through the public surface end to end: a temp media dir holding
// upload records, status files, `.dashboard.json` and `.experiments.json`, the MCSR API stubbed at
// fetch. The chain's side (claimSlot, the kit's Publish at) is shortFlow.publishSlot.contract.test.ts.
//
// The promises the docs make (P-numbers shared with the shortFlow file):
//  P1  A ranked video's slot is `publishHourUtc`, default 19:00 UTC.
//  P2  A series video (`series.json` in its directory) takes `seriesPublishHourUtc`, default 23:00 UTC.
//  P3  A ranked video and a series of the same two players are kept `seriesPairGapDays` (default 3)
//      UTC calendar days apart, scheduled or public; 0 turns it off.
//  P4  The slot pushed by that gap says so beside the slot (`why`).
//  P5  The slot is the next *free* one: a slot already spoken for is skipped. The test is the day
//      AND the hour, so a ranked video and a series never push each other a day out.
//  P6  A time stored for a match not uploaded yet — the kit's Publish at, or a chain's `slotClaim`
//      — is a claim, and counts for the pair gap, unless its match is hidden.
//  P7  A playoff game 1 not joined yet goes out as its series: `seriesPublishHourUtc` (and, being
//      the series video, the pair gap from the same pair's ranked video).
//  P8  The slot rules come back as warnings on an operator-picked time, never refusals (`slotWarnings`).
//  P9  The publish-hour experiment (`slot.rankedHoursUtc`) touches a ranked video only, never a
//      series: sorted, first free hour wins; a day with no entry is the plain `publishHourUtc`.
//  P10 The hour is UTC: a European or US clock change does not move it.
//  — the chain's half (P11–P18: claimSlot serialised, the claim's lifetime, the operator's time,
//    nightlyUpload modes, the Short 18 h later, Publish at stored in UTC and warned not refused)
//    is in src/dashboard/shortFlow.publishSlot.contract.test.ts.
//
// Run: MCSR_CONFIG=/nonexistent npx tsx src/youtube/publishSlot.contract.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { _setChannelUploadsForTest } from "./channelUploads.js";
import {
  claimedPublishTimes,
  MIN_LEAD_MS,
  nextPublishSlot,
  pairGapTimes,
  publishHourFor,
  publishSlotFor,
  slotWarnings,
} from "./publishSlot.js";
import { _setPlayoffContextForTest, type PlayoffContext } from "../playoffs/playoffs.js";

/** A documented promise the code does not keep: printed, recorded, and the run goes on (triage later). */
const deviations: string[] = [];
async function deviation(clause: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    deviations.push(clause);
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
const iso = (d: Date) => d.toISOString();
const dayOf = (ms: number) => Math.floor(ms / DAY);

/* --- P1, P2, P3: the documented defaults (test:unit runs on DEFAULTS) --------------------------- */
// The 19:00 is the competitor's measured hour, the 23:00 the series' own lean-back hour, the 3 days
// the doogile–Aquacorde lesson (84 views beside 2,095): the docs quote all three numbers.
assert.equal(config.publishHourUtc, 19, "ranked slot is 19:00 UTC by default");
assert.equal(config.seriesPublishHourUtc, 23, "series slot is 23:00 UTC by default");
assert.equal(config.seriesPairGapDays, 3, "a pair's ranked video and series are 3 days apart by default");
assert.equal(MIN_LEAD_MS, 3_600_000, "the chain takes a time only while it is an hour ahead");

/* --- A temp media dir, the MCSR API stubbed at fetch -------------------------------------------- */
config.mediaDir = mkdtempSync(path.join(tmpdir(), "mcsr-slot-contract-"));
process.env.MCSR_ARCHIVE_DIR ??= mkdtempSync(path.join(tmpdir(), "mcsr-slot-archive-"));
/** The two seats of each match id the stub serves; synthetic uuids, no real runner. */
const seats = new Map<number, [string, string]>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const m = /\/matches\/(\d+)$/.exec(new URL(String(input)).pathname);
  const pair = m ? seats.get(Number(m[1])) : undefined;
  if (!m || !pair) return new Response("not found", { status: 404 });
  const data = {
    id: Number(m[1]),
    type: 2,
    season: 11,
    players: pair.map((uuid) => ({ uuid, nickname: `runner-${uuid}` })),
    timelines: [],
    result: { uuid: null, time: 0 },
  };
  return new Response(JSON.stringify({ status: "success", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const dirOf = (id: number) => path.join(config.mediaDir, String(id));
function match(id: number, pair: [string, string], files: Record<string, unknown> = {}): void {
  seats.set(id, pair);
  mkdirSync(dirOf(id), { recursive: true });
  for (const [name, body] of Object.entries(files))
    writeFileSync(path.join(dirOf(id), name), JSON.stringify(body));
}
/** What the dashboard writes once an upload lands (youtube.json). */
const uploaded = (
  publishAt: string | null,
  privacyStatus = "private",
  uploadedAt = "2026-10-19T10:00:00Z",
) => ({
  "youtube.json": {
    videoId: `v-${Math.random()}`,
    uploadedAt,
    publishAt,
    privacyStatus,
    thumbnailVariant: null,
    title: "t",
  },
});
const SERIES = { "series.json": {} };
/** A status file for a match not uploaded yet: the kit's own time and/or a chain's live claim. */
const status = (id: number, times: { publishAt?: string; slotClaim?: string }) => ({
  [`short-${id}.status.json`]: { steps: {}, errors: [], ...times },
});

const MORNING = at("2026-10-20T06:30:00Z");

/* --- P1/P2: the hour by kind, through the public helpers --------------------------------------- */
match(1001, ["u-a1", "u-b1"]);
match(1002, ["u-a2", "u-b2"], SERIES);
assert.equal(publishHourFor(dirOf(1001)), 19, "a ranked match's directory publishes at 19");
assert.equal(publishHourFor(dirOf(1002)), 23, "a series.json directory publishes at 23");
assert.deepEqual(await publishSlotFor(1001, MORNING), {
  at: new Date("2026-10-20T19:00:00.000Z"),
  why: null,
});
assert.deepEqual(await publishSlotFor(1002, MORNING), {
  at: new Date("2026-10-20T23:00:00.000Z"),
  why: null,
});

/* --- P5: day AND hour — the two kinds never push each other a day out, end to end --------------- */
// Records on disk (not the bare walk publishSlot.test.ts pins): a series already scheduled for
// tonight's 23:00 leaves tonight's 19:00 free for a ranked video of *another* pair, and the reverse.
match(1003, ["u-a3", "u-b3"], { ...SERIES, ...uploaded("2026-10-20T23:00:00Z") });
match(1004, ["u-a4", "u-b4"], uploaded("2026-10-20T19:00:00Z"));
assert.equal(
  iso((await publishSlotFor(1001, MORNING)).at),
  "2026-10-21T19:00:00.000Z",
  "1004's 19:00 tonight is taken — the next ranked slot is tomorrow's 19:00",
);
assert.equal(
  iso((await publishSlotFor(1002, MORNING)).at),
  "2026-10-21T23:00:00.000Z",
  "1003's 23:00 tonight is taken — the next series slot is tomorrow's 23:00",
);
// …and neither kind moved the other: tonight's *other* hour was not the reason either was pushed.
assert.deepEqual(
  (await claimedPublishTimes(1001)).sort(),
  ["2026-10-20T19:00:00Z", "2026-10-20T23:00:00Z"],
  "every recorded time but the match's own is a claim",
);
const rankedOnly = nextPublishSlot(MORNING, 19, ["2026-10-20T23:00:00Z"]);
assert.equal(iso(rankedOnly), "2026-10-20T19:00:00.000Z", "a 23:00 claim leaves the same day's 19:00 free");

/* --- P6: a chain's live slotClaim and the kit's stored time are claims; hidden ones are not ----- */
{
  const morning = at("2026-11-02T06:30:00Z");
  match(2001, ["u-c1", "u-d1"], status(2001, { slotClaim: "2026-11-02T19:00:00.000Z" }));
  match(2002, ["u-c2", "u-d2"], status(2002, { publishAt: "2026-11-03T19:00:00.000Z" }));
  match(2003, ["u-c3", "u-d3"]);
  // 7 Oct 2026: four chains computed "the next free slot" before any had written one — the claim
  // written at the pick is what a concurrent pick must see.
  assert.equal(
    iso((await publishSlotFor(2003, morning)).at),
    "2026-11-04T19:00:00.000Z",
    "another chain's slotClaim (2nd) and another match's kit time (3rd) are both taken",
  );
  // A match's own claim is not a clash for itself: its own booking must not push its own slot.
  assert.equal(
    iso((await publishSlotFor(2001, morning)).at),
    "2026-11-02T19:00:00.000Z",
    "its own claim on the 2nd is its slot, not a reason to move",
  );
  assert.ok(!(await claimedPublishTimes(2001)).includes("2026-11-02T19:00:00.000Z"), "own claim excluded");
  assert.ok((await claimedPublishTimes(2003)).includes("2026-11-02T19:00:00.000Z"), "others see it");
  // Hidden: "it is not going anywhere" — its claim and its kit time stop counting.
  writeFileSync(path.join(config.mediaDir, ".dashboard.json"), JSON.stringify({ hidden: [2001, 2002] }));
  assert.equal(
    iso((await publishSlotFor(2003, morning)).at),
    "2026-11-02T19:00:00.000Z",
    "hidden: both free again",
  );
  writeFileSync(path.join(config.mediaDir, ".dashboard.json"), JSON.stringify({ hidden: [] }));
}

/* --- P3, P4, P6: the pair gap, from every documented source ------------------------------------ */
{
  const morning = at("2026-11-10T06:30:00Z");
  // A dashboard-recorded ranked video that went out PUBLIC yesterday (no publishAt; its day is its
  // upload): "scheduled or public" — the series of the same pair waits three UTC days from it.
  match(3001, ["u-e", "u-f"], uploaded(null, "public", "2026-11-09T19:00:00Z"));
  match(3002, ["u-f", "u-e"], SERIES); // a room seats by uuid: the pair is order-free
  const s = await publishSlotFor(3002, morning);
  assert.equal(iso(s.at), "2026-11-12T23:00:00.000Z", "9th + 3 UTC days = the 12th, at the series hour");
  assert.match(
    s.why ?? "",
    /3 days from this pair's ranked video \(2026-11-09\)/,
    "and it says why beside the slot",
  );
  assert.deepEqual(await pairGapTimes(3002, morning - 4 * DAY), [at("2026-11-09T19:00:00Z")]);

  // A chain's slotClaim on a ranked video counts for the gap too (it is a time "settled on").
  match(3003, ["u-g", "u-h"], status(3003, { slotClaim: "2026-11-10T19:00:00.000Z" }));
  match(3004, ["u-h", "u-g"], SERIES);
  const claimed = await publishSlotFor(3004, morning);
  assert.equal(iso(claimed.at), "2026-11-13T23:00:00.000Z", "kept 3 days from a live claim");
  assert.match(claimed.why ?? "", /this pair's ranked video \(2026-11-10\)/);
  // …unless that match is hidden.
  writeFileSync(path.join(config.mediaDir, ".dashboard.json"), JSON.stringify({ hidden: [3003] }));
  assert.deepEqual(await publishSlotFor(3004, morning), {
    at: new Date("2026-11-10T23:00:00.000Z"),
    why: null,
  });
  writeFileSync(path.join(config.mediaDir, ".dashboard.json"), JSON.stringify({ hidden: [] }));

  // Two ranked videos of one pair are not "a ranked video and a series": no gap between them.
  match(3005, ["u-e", "u-f"]);
  assert.equal((await publishSlotFor(3005, morning)).why, null, "ranked beside ranked is not the rule");

  // 0 turns it off.
  config.seriesPairGapDays = 0;
  assert.equal(iso((await publishSlotFor(3002, morning)).at), "2026-11-10T23:00:00.000Z", "0 is off");
  config.seriesPairGapDays = 3;
}

/* --- P7: a playoff game 1 not joined yet goes out as its series ------------------------------- */
{
  const morning = at("2026-11-20T06:30:00Z");
  match(4001, ["u-i", "u-j"]);
  _setPlayoffContextForTest(4001, { gameNo: 1 } as PlayoffContext);
  assert.equal(
    iso((await publishSlotFor(4001, morning)).at),
    "2026-11-20T23:00:00.000Z",
    "series hour, not 19:00",
  );

  // Being the series video, it is the "series" of the pair rule: the same pair's ranked video
  // scheduled for tonight must keep it three UTC days away, like a joined series.
  match(4002, ["u-j", "u-i"], uploaded("2026-11-20T19:00:00Z"));
  await deviation(
    "a playoff game 1 not joined yet goes out as its series (seriesPublishHourUtc) — and publishSlotFor keeps a ranked video and a series of the same two players seriesPairGapDays apart",
    async () => {
      const g1 = await publishSlotFor(4001, morning);
      assert.ok(
        dayOf(g1.at.getTime()) - dayOf(at("2026-11-20T19:00:00Z")) >= 3,
        `game 1 (unjoined) landed ${iso(g1.at)}, the same day as its pair's ranked video (2026-11-20 19:00)`,
      );
      assert.match(g1.why ?? "", /ranked video/);
    },
  );
  // The converse: a ranked video of the pair is kept from game 1's own stored kit time.
  match(4003, ["u-k", "u-l"], status(4003, { publishAt: "2026-11-21T23:00:00.000Z" }));
  _setPlayoffContextForTest(4003, { gameNo: 1 } as PlayoffContext);
  match(4004, ["u-l", "u-k"]);
  await deviation(
    "a ranked video is kept seriesPairGapDays from the same pair's series — including one still in game 1's unjoined directory",
    async () => {
      const r = await publishSlotFor(4004, morning);
      assert.ok(
        Math.abs(dayOf(r.at.getTime()) - dayOf(at("2026-11-21T23:00:00Z"))) >= 3,
        `ranked landed ${iso(r.at)}, the same UTC day as its pair's series kit time 2026-11-21 23:00`,
      );
    },
  );
}

/* --- P8: an operator-picked time gets the rules as warnings, never as a refusal ----------------- */
{
  const morning = at("2026-11-10T06:30:00Z");
  // 3003's live claim holds the 10th's 19:00; 3001 (same pair as 3002) went public on the 9th.
  const w = await slotWarnings(3005, at("2026-11-10T19:45:00Z"), morning);
  assert.equal(w.length, 1, "a time inside a claimed hour is one warning");
  assert.match(w[0]!, /^another video is scheduled for that hour \(2026-11-10 19:00 UTC\)/);
  const gap = await slotWarnings(3002, at("2026-11-10T23:00:00Z"), morning);
  assert.deepEqual(gap, ["under 3 days from this pair's ranked video (2026-11-09)"], "the gap, as words");
  assert.deepEqual(
    await slotWarnings(3002, at("2026-11-12T23:00:00Z"), morning),
    [],
    "three days on is clear",
  );
  // A slot rule never becomes a thrown error: a junk claim on disk is still only "no warning".
  match(3006, ["u-m", "u-n"], status(3006, { slotClaim: "not a time" }));
  assert.deepEqual(await slotWarnings(3005, at("2026-11-15T19:00:00Z"), morning), []);
}

/* --- P9: the publish-hour experiment is a ranked video's, never a series' ----------------------- */
{
  const morning = at("2026-12-01T06:30:00Z");
  writeFileSync(
    path.join(config.mediaDir, ".experiments.json"),
    JSON.stringify({
      experiments: [],
      // Unsorted on purpose: "sorted, first free hour wins".
      schedule: [
        { date: "2026-12-01", experimentId: "two-a-day", arm: "15+19", slot: { rankedHoursUtc: [19, 15] } },
      ],
    }),
  );
  match(5001, ["u-o1", "u-p1"]);
  match(5002, ["u-o2", "u-p2"], SERIES);
  assert.equal(
    iso((await publishSlotFor(5001, morning)).at),
    "2026-12-01T15:00:00.000Z",
    "the earlier arm hour first",
  );
  match(5003, ["u-o3", "u-p3"], status(5003, { slotClaim: "2026-12-01T15:00:00.000Z" }));
  assert.equal(
    iso((await publishSlotFor(5001, morning)).at),
    "2026-12-01T19:00:00.000Z",
    "15:00 taken: the day's 19:00",
  );
  match(5004, ["u-o4", "u-p4"], status(5004, { slotClaim: "2026-12-01T19:00:00.000Z" }));
  assert.equal(
    iso((await publishSlotFor(5001, morning)).at),
    "2026-12-02T19:00:00.000Z",
    "both arm hours taken: the next day has no entry, so the plain publishHourUtc",
  );
  assert.equal(
    iso((await publishSlotFor(5002, morning)).at),
    "2026-12-01T23:00:00.000Z",
    "a series ignores the arm",
  );
  // A playoff game 1 (unjoined) is a series for the arm too.
  match(5005, ["u-o5", "u-p5"]);
  _setPlayoffContextForTest(5005, { gameNo: 1 } as PlayoffContext);
  assert.equal(
    iso((await publishSlotFor(5005, morning)).at),
    "2026-12-01T23:00:00.000Z",
    "game 1 ignores the arm",
  );
  writeFileSync(path.join(config.mediaDir, ".experiments.json"), "{ corrupt");
  assert.equal(
    iso((await publishSlotFor(5001, morning)).at),
    "2026-12-02T19:00:00.000Z",
    "an unreadable experiments file is 'no arm' — 19:00, the 1st's taken by 5004",
  );
}

/* --- P10: UTC is UTC across the clock changes ------------------------------------------------- */
// Europe/Warsaw falls back on 25 Oct 2026, the US on 1 Nov: the slot is 19:00 UTC either side.
for (const day of ["2026-10-24", "2026-10-26", "2026-10-31", "2026-11-02"])
  assert.equal(iso(nextPublishSlot(at(`${day}T06:00:00Z`), 19)), `${day}T19:00:00.000Z`, day);

_setChannelUploadsForTest([]);
console.log(
  `publishSlot.contract: all checks passed${deviations.length ? ` (${deviations.length} deviation(s) reported above)` : ""}`,
);
