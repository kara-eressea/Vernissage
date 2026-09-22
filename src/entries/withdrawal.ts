/**
 * Entry withdrawal (DB orchestration, no discord.js).
 *
 * One path serves both ways an entry comes back out of an open raffle without
 * being a punishment: a member withdrawing their own (`/raffle withdraw`) and a
 * moderator withdrawing it for them (`/raffle-mod remove-entry`, issue #47 —
 * for the member who cannot work out how to do it themselves). They are the
 * same act with a different hand on it, so they share the rules: open raffles
 * only, soft removal, re-entry allowed while the raffle stays open, and one
 * audit row.
 *
 * Who performed it is derived from the ids rather than passed as a flag, so the
 * audit row cannot claim a member withdrew when a moderator did, or the reverse:
 * an actor who is not the subject *is* the moderator case, by definition. A
 * moderator withdrawing their own entry is therefore recorded as the ordinary
 * self-withdrawal it is.
 *
 * Ban-driven removal is deliberately not this: it is punitive, sweeps every open
 * raffle at once, and records `entry_removed` — see src/blacklist/entryRemoval.ts.
 */

import type { Database } from "better-sqlite3";
import { AUDIT_EVENTS } from "../core/auditEvents.js";
import { writeAudit, type AuditEvent } from "../db/repositories/audit.js";
import { hasEntry, removeEntry } from "../db/repositories/entries.js";
import type { RaffleRow } from "../db/repositories/raffles.js";

export interface WithdrawalInput {
  /** The raffle to withdraw from. Must be open. */
  raffle: RaffleRow;
  /** The member whose entry is removed. */
  userId: string;
  /** Who performed it: the member themselves, or a moderator acting for them. */
  actorId: string;
  /** UTC ISO timestamp. */
  now: string;
}

export type WithdrawalResult =
  /**
   * The entry was removed; `event` is the audit row, for the caller to mirror.
   * Which path it was is readable from `event.eventType`, so it is not repeated
   * as a flag that could disagree with it.
   */
  | { ok: true; event: AuditEvent }
  /** Nothing was written. */
  | { ok: false; reason: "not_open" | "no_entry" };

/**
 * Soft-remove a member's entry from an open raffle and audit it, in one
 * transaction. Returns the audit event on success so the Discord layer can
 * mirror it to the audit channel; returns a reason, having written nothing, when
 * the raffle is not open or the member holds no active entry.
 */
export function withdrawEntry(db: Database, input: WithdrawalInput): WithdrawalResult {
  const { raffle, userId, actorId, now } = input;

  if (raffle.status !== "open") {
    return { ok: false, reason: "not_open" };
  }
  if (!hasEntry(db, raffle.raffle_id, userId)) {
    return { ok: false, reason: "no_entry" };
  }

  const byModerator = actorId !== userId;
  // The category is shown as-is on the dashboard's entrant list, so it reads as
  // a phrase rather than a code. It never carries a reason: why a member left a
  // raffle is not the audit channel's business (design.md "Auditability").
  const category = byModerator ? "withdrawn by mod" : "withdrawn";
  const event: AuditEvent = {
    guildId: raffle.guild_id,
    raffleId: raffle.raffle_id,
    eventType: byModerator ? AUDIT_EVENTS.entryWithdrawnByMod : AUDIT_EVENTS.entryWithdrawn,
    actorId,
    payload: { userId },
    createdAt: now,
  };

  db.transaction(() => {
    removeEntry(db, raffle.raffle_id, userId, now, category);
    writeAudit(db, event);
  })();

  return { ok: true, event };
}
