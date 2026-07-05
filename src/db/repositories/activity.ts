/**
 * Activity bucket repository.
 *
 * Stores per-user, per-UTC-day message counts and reads them back over a
 * window. Only counts are stored, never content. Old rows are pruned once they
 * fall outside the longest lookback window in use.
 */

import type { Database } from "better-sqlite3";
import type { DailyCount } from "../../core/types.js";

/**
 * Add `by` messages to a user's bucket for `day`, creating the row if needed.
 * Uses an UPSERT so concurrent flushes accumulate rather than overwrite.
 */
export function incrementActivity(
  db: Database,
  guildId: string,
  userId: string,
  day: string,
  by: number,
): void {
  db.prepare(
    `INSERT INTO activity (guild_id, user_id, day, count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id, day)
     DO UPDATE SET count = count + excluded.count`,
  ).run(guildId, userId, day, by);
}

/**
 * A user's daily counts within an inclusive UTC-day range, ascending by day.
 */
export function getCountsInWindow(
  db: Database,
  guildId: string,
  userId: string,
  startDay: string,
  endDay: string,
): DailyCount[] {
  return db
    .prepare(
      `SELECT day, count FROM activity
       WHERE guild_id = ? AND user_id = ? AND day >= ? AND day <= ?
       ORDER BY day ASC`,
    )
    .all(guildId, userId, startDay, endDay) as DailyCount[];
}

/**
 * Delete all activity rows for days strictly before `cutoffDay`. Returns the
 * number of rows removed.
 */
export function pruneActivityBefore(db: Database, cutoffDay: string): number {
  const info = db.prepare(`DELETE FROM activity WHERE day < ?`).run(cutoffDay);
  return info.changes;
}

/**
 * Delete a single member's counted-activity rows in a guild (the `/raffle reset`
 * activity scope). Returns the number of daily buckets removed. Scoped to the
 * one user and guild, so no one else's counts are touched. Any counts still
 * buffered in memory must be dropped separately via MessageCounter.forgetUser,
 * or the next flush would re-create rows (design.md "Resetting eligibility").
 */
export function deleteUserActivity(db: Database, guildId: string, userId: string): number {
  const info = db
    .prepare(`DELETE FROM activity WHERE guild_id = ? AND user_id = ?`)
    .run(guildId, userId);
  return info.changes;
}
