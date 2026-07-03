/**
 * The scheduler runner.
 *
 * Runs a reconciliation sweep once at startup (catching transitions missed
 * while the bot was offline), then sweeps on a fixed interval. The clock is
 * injectable so the loop is testable without real time. Each applied transition
 * is handed to an optional onTransition callback — the seam the Discord layer
 * uses to announce openings/closings and, later, trigger auto draws.
 *
 * See design.md "Scheduler": "in-process interval task ... On startup,
 * reconcile any transitions missed while offline."
 */

import type { Database } from "better-sqlite3";
import {
  applyDueTransitions,
  type AppliedTransition,
  type SweepReason,
} from "./transitions.js";

/** Default sweep cadence (design suggests ~30 seconds). */
export const DEFAULT_TICK_MS = 30_000;

export interface SchedulerOptions {
  /** Sweep interval in milliseconds. */
  intervalMs?: number;
  /** Clock, returning UTC ISO. Injectable for tests; defaults to now. */
  now?: () => string;
  /** Called once per applied transition, in order. */
  onTransition?: (transition: AppliedTransition) => void;
}

export interface SchedulerHandle {
  /** Stop the interval. Safe to call once. */
  stop(): void;
  /** Run a sweep immediately (used at startup and by tests). */
  sweepNow(reason: SweepReason): AppliedTransition[];
}

/**
 * Start the scheduler: reconcile immediately, then sweep on an interval.
 * Returns a handle to stop it and to trigger a manual sweep.
 */
export function startScheduler(
  db: Database,
  options: SchedulerOptions = {},
): SchedulerHandle {
  const now = options.now ?? (() => new Date().toISOString());
  const intervalMs = options.intervalMs ?? DEFAULT_TICK_MS;

  const sweepNow = (reason: SweepReason): AppliedTransition[] => {
    let applied: AppliedTransition[] = [];
    try {
      applied = applyDueTransitions(db, now(), reason);
    } catch (err) {
      console.error("Scheduler sweep failed:", err);
      return [];
    }
    for (const transition of applied) {
      try {
        options.onTransition?.(transition);
      } catch (err) {
        console.error(
          `onTransition handler failed for raffle ${transition.raffleId}:`,
          err,
        );
      }
    }
    return applied;
  };

  // Startup reconciliation of anything missed while offline.
  sweepNow("reconcile");

  const timer = setInterval(() => sweepNow("scheduled"), intervalMs);
  // Don't keep the process alive solely for the scheduler tick.
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
    },
    sweepNow,
  };
}
