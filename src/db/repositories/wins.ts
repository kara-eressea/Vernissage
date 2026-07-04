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
  claim_deadline: string | null;
  claimed_at: string | null;
}

/**
 * Record a win. Returns the generated win_id. `claimDeadline` is set when the
 * raffle has a claim window (the winner must claim before it); pass null when no
 * claim is required (design.md "Winner claim window").
 */
export function addWin(
  db: Database,
  raffleId: number,
  userId: string,
  wonAt: string,
  claimDeadline: string | null = null,
): number {
  const info = db
    .prepare(
      `INSERT INTO wins (raffle_id, user_id, won_at, claim_deadline) VALUES (?, ?, ?, ?)`,
    )
    .run(raffleId, userId, wonAt, claimDeadline);
  return Number(info.lastInsertRowid);
}

/**
 * Mark a winner's prize as claimed, but only if the win is still live and
 * unclaimed. Returns whether it was recorded (false if already claimed, already
 * rerolled, or the id is unknown) — the atomic guard against a double-claim race.
 */
export function claimWin(db: Database, winId: number, claimedAt: string): boolean {
  const info = db
    .prepare(
      `UPDATE wins SET claimed_at = ?
       WHERE win_id = ? AND claimed_at IS NULL AND rerolled = 0`,
    )
    .run(claimedAt, winId);
  return info.changes > 0;
}

/**
 * A user's current (non-rerolled) win in a raffle, claimed or not, or undefined.
 * The claim path reads this to tell "not a winner" from "already claimed".
 */
export function getActiveWinForUser(
  db: Database,
  raffleId: number,
  userId: string,
): WinRow | undefined {
  return db
    .prepare(
      `SELECT * FROM wins
       WHERE raffle_id = ? AND user_id = ? AND rerolled = 0
       ORDER BY win_id ASC LIMIT 1`,
    )
    .get(raffleId, userId) as WinRow | undefined;
}

/**
 * Wins whose claim deadline has passed with no claim recorded, across all
 * guilds, on raffles still `drawn`. These are the slots the scheduler sweep
 * rerolls to the next eligible entrant (design.md "Winner claim window").
 */
export function listExpiredUnclaimedWins(db: Database, nowIso: string): WinRow[] {
  return db
    .prepare(
      `SELECT w.* FROM wins w
       JOIN raffles r ON r.raffle_id = w.raffle_id
       WHERE r.status = 'drawn'
         AND w.rerolled = 0
         AND w.claimed_at IS NULL
         AND w.claim_deadline IS NOT NULL
         AND w.claim_deadline <= ?
       ORDER BY w.win_id ASC`,
    )
    .all(nowIso) as WinRow[];
}

/** Mark a win as rerolled (the winner was disqualified). */
export function markRerolled(db: Database, winId: number): void {
  db.prepare(`UPDATE wins SET rerolled = 1 WHERE win_id = ?`).run(winId);
}

/** Fetch a single win row by id, or undefined if it does not exist. */
export function getWin(db: Database, winId: number): WinRow | undefined {
  return db.prepare(`SELECT * FROM wins WHERE win_id = ?`).get(winId) as
    | WinRow
    | undefined;
}

/** All win rows for a raffle (including rerolled), oldest first. */
export function listWinsForRaffle(db: Database, raffleId: number): WinRow[] {
  return db
    .prepare(`SELECT * FROM wins WHERE raffle_id = ? ORDER BY win_id ASC`)
    .all(raffleId) as WinRow[];
}

/**
 * The current (non-rerolled) winner ids for a raffle, oldest first. These are
 * the survivors a reroll re-selection must preserve; the newly-selected ids not
 * already here are the replacements.
 */
export function activeWinnerIds(db: Database, raffleId: number): string[] {
  const rows = db
    .prepare(
      `SELECT user_id FROM wins WHERE raffle_id = ? AND rerolled = 0 ORDER BY win_id ASC`,
    )
    .all(raffleId) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}

/**
 * A user's non-rerolled wins in a guild, as core WinRecords for the cooldown
 * check. Rerolled wins are excluded — a disqualified win should not gate
 * re-entry. Scoped to the guild by joining through the win's raffle, so a win in
 * one server never gates entry in another (the count-based mode is likewise
 * scoped via countRafflesSince).
 */
export function getUserWins(db: Database, guildId: string, userId: string): WinRecord[] {
  const rows = db
    .prepare(
      `SELECT w.raffle_id, w.won_at FROM wins w
       JOIN raffles r ON r.raffle_id = w.raffle_id
       WHERE w.user_id = ? AND r.guild_id = ? AND w.rerolled = 0 AND w.won_at IS NOT NULL
       ORDER BY w.won_at ASC`,
    )
    .all(userId, guildId) as Array<{ raffle_id: number; won_at: string }>;
  return rows.map((r) => ({ raffleId: r.raffle_id, wonAt: r.won_at }));
}
