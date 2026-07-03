/**
 * Wins repository.
 *
 * Records who won which raffle and when, feeding the win-cooldown check. A win
 * marked `rerolled` was later disqualified and replaced (design.md reroll).
 */

import type { Database } from "better-sqlite3";
import type { WinRecord } from "../../core/types.js";

export interface WinRow {
  win_id: number;
  raffle_id: number;
  user_id: string;
  won_at: string | null;
  rerolled: number;
}

/** Record a win. Returns the generated win_id. */
export function addWin(
  db: Database,
  raffleId: number,
  userId: string,
  wonAt: string,
): number {
  const info = db
    .prepare(
      `INSERT INTO wins (raffle_id, user_id, won_at) VALUES (?, ?, ?)`,
    )
    .run(raffleId, userId, wonAt);
  return Number(info.lastInsertRowid);
}

/** Mark a win as rerolled (the winner was disqualified). */
export function markRerolled(db: Database, winId: number): void {
  db.prepare(`UPDATE wins SET rerolled = 1 WHERE win_id = ?`).run(winId);
}

/**
 * A user's non-rerolled wins, as core WinRecords for the cooldown check.
 * Rerolled wins are excluded — a disqualified win should not gate re-entry.
 */
export function getUserWins(db: Database, userId: string): WinRecord[] {
  const rows = db
    .prepare(
      `SELECT raffle_id, won_at FROM wins
       WHERE user_id = ? AND rerolled = 0 AND won_at IS NOT NULL
       ORDER BY won_at ASC`,
    )
    .all(userId) as Array<{ raffle_id: number; won_at: string }>;
  return rows.map((r) => ({ raffleId: r.raffle_id, wonAt: r.won_at }));
}
