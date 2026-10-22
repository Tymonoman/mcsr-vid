/**
 * The night's render cap (the operator, 22 Oct 2026: "we can cap the renders to 2 a night and only
 * increase if I decide on telegram not to post a match"). Every automated render (the nightly, its
 * chain, evening coverage, fast-track) counts against one shared budget per night:
 * `config.nightlyMaxRenders` plus one for each title-picker veto in the last 24 h. A clicked
 * render or "Run now" is the operator's own and is neither counted nor capped.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { readTelegramState } from "../telegram/state.js";

const DAY_MS = 24 * 3600_000;

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
  writeFileSync(`${file}.tmp`, JSON.stringify({ night, matchIds: [...ids, matchId] }, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** Title-picker vetoes in the 24 h before `nowMs`; an undone veto has no `vetoedAt` and counts 0. */
export function recentVetoes(nowMs: number, offers = readTelegramState().titleOffers): number {
  return Object.values(offers).filter((o) => {
    const at = o.vetoedAt ? Date.parse(o.vetoedAt) : NaN;
    return at <= nowMs && nowMs - at < DAY_MS;
  }).length;
}

/** Renders still allowed tonight; 0 or less means stop. */
export function renderBudgetLeft(nowMs: number): number {
  return config.nightlyMaxRenders + recentVetoes(nowMs) - rendersTonight(nowMs);
}
