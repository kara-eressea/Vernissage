/**
 * Scheduler transition math (pure).
 *
 * Given a raffle's stored UTC timestamps and the current time, decide which
 * lifecycle status it should be in. The running scheduler loop (deferred) calls
 * this on an interval and, on startup, to reconcile transitions missed while
 * the bot was offline — a raffle whose end passed during downtime jumps
 * straight to closed. Only the time-driven statuses (scheduled -> open ->
 * closed) are handled here; draft/drawn/completed/cancelled are terminal to the
 * scheduler and returned unchanged.
 *
 * See design.md "Raffle lifecycle".
 */

import type { RaffleStatus } from "./types.js";

/**
 * The status a raffle should hold at `now`, based on its schedule.
 *
 * Boundaries are inclusive of the transition instant: at exactly `startsAt` the
 * raffle is open; at exactly `endsAt` it is closed. Returns the current status
 * unchanged for statuses the scheduler does not drive.
 */
export function computeTransition(
  status: RaffleStatus,
  startsAt: string,
  endsAt: string,
  now: string,
): RaffleStatus {
  if (status !== "scheduled" && status !== "open") {
    return status;
  }

  const nowMs = Date.parse(now);
  const startMs = Date.parse(startsAt);
  const endMs = Date.parse(endsAt);

  if (nowMs >= endMs) {
    return "closed";
  }
  if (nowMs >= startMs) {
    return "open";
  }
  return "scheduled";
}
