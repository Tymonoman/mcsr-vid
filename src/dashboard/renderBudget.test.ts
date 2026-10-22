// Self-check for renderBudget.ts: the night key, the shared cap, a veto adding one, an undo or an
// old veto adding none.
// Run: npx tsx src/dashboard/renderBudget.test.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { nightKey, recentVetoes, recordNightRender, renderBudgetLeft, rendersTonight, vetoNight } from "./renderBudget.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-budget-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
config.mediaDir = media;
config.nightlyMaxRenders = 2;

const at = (iso: string) => Date.parse(iso);
// 00:13 fast-track and the 03:00 nightly are one night; 16:00 is the next.
assert.equal(nightKey(at("2026-10-22T00:13:00Z")), nightKey(at("2026-10-22T03:00:00Z")));
assert.equal(nightKey(at("2026-10-21T20:00:00Z")), nightKey(at("2026-10-22T03:00:00Z")));
assert.notEqual(nightKey(at("2026-10-22T03:00:00Z")), nightKey(at("2026-10-22T16:00:00Z")));

const t1 = at("2026-10-22T00:13:00Z");
assert.equal(renderBudgetLeft(t1), 2);
recordNightRender(1, t1);
recordNightRender(2, at("2026-10-22T03:00:00Z"));
assert.equal(rendersTonight(at("2026-10-22T03:40:00Z")), 2);
assert.equal(renderBudgetLeft(at("2026-10-22T03:40:00Z")), 0, "two renders spend the night");
assert.equal(rendersTonight(at("2026-10-22T16:00:00Z")), 0, "a new night starts empty");

const now = at("2026-10-23T03:00:00Z");
const offers = {
  "10": { messageId: 1, options: [], source: [], at: "", vetoedAt: "2026-10-22T10:00:00Z" },
  "11": { messageId: 2, options: [], source: [], at: "", vetoedAt: "2026-10-21T01:00:00Z" },
  "12": { messageId: 3, options: [], source: [], at: "" },
  "13": { messageId: 4, options: [], source: [], at: "", vetoedAt: "2026-10-23T02:00:00Z" },
  "14": { messageId: 5, options: [], source: [], at: "", vetoedUploadedAt: "2026-10-22T12:00:00Z" },
} as never;
assert.equal(recentVetoes(now, offers), 3, "a morning veto buys the next night, a 02:00 veto the same night; an undone one has no vetoedAt");
// One night per veto: the 10:00 veto counts for the 23rd's render and never again on the 24th.
assert.equal(recentVetoes(at("2026-10-24T03:00:00Z"), offers), 0, "a veto is never credited to two nights");
assert.equal(vetoNight(at("2026-10-22T10:00:00Z")), nightKey(at("2026-10-23T03:00:00Z")));
assert.equal(vetoNight(at("2026-10-22T20:00:00Z")), nightKey(at("2026-10-23T03:00:00Z")));

await rm(media, { recursive: true, force: true });
console.log("renderBudget.test.ts: ok");
