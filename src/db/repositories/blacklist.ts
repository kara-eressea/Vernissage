/**
 * Blacklist repository.
 *
 * One row per (guild, user). A ban may carry a reason (mod-only) and an
 * optional expiry (null = permanent). Expiry is resolved at read time against
 * the current instant.
 */

import type { Database } from "better-sqlite3";

export interface BlacklistRow {
  guild_id: string;
  user_id: string;
  banned_by: string | null;
  reason: string | null;
  banned_at: string | null;
  expires_at: string | null;
}

/** Add or replace a blacklist entry for a user. */
export function addBan(
  db: Database,
  entry: {
    guildId: string;
    userId: string;
    bannedBy: string;
    reason: string | null;
    bannedAt: string;
    expiresAt: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO blacklist (guild_id, user_id, banned_by, reason, banned_at, expires_at)
     VALUES (@guildId, @userId, @bannedBy, @reason, @bannedAt, @expiresAt)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       banned_by = excluded.banned_by,
       reason = excluded.reason,
       banned_at = excluded.banned_at,
       expires_at = excluded.expires_at`,
  ).run(entry);
}

/** Remove a user's blacklist entry, if any. */
export function removeBan(db: Database, guildId: string, userId: string): void {
  db.prepare(`DELETE FROM blacklist WHERE guild_id = ? AND user_id = ?`).run(
    guildId,
    userId,
  );
}

/**
 * Whether the user is currently blacklisted in the guild at time `now`.
 * A null expiry is permanent; an expiry at or before `now` no longer bans.
 */
export function isBlacklisted(
  db: Database,
  guildId: string,
  userId: string,
  now: string,
): boolean {
  const row = db
    .prepare(
      `SELECT expires_at FROM blacklist WHERE guild_id = ? AND user_id = ?`,
    )
    .get(guildId, userId) as { expires_at: string | null } | undefined;
  if (row === undefined) {
    return false;
  }
  if (row.expires_at === null) {
    return true;
  }
  return Date.parse(row.expires_at) > Date.parse(now);
}

/** All current bans for a guild (including expired rows not yet pruned). */
export function listBans(db: Database, guildId: string): BlacklistRow[] {
  return db
    .prepare(`SELECT * FROM blacklist WHERE guild_id = ? ORDER BY banned_at ASC`)
    .all(guildId) as BlacklistRow[];
}
