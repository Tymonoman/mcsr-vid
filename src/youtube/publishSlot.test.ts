import assert from "node:assert/strict";
import { nextPublishSlot } from "./publishSlot.js";

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

console.log("publishSlot: all checks passed");
