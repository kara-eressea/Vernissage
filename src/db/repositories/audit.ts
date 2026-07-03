/**
 * Audit log repository.
 *
 * Every state change (raffle, entry, blacklist) writes an audit_log row (see
 * CLAUDE.md). Payload is a JSON blob of event-specific detail; private data
 * such as blacklist reasons stays out of anything later published.
 */

import type { Database } from "better-sqlite3";

export interface AuditEvent {
  guildId: string | null;
  raffleId: number | null;
  eventType: string;
  actorId: string | null;
  /** Arbitrary event detail, serialized to JSON. */
  payload?: unknown;
  /** UTC ISO timestamp. */
  createdAt: string;
}

export interface AuditRow {
  event_id: number;
  guild_id: string | null;
  raffle_id: number | null;
  event_type: string;
  actor_id: string | null;
  payload: string | null;
  created_at: string;
}

/** Append an audit event. Returns the generated event_id. */
export function writeAudit(db: Database, event: AuditEvent): number {
  const info = db
    .prepare(
      `INSERT INTO audit_log
         (guild_id, raffle_id, event_type, actor_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.guildId,
      event.raffleId,
      event.eventType,
      event.actorId,
      event.payload === undefined ? null : JSON.stringify(event.payload),
      event.createdAt,
    );
  return Number(info.lastInsertRowid);
}

/** All audit rows for a raffle, oldest first. */
export function getAuditForRaffle(db: Database, raffleId: number): AuditRow[] {
  return db
    .prepare(
      `SELECT * FROM audit_log WHERE raffle_id = ? ORDER BY event_id ASC`,
    )
    .all(raffleId) as AuditRow[];
}
