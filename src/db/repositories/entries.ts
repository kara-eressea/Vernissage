/**
 * Entry repository.
 *
 * One row per (raffle, user); the primary key enforces the "one entry per user"
 * rule. Removals are soft (removed_at/removed_reason set) so the audit trail and
 * frozen entrant list stay reconstructable.
 */

import type { Database } from "better-sqlite3";

/**
 * Record an entry. A previously removed row (withdrawal, or a lifted ban) is
 * reinstated in place — re-entry runs the full eligibility gauntlet first, so
 * reinstating is safe regardless of why the entry was removed. Throws if the
 * user already holds an *active* entry (callers check eligibility first; the
 * throw is the guard against a concurrent double-entry race).
 */
export function addEntry(
  db: Database,
  raffleId: number,
  userId: string,
  enteredAt: string,
): void {
  const info = db
    .prepare(
      `INSERT INTO entries (raffle_id, user_id, entered_at)
       VALUES (?, ?, ?)
       ON CONFLICT (raffle_id, user_id) DO UPDATE
         SET entered_at = excluded.entered_at, removed_at = NULL, removed_reason = NULL
         WHERE entries.removed_at IS NOT NULL`,
    )
    .run(raffleId, userId, enteredAt);
  if (info.changes === 0) {
    throw new Error(`User ${userId} already has an active entry in raffle ${raffleId}`);
  }
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

/** How many active (not removed) entries a raffle currently has. */
export function countActiveEntries(db: Database, raffleId: number): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM entries
       WHERE raffle_id = ? AND removed_at IS NULL`,
    )
    .get(raffleId) as { n: number };
  return row.n;
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
