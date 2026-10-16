/**
 * The YouTube panel's status word (public/youtube.js `uploadedHtml`, a browser script probed the
 * way splitsChart.test.ts probes splits.js). A record's `privacyStatus`/`publishAt` are from
 * upload or adopt time and never updated, so the panel reads the live `stats` when YouTube
 * answered: a Studio draft adopted private said "private" with 1,501 views on it (14 Oct 2026).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(import.meta.dirname, "..", "public", "youtube.js"), "utf8");
const uploadedHtml = new Function("esc", `${source}; return uploadedHtml;`)((s: unknown) =>
  String(s ?? ""),
) as (u: unknown, statsError: string | null, engagementError: string | null) => string;

const stats = (privacyStatus: string, publishAt: string | null = null) => ({
  videoId: "tT8Uj2HOF1o",
  privacyStatus,
  publishAt,
  views: 1501,
  likes: 10,
  comments: 2,
});
const record = (privacyStatus: string, publishAt: string | null = null) => ({
  matchId: 13223455,
  videoId: "tT8Uj2HOF1o",
  source: "studio",
  privacyStatus,
  publishAt,
});
const statusWord = (u: unknown, statsError: string | null = null) => {
  const html = uploadedHtml(u, statsError, null);
  const m = /<\/a>\s*<span class="id">([^<]*)<\/span>/.exec(html);
  assert.ok(m, html);
  return m[1];
};
const past = "2026-10-01T17:00:00Z";
const future = "2026-10-20T17:00:00Z";

// Adopted private, public now: the live status, not the adopt-time one.
assert.equal(statusWord({ ...record("private"), stats: stats("public") }), "public");
// ...and the reverse: a record saying public for a video since made private.
assert.equal(statusWord({ ...record("public"), stats: stats("private") }), "private");
// A dashboard upload scheduled for a time now past, live public: not "scheduled for <past date>".
assert.equal(statusWord({ ...record("private", past), stats: stats("public") }), "public");
// Still scheduled on YouTube: the live publish time.
assert.ok(statusWord({ ...record("private"), stats: stats("private", future) }).startsWith("scheduled for "));
// YouTube unreachable (stats null): the record is all there is, as before.
assert.ok(statusWord({ ...record("private", future), stats: null }, "quota").startsWith("scheduled for "));
assert.equal(statusWord({ ...record("unlisted"), stats: null }, "quota"), "unlisted");

console.log("OK: YouTube panel status reads the live privacy, the record only when YouTube did not answer");
