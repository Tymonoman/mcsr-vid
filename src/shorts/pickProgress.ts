/**
 * How far the Short's pick is, as one percent over its phases: the proxy, /watch on each POV, the
 * model. The dashboard's Pick step draws it (`activity.percent`); videoPick.ts reports it.
 *
 * Each phase is weighted by what it typically takes on the lab (short-*.log.jsonl and the stills'
 * mtimes, 18–25 Sept 2026): the 2 fps proxy 151–324 s for one match and ~185 s a game for a
 * series, /watch 88–146 s a POV, agy's answer 141–161 s (once 1163 s). Inside a phase the work
 * says how far it is — ffmpeg's time= for the proxy, watch.py's stills on disk and its stderr
 * markers for /watch — except the model, which says nothing until it answers: its share is an
 * elapsed-time *estimate* (`modelFraction`) that never reaches the end.
 *
 * The percent never goes backwards (a retried ask restarts its clock; the bar holds) and never
 * shows 100: the pick being written is what ends the step.
 */

/** Typical seconds, per unit — only their ratios matter. */
export const PHASE_SEC = { proxyPerGame: 200, watchPerPov: 115, model: 150 };

export interface PickPhase {
  weight: number;
  /** The live line while it runs. */
  line: string;
}

/** The pick's phases in order: the proxy, one per POV (game by game, left then right), the model. */
export function pickPhases(games: ReadonlyArray<readonly [string, string]>, model: string): PickPhase[] {
  const povs = games.flat();
  return [
    { weight: PHASE_SEC.proxyPerGame * games.length, line: "making the model's copy of the video" },
    ...povs.map((nick, i) => ({
      weight: PHASE_SEC.watchPerPov,
      line: `running /watch on ${nick}'s stream · ${i + 1} of ${povs.length}`,
    })),
    { weight: PHASE_SEC.model, line: `${model} is watching the match` },
  ];
}

/** The whole pick's percent at `fraction` (clamped to 0–1) of phase `index`; at most 99. */
export function phasePercent(phases: readonly PickPhase[], index: number, fraction: number): number {
  const total = phases.reduce((s, p) => s + p.weight, 0);
  if (total <= 0) return 0;
  const i = Math.max(0, Math.min(phases.length - 1, index));
  const before = phases.slice(0, i).reduce((s, p) => s + p.weight, 0);
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return Math.min(99, Math.floor(((before + phases[i]!.weight * f) / total) * 100));
}

/**
 * An estimate, not a measurement: agy reports nothing until it answers. 1 − e^(−t/typical): 63%
 * of the phase at the typical answer time, 95% at three times it, never 1.
 */
export const modelFraction = (elapsedMs: number): number =>
  1 - Math.exp(-Math.max(0, elapsedMs) / (PHASE_SEC.model * 1000));

/**
 * How far one watch.py run is, from what it has printed to stderr and the stills in its frames
 * directory. The stills are ~95% of its time (the audio pull and Whisper ~5–7 s of ~110), so they
 * fill to 0.93 against the count it announced; each later marker is a step after them.
 */
export function watchFraction(stderr: string, framesOnDisk: number, maxFrames = 100): number {
  if (/\[watch\] transcribed |whisper fallback failed/.test(stderr)) return 0.99;
  if (/\[watch\] audio: .* uploading/.test(stderr)) return 0.97;
  if (/\[watch\] extracting audio/.test(stderr)) return 0.95;
  const announced = /\[watch\] extracting ~(\d+) frames/.exec(stderr);
  if (!announced) return 0;
  const expected = Math.min(Number(announced[1]), maxFrames);
  return expected > 0 ? 0.93 * Math.min(1, framesOnDisk / expected) : 0;
}

/**
 * The running pick's bar: `at(phase, fraction)` reports the percent — never lower than the last —
 * and the phase's line through `report`.
 */
export function pickProgress(phases: readonly PickPhase[], report: (percent: number, line: string) => void) {
  let shown = 0;
  return {
    get percent() {
      return shown;
    },
    at(index: number, fraction: number): void {
      shown = Math.max(shown, phasePercent(phases, index, fraction));
      report(shown, phases[Math.max(0, Math.min(phases.length - 1, index))]!.line);
    },
  };
}
