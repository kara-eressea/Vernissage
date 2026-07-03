/**
 * Raffle repository.
 *
 * CRUD for raffles plus the status-scoped lookups the scheduler and commands
 * need. Column-level detail mirrors design.md "Data model".
 */

import type { Database } from "better-sqlite3";
import type { RaffleStatus } from "../../core/types.js";

export interface RaffleRow {
  raffle_id: number;
  guild_id: string;
  name: string | null;
  description: string | null;
  prize: string | null;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  winner_count: number;
  req_messages: number | null;
  req_days: number | null;
  window_anchor: string;
  new_member_exempt: number;
  new_member_days: number | null;
  min_account_age_days: number | null;
  cooldown_days: number | null;
  cooldown_count: number | null;
  draw_mode: string | null;
  message_id: string | null;
  entrants_hash: string | null;
  drand_round: number | null;
  created_by: string | null;
  created_at: string | null;
}

/** Create a draft raffle (the wizard's step 1). Returns the new raffle_id. */
export function createDraft(
  db: Database,
  guildId: string,
  createdBy: string,
  createdAt: string,
): number {
  const info = db
    .prepare(
      `INSERT INTO raffles (guild_id, status, created_by, created_at)
       VALUES (?, 'draft', ?, ?)`,
    )
    .run(guildId, createdBy, createdAt);
  return Number(info.lastInsertRowid);
}

/** Fetch a raffle by id, or undefined if it does not exist. */
export function getRaffle(db: Database, raffleId: number): RaffleRow | undefined {
  return db
    .prepare(`SELECT * FROM raffles WHERE raffle_id = ?`)
    .get(raffleId) as RaffleRow | undefined;
}

/** Update a raffle's status. */
export function setStatus(
  db: Database,
  raffleId: number,
  status: RaffleStatus,
): void {
  db.prepare(`UPDATE raffles SET status = ? WHERE raffle_id = ?`).run(
    status,
    raffleId,
  );
}

/** Store the frozen entrant hash committed at close. */
export function setEntrantsHash(
  db: Database,
  raffleId: number,
  entrantsHash: string,
): void {
  db.prepare(`UPDATE raffles SET entrants_hash = ? WHERE raffle_id = ?`).run(
    entrantsHash,
    raffleId,
  );
}

/**
 * Raffles in the given statuses for a guild. Used by the scheduler to find
 * transition candidates and by /raffle list.
 */
export function listByStatus(
  db: Database,
  guildId: string,
  statuses: RaffleStatus[],
): RaffleRow[] {
  if (statuses.length === 0) {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT * FROM raffles
       WHERE guild_id = ? AND status IN (${placeholders})
       ORDER BY starts_at ASC`,
    )
    .all(guildId, ...statuses) as RaffleRow[];
}
