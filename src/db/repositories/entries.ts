/**
 * Entry repository.
 *
 * One row per (raffle, user); the primary key enforces the "one entry per user"
 * rule. Removals are soft (removed_at/removed_reason set) so the audit trail and
 * frozen entrant list stay reconstructable.
 */

import type { Database } from "better-sqlite3";

export interface EntryRow {
  raffle_id: number;
  user_id: string;
  entered_at: string | null;
  removed_at: string | null;
  removed_reason: string | null;
}

/**
 * Record an entry. Throws on the unique constraint if the user already has a
 * row for this raffle (callers check eligibility first).
 */
export function addEntry(
  db: Database,
  raffleId: number,
  userId: string,
  enteredAt: string,
): void {
  db.prepare(
    `INSERT INTO entries (raffle_id, user_id, entered_at)
     VALUES (?, ?, ?)`,
  ).run(raffleId, userId, enteredAt);
}

/** Soft-remove an entry (e.g. on blacklist), recording when and optionally why. */
export function removeEntry(
  db: Database,
  raffleId: number,
  userId: string,
  removedAt: string,
  reason: string | null = null,
): void {
  db.prepare(
    `UPDATE entries
       SET removed_at = ?, removed_reason = ?
     WHERE raffle_id = ? AND user_id = ?`,
  ).run(removedAt, reason, raffleId, userId);
}

/** Whether the user has an active (not removed) entry in the raffle. */
export function hasEntry(db: Database, raffleId: number, userId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM entries
       WHERE raffle_id = ? AND user_id = ? AND removed_at IS NULL`,
    )
    .get(raffleId, userId);
  return row !== undefined;
}

/**
 * The frozen list of active entrant ids for a raffle, sorted ascending. This is
 * the exact ordering hashed and published at close.
 */
export function listEntrants(db: Database, raffleId: number): string[] {
  const rows = db
    .prepare(
      `SELECT user_id FROM entries
       WHERE raffle_id = ? AND removed_at IS NULL
       ORDER BY user_id ASC`,
    )
    .all(raffleId) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}
