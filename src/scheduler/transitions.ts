/**
 * Applying due raffle transitions.
 *
 * On each scheduler tick (and once at startup for reconciliation), we load the
 * time-driven raffles, ask the pure computeTransition what status each should
 * hold now, and persist any change together with an audit_log row. All writes
 * for a sweep happen in one transaction so a crash mid-sweep leaves the DB
 * consistent. See design.md "Raffle lifecycle" and "Scheduler".
 */

import type { Database } from "better-sqlite3";
import { computeTransition } from "../core/transitions.js";
import type { DrawMode, RaffleStatus } from "../core/types.js";
import { writeAudit } from "../db/repositories/audit.js";
import { listByStatusAllGuilds, setStatus } from "../db/repositories/raffles.js";

/** Why a sweep ran: startup reconciliation vs a normal scheduled tick. */
export type SweepReason = "reconcile" | "scheduled";

export interface AppliedTransition {
  raffleId: number;
  guildId: string;
  from: RaffleStatus;
  to: RaffleStatus;
  /** The raffle's draw mode, so a caller can trigger an auto draw on close. */
  drawMode: DrawMode | null;
}

/** The statuses the scheduler drives; others are terminal to it. */
const DRIVEN_STATUSES: RaffleStatus[] = ["scheduled", "open"];

/**
 * Detect and persist every due transition as of `now` (UTC ISO). Returns the
 * transitions applied, in raffle-id order, so a caller can react (announce,
 * trigger an auto draw). Idempotent: a raffle already in its correct status
 * produces no change and no audit row.
 */
export function applyDueTransitions(
  db: Database,
  now: string,
  reason: SweepReason,
): AppliedTransition[] {
  const raffles = listByStatusAllGuilds(db, DRIVEN_STATUSES);
  const applied: AppliedTransition[] = [];

  const sweep = db.transaction(() => {
    for (const raffle of raffles) {
      // A driven raffle must have both timestamps; skip defensively if not.
      // This should be unreachable (a raffle leaves draft only with both set),
      // so warn rather than fail silently if it ever happens.
      if (raffle.starts_at === null || raffle.ends_at === null) {
        console.warn(
          `Raffle ${raffle.raffle_id} is ${raffle.status} but missing ` +
            `starts_at/ends_at; skipping transition.`,
        );
        continue;
      }
      const from = raffle.status as RaffleStatus;
      const to = computeTransition(from, raffle.starts_at, raffle.ends_at, now);
      if (to === from) {
        continue;
      }

      setStatus(db, raffle.raffle_id, to);
      writeAudit(db, {
        guildId: raffle.guild_id,
        raffleId: raffle.raffle_id,
        eventType: to === "open" ? "raffle_opened" : "raffle_closed",
        actorId: "scheduler",
        payload: { from, to, reason },
        createdAt: now,
      });
      applied.push({
        raffleId: raffle.raffle_id,
        guildId: raffle.guild_id,
        from,
        to,
        drawMode: raffle.draw_mode as DrawMode | null,
      });
    }
  });
  sweep();

  return applied;
}
