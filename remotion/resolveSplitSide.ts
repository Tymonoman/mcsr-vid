export type SplitSideState = { kind: "pending" } | { kind: "dnf" } | { kind: "time"; ms: number };

/** A side reveals at its checkpoint frame; a DNF only becomes certain once the run is over. */
export function resolveSplitSide(
  ms: number | null,
  timerStartFrame: number,
  fps: number,
  runEndFrame: number,
  frame: number,
): SplitSideState {
  if (ms === null) return frame >= runEndFrame ? { kind: "dnf" } : { kind: "pending" };
  const revealFrame = timerStartFrame + (ms / 1000) * fps;
  return frame >= revealFrame ? { kind: "time", ms } : { kind: "pending" };
}

/**
 * Whichever side reveals a real time first is provably leading: reveal frame is
 * timerStartFrame + ms/1000*fps for both sides, so an earlier reveal means a lower ms.
 * No need to wait for the other side to resolve before coloring the leader.
 */
export function compareSplitSides(
  left: SplitSideState,
  right: SplitSideState,
): { leftLeads: boolean; deltaMs: number | null } {
  const l = left.kind === "time" ? left.ms : null;
  const r = right.kind === "time" ? right.ms : null;
  const leftLeads = r === null || (l !== null && l <= r);
  const deltaMs = l !== null && r !== null ? Math.abs(l - r) : null;
  return { leftLeads, deltaMs };
}
