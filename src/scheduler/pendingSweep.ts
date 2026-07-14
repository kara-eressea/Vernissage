/**
 * Pending-raffle sweeper.
 *
 * Deletes expired (and redeemed) Raffle Designer handoff rows so the staging
 * table can't accumulate stale tokens (design.md "Raffle Designer handoff").
 * Runs once at startup and then on an interval, mirroring the activity-pruning
 * handle pattern (setInterval + timer.unref). Pending rows are inert, so this is
 * pure housekeeping.
 */

import type { Database } from "better-sqlite3";
import { sweepExpiredPendingRaffles } from "../db/repositories/pendingRaffles.js";

/** Default cadence: sweep expired handoff tokens hourly. */
export const DEFAULT_PENDING_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface PendingSweepHandle {
  /** Stop the sweep timer. Safe to call once. */
  stop(): void;
  /** Run a sweep immediately (startup + tests). Returns rows removed. */
  sweepNow(): number;
}

export interface PendingSweepOptions {
  intervalMs?: number;
  /** Clock, returning UTC ISO. Injectable for tests; defaults to now. */
  now?: () => string;
}

/** Start sweeping expired pending raffles; returns a handle to stop it. */
export function startPendingRaffleSweep(
  db: Database,
  options: PendingSweepOptions = {},
): PendingSweepHandle {
  const now = options.now ?? (() => new Date().toISOString());
  const intervalMs = options.intervalMs ?? DEFAULT_PENDING_SWEEP_INTERVAL_MS;

  const sweepNow = (): number => {
    try {
      return sweepExpiredPendingRaffles(db, now());
    } catch (err) {
      console.error("Pending-raffle sweep failed:", err);
      return 0;
    }
  };

  sweepNow(); // Startup reconcile.

  const timer = setInterval(sweepNow, intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
    },
    sweepNow,
  };
}
