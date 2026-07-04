/**
 * Claim-expiry scheduler.
 *
 * Rerolls winners who let their claim window lapse (design.md "Winner claim
 * window"). Runs once at startup — catching deadlines that passed while the bot
 * was offline — then on a fixed interval, mirroring the pruning/message-counter
 * handle pattern (setInterval + timer.unref). All logic lives in the draw
 * service's `expireUnclaimedWins`; this only schedules it and contains errors so
 * a bad sweep never crashes the process.
 */

import type { Database } from "better-sqlite3";
import { expireUnclaimedWins, type DrawAnnouncer } from "../draw/service.js";

/** Default cadence: check for lapsed claims once a minute. */
export const DEFAULT_CLAIM_SWEEP_INTERVAL_MS = 60_000;

export interface ClaimSweepHandle {
  /** Stop the sweep timer. Safe to call once. */
  stop(): void;
  /** Run a sweep immediately (used at startup and by tests). Resolves to rerolls. */
  sweepNow(): Promise<number>;
}

export interface ClaimSweepOptions {
  /** Sweep interval in milliseconds. */
  intervalMs?: number;
  /** Clock, returning UTC ISO. Injectable for tests; defaults to now. */
  now?: () => string;
}

/**
 * Start the claim-expiry sweep: sweep once immediately, then on an interval.
 * Returns a handle to stop it and to trigger a manual sweep.
 */
export function startClaimSweep(
  db: Database,
  announcer: DrawAnnouncer,
  options: ClaimSweepOptions = {},
): ClaimSweepHandle {
  const now = options.now ?? (() => new Date().toISOString());
  const intervalMs = options.intervalMs ?? DEFAULT_CLAIM_SWEEP_INTERVAL_MS;

  const sweepNow = async (): Promise<number> => {
    try {
      return await expireUnclaimedWins(db, announcer, now());
    } catch (err) {
      console.error("Claim-expiry sweep failed:", err);
      return 0;
    }
  };

  // Startup reconcile of deadlines that lapsed while offline.
  void sweepNow();

  const timer = setInterval(() => void sweepNow(), intervalMs);
  // Don't keep the process alive solely for the sweep timer.
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
    },
    sweepNow,
  };
}
