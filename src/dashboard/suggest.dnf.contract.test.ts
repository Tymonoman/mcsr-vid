// Contract test: no DNF is ever a suggestion (the operator, 16 Oct 2026: "remember not to post DNF
// matches also dont suggest them"). A DNF is a match nobody finished — a forfeit, no winner on
// record, or no completion. Written from the rule, not the code:
//  1. A DNF from the feed or a favourite's own list is never a card in any bucket (close, chaos,
//     known), and the feed's own forfeits and no-winner entries cost no detail fetch.
//  2. A match the feed shows finished but whose record has no completion is scored, kept out of
//     every bucket, and not fetched again on the next scan.
//  3. A DNF already in .suggest-cache.json is dropped on read however stale the entry — one cached
//     before the DNF flag existed included — from the fresh cache and from the card list alike.
//  4. A finished match is unaffected.
// The MCSR API is a fake serving the real matches in src/fixtures/; Twitch is unconfigured.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/dashboard/suggest.dnf.contract.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";
import { presentSuggestions } from "./suggestPresent.js";
import { getSuggestions, type Suggestion } from "./suggest.js";

delete process.env.TWITCH_CLIENT_ID;
delete process.env.TWITCH_CLIENT_SECRET;
const media = mkdtempSync(path.join(tmpdir(), "mcsr-suggest-dnf-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
const saved = {
  mediaDir: config.mediaDir,
  fetch: globalThis.fetch,
  slots: [config.suggestCloseSlots, config.suggestChaosSlots, config.suggestKnownSlots] as const,
};
config.mediaDir = media;
[config.suggestCloseSlots, config.suggestChaosSlots, config.suggestKnownSlots] = [3, 3, 4];
const cachePath = path.join(media, ".suggest-cache.json");
const readCache = () => JSON.parse(readFileSync(cachePath, "utf8"));

const nowSec = Math.floor(Date.now() / 1000);
const fixture = (id: number, hoursAgo: number, over: Partial<MatchInfo> = {}): MatchInfo => {
  const raw = JSON.parse(
    readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8"),
  ) as MatchInfo;
  return { ...raw, changes: raw.changes ?? [], date: nowSec - hoursAgo * 3600, ...over };
};

const finished = fixture(12730175, 2); // edcr vs doogile: a favourite, so a known card at least
const control = fixture(13617328, 3); // nolqndo vs thecamo6: two no-names, close/chaos only
const forfeit = fixture(12929221, 4, { forfeited: true, completions: [] }); // Feinberg vs silverrruns
const noWinner = fixture(13446429, 5); // Infume vs Feinberg
noWinner.result = { ...noWinner.result, uuid: null };
const nobodyCompleted = fixture(13560037, 6, { completions: [] }); // v_strid vs doogile
// The feed has no completions: this one reads as finished there.
const feedOf = (m: MatchInfo) => {
  const { timelines: _t, completions: _c, ...feed } = m;
  return feed;
};
const all = [finished, control, forfeit, noWinner, nobodyCompleted];

const asked: string[] = [];
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ status: "success", data }) });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  asked.push(url);
  if (!url.startsWith("https://api.mcsrranked.com/")) throw new Error(`no network in this test: ${url}`);
  const route = url.slice("https://api.mcsrranked.com".length);
  if (route.startsWith("/matches?")) return ok(route.includes("before=") ? [] : all.map(feedOf));
  const detail = /^\/matches\/(\d+)$/.exec(route);
  if (detail) {
    const m = all.find((x) => x.id === Number(detail[1]));
    return m ? ok(m) : { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
  }
  if (route.includes("/versus/")) return ok({ results: { ranked: {} } });
  // A favourite's own list is the other door in: the forfeit comes through Feinberg's too.
  const own = /^\/users\/([^/]+)\/matches/.exec(route);
  if (own) return ok(decodeURIComponent(own[1]!).toLowerCase() === "feinberg" ? [feedOf(forfeit)] : []);
  throw new Error(`unexpected MCSR call ${url}`);
}) as unknown as typeof fetch;

const detailAsked = (id: number) => asked.filter((u) => u.endsWith(`/matches/${id}`)).length;
const DNFS = [forfeit.id, noWinner.id, nobodyCompleted.id];

try {
  // --- 1/2/4. A scan --------------------------------------------------------------------------------
  const scan = await getSuggestions({ force: true });
  const ids = scan.suggestions.map((s) => s.metrics.matchId);
  for (const id of DNFS) assert.ok(!ids.includes(id), `#${id} is a DNF and must be no card (got ${ids})`);
  assert.ok(ids.includes(finished.id), "the finished favourite's match is a card");
  assert.ok(ids.includes(control.id), "the finished no-name match is a card");
  assert.equal(detailAsked(forfeit.id), 0, "a forfeit is dropped off the feed, never fetched");
  assert.equal(detailAsked(noWinner.id), 0, "so is a match with no winner");
  console.log(
    "OK: a forfeit or a no-winner match from the feed or a favourite's list is never a card, never fetched",
  );

  const pooled = readCache().pool[String(nobodyCompleted.id)];
  assert.equal(pooled?.metrics.dnf, true, "a record with no completion is pooled as a DNF");
  assert.equal(readCache().pool[String(finished.id)]?.metrics.dnf, false, "a finished one as finished");
  // Every bucket, at once: even with slots to spare the DNF does not fill one.
  [config.suggestCloseSlots, config.suggestChaosSlots, config.suggestKnownSlots] = [10, 10, 10];
  const roomy = await getSuggestions({ force: true });
  assert.ok(
    !roomy.suggestions.some((s) => DNFS.includes(s.metrics.matchId)),
    "no bucket takes a DNF with room to spare",
  );
  assert.equal(detailAsked(nobodyCompleted.id), 1, "and it is not fetched again on the next scan");
  console.log("OK: a match nobody completed is pooled as a DNF, never selectable, never re-fetched");

  // --- 3. A stale cache ------------------------------------------------------------------------------
  const card = roomy.suggestions.find((s) => s.metrics.matchId === finished.id)!;
  const withMetrics = (id: number, over: Partial<Suggestion["metrics"]>): Suggestion => ({
    ...card,
    metrics: { ...card.metrics, matchId: id, ...over },
  });
  const unflagged = (id: number, over: Partial<Suggestion["metrics"]>): Suggestion => {
    const s = withMetrics(id, over);
    delete s.metrics.dnf; // cached before the flag existed
    return s;
  };
  const noDragon = card.metrics.splits.map((s) =>
    s.label === "Dragon" ? { ...s, aMs: null, bMs: null } : s,
  );
  const stale: Suggestion[] = [
    withMetrics(90_000_001, { dnf: true, players: ["StaleA", "StaleB"] }),
    unflagged(90_000_002, { winner: null, players: ["StaleC", "StaleD"] }),
    unflagged(90_000_003, { splits: noDragon, finishMarginMs: null, players: ["StaleE", "StaleF"] }),
    unflagged(90_000_004, { players: ["StaleG", "StaleH"] }), // finished, cached before the flag
  ];
  writeFileSync(cachePath, JSON.stringify({ ...readCache(), suggestions: stale, scannedAt: Date.now() }));
  const cached = (await getSuggestions()).suggestions.map((s) => s.metrics.matchId);
  assert.deepEqual(cached, [90_000_004], "only the finished entry is served from the fresh cache");
  assert.deepEqual(
    presentSuggestions(stale).map((c) => c.matchId),
    [90_000_004],
    "and the card list drops the DNFs whatever list it is handed",
  );
  console.log(
    "OK: a cached DNF is dropped on read however stale, flagged or not; a stale finished one stays",
  );
} finally {
  config.mediaDir = saved.mediaDir;
  globalThis.fetch = saved.fetch;
  [config.suggestCloseSlots, config.suggestChaosSlots, config.suggestKnownSlots] = saved.slots;
  rmSync(media, { recursive: true, force: true });
}

console.log("suggest.dnf.contract: all checks passed");
