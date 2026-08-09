/** Formats a duration in milliseconds as speedrun-style M:SS.mmm. */
export function formatTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Formats a duration in milliseconds as M:SS, no fractional seconds. */
export function formatShortTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
