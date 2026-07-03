/**
 * Activity-pruning scheduler.
 *
 * Deletes activity rows older than the longest lookback in use (design.md
 * activity table: "prune rows older than the longest lookback window in use").
 * Runs once at startup and then on a daily interval, mirroring the
 * attachMessageCounter handle pattern (setInterval + timer.unref). The cutoff is
 * computed by the pure `pruneCutoffDay` from `now` and `maxReqDaysInUse`; when no
 * lookback is in use it prunes nothing (keeps all rows).
 */

import type { Database } from "better-sqlite3";
import { pruneCutoffDay } from "../core/activity.js";
import { pruneActivityBefore } from "../db/repositories/activity.js";
import { maxReqDaysInUse } from "../db/repositories/raffles.js";

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
  /** Extra buffer days kept beyond the longest lookback. */
  safetyDays?: number;
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

  const pruneNow = (): number => {
    try {
      const max = maxReqDaysInUse(db);
      if (max === null) {
        return 0; // No lookback in use; keep everything.
      }
      return pruneActivityBefore(db, pruneCutoffDay(now(), max, safetyDays));
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
