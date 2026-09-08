/**
 * The next fixed publish slot.
 *
 * Browse is three quarters of this channel's traffic, and browse rewards a slot the audience
 * can expect. The active competitor (MCSR Matches) publishes at 19:00 UTC on the dot — 36 of
 * its last 50 uploads, every one since 28 Aug 2026 — and its median there is 4.2k against 1.6k
 * for its earlier 17:xx uploads. Ours went out at 17:00, once at 05:00 (our worst video).
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
