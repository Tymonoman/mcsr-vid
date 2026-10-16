// Contract test: the nightly never renders a DNF, queued or not (the operator, 16 Oct 2026:
// "remember not to post DNF matches also dont suggest them"). The queue outranks nightlySkip and the
// known-player gate; like the block list, this outranks the queue. Written from the rule:
//  1. A queued DNF is skipped with a log line naming it, and the night takes the next candidate.
//  2. A night whose only candidate is a queued DNF starts nothing, and the queue entry stays.
//  3. A queued DNF the scan's pool holds is resolved by its own read, never shown by the preview.
//  4. A finished queued match is unaffected.
// The MCSR API is a fake serving real fixtures under test ids; nothing renders.
// Run: MCSR_CONFIG=/nonexistent/mcsr-vid.config.json npx tsx src/dashboard/nightly.dnf.contract.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MatchInfo } from "../api/types.js";
import { config } from "../config.js";
import { nightlyQueue, setNightlyQueue } from "./matchShelf.js";
import {
  nightlyEligible,
  pickNightlyCandidate,
  previewPick,
  resolveQueuedPick,
  runNightlyOnce,
} from "./nightly.js";
import { CACHE_VERSION } from "./suggest.js";

const media = mkdtempSync(path.join(tmpdir(), "mcsr-nightly-dnf-"));
assert.ok(media.startsWith(tmpdir()), "refusing to run outside tmpdir");
const saved = { mediaDir: config.mediaDir, fetch: globalThis.fetch };
config.mediaDir = media;

const fixture = (id: number): MatchInfo =>
  JSON.parse(readFileSync(new URL(`../fixtures/match-${id}.json`, import.meta.url), "utf8")) as MatchInfo;
const FORFEIT = 20_200_001; // edcr vs doogile, forfeited: the shape 13303909 has on the live API
const FINISHED = 20_200_002; // Infume vs Feinberg, as played
const served = new Map<number, MatchInfo>([
  [FORFEIT, { ...fixture(12730175), id: FORFEIT, forfeited: true, completions: [] }],
  [FINISHED, { ...fixture(13446429), id: FINISHED }],
]);
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const id = Number(/^\/matches\/(\d+)$/.exec(url.pathname)?.[1]);
  const m = served.get(id);
  if (!m) throw new Error(`no network in this test: ${url.href}`);
  return new Response(JSON.stringify({ status: "success", data: m }));
}) as typeof fetch;

/** Runs `fn` with console.error captured. */
async function logged<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = error;
  }
}

const night = { processedIds: [], hiddenIds: new Set<number>(), freeMatches: 9 };
const vodsReady = async () => true;
const skipLine = new RegExp(`nightly: #${FORFEIT} skipped — match ${FORFEIT} is a DNF \\(nobody finished\\)`);

try {
  // --- 1. Queued DNF first, finished match second ---------------------------------------------------
  {
    const queue = [FORFEIT, FINISHED];
    const { value, lines } = await logged(() =>
      pickNightlyCandidate([], { ...night, queue }, nightlyEligible(queue, vodsReady), resolveQueuedPick),
    );
    assert.equal(value?.metrics.matchId, FINISHED, "the night takes the finished match behind it");
    assert.ok(
      lines.some((l) => skipLine.test(l)),
      `the skip is logged, naming the DNF: ${lines.join(" | ")}`,
    );
    console.log("OK: a queued DNF is skipped with its log line; the finished match behind it is the pick");
  }

  // --- 4. The control: the finished match alone in the queue, the same gates ----------------------
  {
    const queue = [FINISHED];
    const { value, lines } = await logged(() =>
      pickNightlyCandidate([], { ...night, queue }, nightlyEligible(queue, vodsReady), resolveQueuedPick),
    );
    assert.equal(value?.metrics.matchId, FINISHED, "a finished queued match is picked");
    assert.ok(!lines.some((l) => /DNF/.test(l)), "and nothing about it reads as a DNF");
    console.log("OK: a finished queued match is unaffected");
  }

  // --- 2. The run end to end, a DNF its only candidate ---------------------------------------------
  {
    setNightlyQueue([FORFEIT]);
    const { value: run, lines } = await logged(() =>
      runNightlyOnce("", { renderInFlight: () => false, ranked: async () => [], now: () => Date.now() }),
    );
    assert.ok(run.skipped, `nothing started: ${JSON.stringify(run)}`);
    assert.ok(
      lines.some((l) => skipLine.test(l)),
      "the run logs why",
    );
    assert.deepEqual(nightlyQueue(), [FORFEIT], "the queue entry stays for the operator to remove");
    console.log("OK: a night with only a queued DNF renders nothing and leaves the queue as it was");
  }

  // --- 3. Pooled DNF: resolved by its own read, never previewed ------------------------------------
  {
    const flagged = (matchId: number, players: [string, string], dnf: boolean) => ({
      metrics: { matchId, players, dnf },
    });
    writeFileSync(
      path.join(media, ".suggest-cache.json"),
      JSON.stringify({
        version: CACHE_VERSION,
        pool: {
          [FORFEIT]: flagged(FORFEIT, ["edcr", "doogile"], true),
          [FINISHED]: flagged(FINISHED, ["Infume", "Feinberg"], false),
        },
      }),
    );
    const resolved = await resolveQueuedPick(FORFEIT);
    assert.equal(resolved?.metrics.dnf, true, "the pool's DNF is read for itself and marked");
    const queue = [FORFEIT, FINISHED];
    const { value } = await logged(() => previewPick([], { ...night, queue }));
    assert.equal(value?.metrics.matchId, FINISHED, "the preview never promises the DNF");
    console.log("OK: a pooled DNF in the queue is marked by its own read and left out of the preview");
  }
} finally {
  config.mediaDir = saved.mediaDir;
  globalThis.fetch = saved.fetch;
  rmSync(media, { recursive: true, force: true });
}

console.log("nightly.dnf.contract: all checks passed");
