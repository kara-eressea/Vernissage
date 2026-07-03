/**
 * Ban-driven entry removal (DB orchestration, no discord.js).
 *
 * When a user is banned, any active entry they hold in an *open* raffle is
 * soft-removed and the removal is audit-logged (design.md "Blacklist": "Banning
 * a user with an active entry in an open raffle removes that entry ... logged to
 * the audit channel with a timestamp"). The whole sweep runs in one transaction,
 * mirroring src/scheduler/transitions.ts.
 *
 * Privacy: the mod's free-text ban reason never reaches here. The entry's
 * `removed_reason` stores only a category ("blacklisted"), and the audit payload
 * carries only the affected user id — the audit-channel line shows that a
 * removal happened, not why.
 */

import type { Database } from "better-sqlite3";
import { AUDIT_EVENTS } from "../core/auditEvents.js";
import { writeAudit } from "../db/repositories/audit.js";
import { hasEntry, removeEntry } from "../db/repositories/entries.js";
import { listByStatus } from "../db/repositories/raffles.js";

/**
 * Soft-remove the user's active entries from the guild's open raffles, writing
 * an `entry_removed` audit row per removal. Returns the affected raffle ids so
 * the Discord layer can mirror each removal to the audit channel. A user with no
 * active open-raffle entry produces no writes and returns `[]`.
 */
export function removeEntriesForBan(
  db: Database,
  guildId: string,
  userId: string,
  removedAt: string,
  actorId: string | null = null,
  category = "blacklisted",
): number[] {
  const affected: number[] = [];

  const sweep = db.transaction(() => {
    for (const raffle of listByStatus(db, guildId, ["open"])) {
      if (!hasEntry(db, raffle.raffle_id, userId)) {
        continue;
      }
      removeEntry(db, raffle.raffle_id, userId, removedAt, category);
      writeAudit(db, {
        guildId,
        raffleId: raffle.raffle_id,
        eventType: AUDIT_EVENTS.entryRemoved,
        actorId,
        payload: { userId },
        createdAt: removedAt,
      });
      affected.push(raffle.raffle_id);
    }
  });
  sweep();

  return affected;
}
