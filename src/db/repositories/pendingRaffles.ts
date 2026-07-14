/**
 * Pending-raffle staging repository.
 *
 * Inert staging for the dashboard's Raffle Designer handoff (design.md "Raffle
 * Designer handoff"). The bot stages a composed-but-unpublished raffle spec here
 * — via its authenticated internal endpoint, so the read-only web tier never
 * writes — keyed by a friendly single-use claim token bound to the staging
 * moderator. A moderator redeems it in-guild with `/raffle from-design <token>`,
 * which re-authorises, re-validates, confirms, and only then creates the real
 * raffle. Nothing here is visible to members, entries, or the draw; unredeemed
 * rows expire and are swept.
 */

import type { Database } from "better-sqlite3";
import type { PendingRaffleSpec } from "../../core/designerSpec.js";

export type { PendingRaffleSpec };

/** A staged pending-raffle row as stored. */
export interface PendingRaffleRow {
  token: string;
  guild_id: string;
  staged_by_user_id: string;
  spec_json: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_raffle_id: number | null;
}

/** The inputs to stage one pending raffle. */
export interface StagePendingRaffle {
  token: string;
  guildId: string;
  stagedByUserId: string;
  spec: PendingRaffleSpec;
  createdAt: string;
  expiresAt: string;
}

/** Insert a staged pending raffle. The token must be unique (it is the PK). */
export function stagePendingRaffle(db: Database, input: StagePendingRaffle): void {
  db.prepare(
    `INSERT INTO pending_raffles
       (token, guild_id, staged_by_user_id, spec_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.token,
    input.guildId,
    input.stagedByUserId,
    JSON.stringify(input.spec),
    input.createdAt,
    input.expiresAt,
  );
}

/** Whether a token is already staged (used to avoid a generation collision). */
export function pendingTokenExists(db: Database, token: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM pending_raffles WHERE token = ?`).get(token) !== undefined
  );
}

/** Fetch a staged pending raffle by its (canonical) token. */
export function getPendingRaffle(db: Database, token: string): PendingRaffleRow | undefined {
  return db.prepare(`SELECT * FROM pending_raffles WHERE token = ?`).get(token) as
    | PendingRaffleRow
    | undefined;
}

/** Parse a row's stored spec back into a `PendingRaffleSpec`. */
export function parsePendingSpec(row: PendingRaffleRow): PendingRaffleSpec {
  return JSON.parse(row.spec_json) as PendingRaffleSpec;
}

/** Mark a pending raffle consumed, recording the raffle it created. */
export function markPendingRedeemed(
  db: Database,
  token: string,
  raffleId: number,
  redeemedAt: string,
): void {
  db.prepare(
    `UPDATE pending_raffles
        SET redeemed_at = ?, redeemed_raffle_id = ?
      WHERE token = ?`,
  ).run(redeemedAt, raffleId, token);
}

/** Delete pending rows whose expiry has passed. Returns how many were removed. */
export function sweepExpiredPendingRaffles(db: Database, nowIso: string): number {
  return db.prepare(`DELETE FROM pending_raffles WHERE expires_at < ?`).run(nowIso).changes;
}
