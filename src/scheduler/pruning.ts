/**
 * Activity-pruning scheduler.
 *
 * Deletes activity rows past the retention horizon (design.md activity table),
 * never touching a day a scheduled or open raffle is still judging entrants on.
 * Runs once at startup and then on a daily interval, mirroring the
 * attachMessageCounter handle pattern (setInterval + timer.unref). The cutoff is
 * computed by the pure `pruneCutoffDay` from `now`, the retention horizon, and
 * the earliest window start still in use.
 */

import type { Database } from "better-sqlite3";
import { ACTIVITY_RETENTION_DAYS, pruneCutoffDay } from "../core/activity.js";
import { pruneActivityBefore } from "../db/repositories/activity.js";
import { earliestActivityWindowStart } from "../db/repositories/raffles.js";

/** Default cadence: prune once a day. */
export const DEFAULT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PruningHandle {
  /** Stop the prune timer. Safe to call once. */
  stop(): void;
  /** Run a prune immediately (used at startup and by tests). Returns rows removed. */
  pruneNow(): number;
}

export interface PruningOptions {
  /** Prune interval in milliseconds. */
  intervalMs?: number;
  /** Clock, returning UTC ISO. Injectable for tests; defaults to now. */
  now?: () => string;
  /** Extra buffer days kept beyond the computed cutoff. */
  safetyDays?: number;
  /** How many days of activity to keep; defaults to the six-month horizon. */
  retentionDays?: number;
}

/**
 * Start pruning: prune once immediately, then on an interval. Returns a handle
 * to stop it and to trigger a manual prune.
 */
export function startActivityPruning(
  db: Database,
  options: PruningOptions = {},
): PruningHandle {
  const now = options.now ?? (() => new Date().toISOString());
  const intervalMs = options.intervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const safetyDays = options.safetyDays ?? 1;
  const retentionDays = options.retentionDays ?? ACTIVITY_RETENTION_DAYS;

  const pruneNow = (): number => {
    try {
      // Bounded by the retention horizon and by the earliest day any still-
      // enterable raffle needs, whichever reaches further back.
      const cutoff = pruneCutoffDay(
        now(),
        earliestActivityWindowStart(db),
        retentionDays,
        safetyDays,
      );
      return pruneActivityBefore(db, cutoff);
    } catch (err) {
      console.error("Activity pruning failed:", err);
      return 0;
    }
  };

  pruneNow(); // Startup reconcile.

  const timer = setInterval(pruneNow, intervalMs);
  // Don't keep the process alive solely for the prune timer.
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
    },
    pruneNow,
  };
}
