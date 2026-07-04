/**
 * Winner claim window (pure).
 *
 * When a raffle sets a claim window, each winner must claim their prize before a
 * per-win deadline or the slot is rerolled to the next eligible entrant (see
 * design.md "Winner claim window"). These helpers compute and compare deadlines;
 * the scheduler sweep and the draw service supply `now`. No Discord or DB deps.
 */

import { MS_PER_DAY } from "./time.js";

/** Hours to milliseconds (MS_PER_DAY / 24 keeps a single source of truth). */
const MS_PER_HOUR = MS_PER_DAY / 24;

/**
 * Whether a raffle's `claim_window_hours` value enables the claim window. Null or
 * a non-positive value means winners keep their prize with no claim step.
 */
export function claimWindowEnabled(hours: number | null): hours is number {
  return hours !== null && hours > 0;
}

/**
 * The UTC ISO instant a winner drawn at `fromIso` must claim by, given a window
 * of `hours`. Callers gate on `claimWindowEnabled` first, so `hours` is positive.
 */
export function claimDeadline(fromIso: string, hours: number): string {
  return new Date(Date.parse(fromIso) + hours * MS_PER_HOUR).toISOString();
}

/**
 * Whether a claim deadline has passed at `nowIso`. The boundary is inclusive of
 * expiry: exactly at the deadline the window is closed (mirrors the exclusive
 * "still active before the instant" reading the cooldown uses).
 */
export function isClaimExpired(deadlineIso: string, nowIso: string): boolean {
  return Date.parse(nowIso) >= Date.parse(deadlineIso);
}
