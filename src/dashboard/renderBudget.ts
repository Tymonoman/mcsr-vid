/**
 * The night's render cap (the operator, 22 Oct 2026: "we can cap the renders to 2 a night and only
 * increase if I decide on telegram not to post a match"). Every automated render (the nightly, its
 * chain, evening coverage, fast-track) counts against one shared budget per night:
 * `config.nightlyMaxRenders` plus one for each title-picker veto credited to that night
 * (`vetoNight`). A clicked render or "Run now" is the operator's own and is neither counted nor capped.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { readTelegramState } from "../telegram/state.js";

/** A night runs 15:00 → 15:00 UTC, so 00:xx fast-track and the 03:00 nightly share one key.
 *  ponytail: fixed offset, fine while `nightlyRenderHourUtc` sits between 0 and 14. */
export const nightKey = (ms: number): string => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

const ledgerPath = (): string => path.join(config.mediaDir, ".night-renders.json");

interface Ledger {
  night: string;
  matchIds: number[];
}

function readLedger(): Ledger {
  try {
    const l = JSON.parse(readFileSync(ledgerPath(), "utf8")) as Partial<Ledger>;
    return { night: String(l.night ?? ""), matchIds: Array.isArray(l.matchIds) ? l.matchIds : [] };
  } catch {
    return { night: "", matchIds: [] };
  }
}

/** Automated renders started this night. */
export function rendersTonight(nowMs: number): number {
  const l = readLedger();
  return l.night === nightKey(nowMs) ? l.matchIds.length : 0;
}

export function recordNightRender(matchId: number, nowMs: number): void {
  const night = nightKey(nowMs);
  const l = readLedger();
  const ids = l.night === night ? l.matchIds : [];
  const file = ledgerPath();
  // Per-process part file, like writeTelegramState: a test server sharing /media never renames a
  // half-written file of ours. ponytail: a lost update across two processes is still possible.
  writeFileSync(`${file}.${process.pid}.part`, JSON.stringify({ night, matchIds: [...ids, matchId] }, null, 2));
  renameSync(`${file}.${process.pid}.part`, file);
}

/** The night a veto pays for: the next 03:00 render after it (a veto at 10:00 UTC on D buys a
 *  render on D+1; one at 02:00 on D buys D's). Exactly one night per veto, never two. */
export const vetoNight = (vetoedAtMs: number): string => nightKey(vetoedAtMs + 12 * 3600_000);

/** Title-picker vetoes credited to `nowMs`'s night; an undone veto has no `vetoedAt` and counts 0. */
export function recentVetoes(nowMs: number, offers = readTelegramState().titleOffers): number {
  const night = nightKey(nowMs);
  return Object.values(offers).filter((o) => {
    const at = o.vetoedAt ? Date.parse(o.vetoedAt) : NaN;
    return at <= nowMs && vetoNight(at) === night;
  }).length;
}

/** Renders still allowed tonight; 0 or less means stop. */
export function renderBudgetLeft(nowMs: number): number {
  return config.nightlyMaxRenders + recentVetoes(nowMs) - rendersTonight(nowMs);
}
