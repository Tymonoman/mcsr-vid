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
console.log("publishSlot: all checks passed");
