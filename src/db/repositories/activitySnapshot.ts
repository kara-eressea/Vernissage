/**
 * Frozen activity measurements, one set per raffle.
 *
 * Eligibility locks when a raffle opens: what a member *did* is measured once, at
 * the instant the doors open, and never re-measured. Messages sent afterwards
 * cannot create eligibility — not even later the same UTC day, which the
 * day-resolution window would otherwise allow (design.md "Entry flow").
 *
 * Only the activity half is frozen. Blacklist, role gates, and server tenure stay
 * live at entry time, so a member banned mid-raffle loses their entry rights and
 * one who gains a required role gains them.
 */

import type { Database } from "better-sqlite3";

/** One member's frozen measurement for a raffle. */
export interface FrozenActivity {
  messages: number;
  activeDays: number;
}

/** A row to freeze, as the transition assembles it. */
export interface ActivitySnapshotRow extends FrozenActivity {
  userId: string;
}

/**
 * Freeze a raffle's activity measurement and stamp when it was taken. Replaces
 * any existing rows, so a re-freeze (an activity reset while the raffle is open)
 * is idempotent. Call inside the caller's transaction.
 */
export function writeActivitySnapshot(
  db: Database,
  raffleId: number,
  rows: readonly ActivitySnapshotRow[],
  capturedAt: string,
): void {
  db.prepare(`DELETE FROM raffle_activity_snapshot WHERE raffle_id = ?`).run(raffleId);
  const insert = db.prepare(
    `INSERT INTO raffle_activity_snapshot (raffle_id, user_id, messages, active_days)
     VALUES (?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(raffleId, row.userId, row.messages, row.activeDays);
  }
  db.prepare(`UPDATE raffles SET activity_snapshot_at = ? WHERE raffle_id = ?`).run(
    capturedAt,
    raffleId,
  );
}

/**
 * One member's frozen measurement, or undefined when the raffle has no snapshot
 * (opened before this existed) — the caller then measures live, as before.
 *
 * A member absent from a snapshot that *does* exist had no counted activity in
 * the window, which is a zero measurement rather than a missing one; callers
 * distinguish the two via `hasActivitySnapshot`.
 */
export function getFrozenActivity(
  db: Database,
  raffleId: number,
  userId: string,
): FrozenActivity | undefined {
  const row = db
    .prepare(
      `SELECT messages, active_days FROM raffle_activity_snapshot
       WHERE raffle_id = ? AND user_id = ?`,
    )
    .get(raffleId, userId) as { messages: number; active_days: number } | undefined;
  return row ? { messages: row.messages, activeDays: row.active_days } : undefined;
}

/** Whether this raffle's activity measurement has been frozen. */
export function hasActivitySnapshot(db: Database, raffleId: number): boolean {
  const row = db
    .prepare(`SELECT activity_snapshot_at FROM raffles WHERE raffle_id = ?`)
    .get(raffleId) as { activity_snapshot_at: string | null } | undefined;
  return Boolean(row?.activity_snapshot_at);
}

/** Every frozen row for a raffle, for the moderator report. */
export function listActivitySnapshot(db: Database, raffleId: number): ActivitySnapshotRow[] {
  const rows = db
    .prepare(
      `SELECT user_id, messages, active_days FROM raffle_activity_snapshot
       WHERE raffle_id = ? ORDER BY user_id ASC`,
    )
    .all(raffleId) as Array<{ user_id: string; messages: number; active_days: number }>;
  return rows.map((r) => ({ userId: r.user_id, messages: r.messages, activeDays: r.active_days }));
}

/** The open raffles in a guild whose measurement is already frozen. */
export function openSnapshotRaffleIds(db: Database, guildId: string): number[] {
  const rows = db
    .prepare(
      `SELECT raffle_id FROM raffles
       WHERE guild_id = ? AND status = 'open' AND activity_snapshot_at IS NOT NULL`,
    )
    .all(guildId) as Array<{ raffle_id: number }>;
  return rows.map((r) => r.raffle_id);
}

/**
 * Re-freeze one member's row in a raffle from a freshly measured value, leaving
 * everyone else's untouched. This is what `/raffle reset <user> activity` needs:
 * deleting a member's counted history must still take effect on a raffle that is
 * already open, or the moderator tool would silently do nothing there.
 */
export function refreshMemberSnapshot(
  db: Database,
  raffleId: number,
  userId: string,
  measured: FrozenActivity,
): void {
  if (measured.messages <= 0 && measured.activeDays <= 0) {
    db.prepare(
      `DELETE FROM raffle_activity_snapshot WHERE raffle_id = ? AND user_id = ?`,
    ).run(raffleId, userId);
    return;
  }
  db.prepare(
    `INSERT INTO raffle_activity_snapshot (raffle_id, user_id, messages, active_days)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (raffle_id, user_id) DO UPDATE SET
       messages = excluded.messages,
       active_days = excluded.active_days`,
  ).run(raffleId, userId, measured.messages, measured.activeDays);
}
