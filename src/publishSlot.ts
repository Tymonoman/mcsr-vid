/**
 * The next fixed publish slot.
 *
 * Browse is three quarters of this channel's traffic, and browse rewards a slot the audience
 * can expect; `publishHourUtc` is the active competitor's measured slot (see src/config.ts).
 *
 * `minLeadMs` skips a slot that is too close to upload for: a scheduled time YouTube has already
 * passed rejects the whole upload, and an 800 MB file is not on the platform in five minutes.
 */
import { msUntilNextRun } from "./nightly.js";

export function nextPublishSlot(nowMs: number, hourUtc: number, minLeadMs = 60 * 60 * 1000): Date {
  let at = nowMs + msUntilNextRun(nowMs, hourUtc);
  if (at - nowMs < minLeadMs) at += 24 * 60 * 60 * 1000;
  return new Date(at);
}
