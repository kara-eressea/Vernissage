/**
 * Member name cache repository.
 *
 * A small identity cache the bot writes (on a counted message, at raffle entry,
 * and via a startup backfill) so the read-only dashboard can label user ids with
 * real names — the web process has no gateway or token to resolve them itself
 * (design.md "Member name cache"). Only a handle and a server display name are
 * kept, never message content, and every row is scoped per guild.
 */

import type { Database } from "better-sqlite3";

/** A cached name for a member, either field possibly null if unknown. */
export interface MemberName {
  username: string | null;
  displayName: string | null;
}

/** One name to upsert. */
export interface MemberNameUpsert extends MemberName {
  guildId: string;
  userId: string;
  updatedAt: string;
}

/** SQLite caps a statement at 999 bound parameters; stay well under it. */
const IN_CHUNK = 400;

/** Upsert a single member's cached name (last write wins). */
export function upsertMemberName(db: Database, m: MemberNameUpsert): void {
  db.prepare(
    `INSERT INTO members (guild_id, user_id, username, display_name, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       updated_at = excluded.updated_at`,
  ).run(m.guildId, m.userId, m.username, m.displayName, m.updatedAt);
}

/** Upsert many names in one transaction. Returns how many rows were written. */
export function upsertMemberNames(db: Database, members: MemberNameUpsert[]): number {
  if (members.length === 0) {
    return 0;
  }
  const stmt = db.prepare(
    `INSERT INTO members (guild_id, user_id, username, display_name, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       updated_at = excluded.updated_at`,
  );
  const write = db.transaction((items: MemberNameUpsert[]) => {
    for (const m of items) {
      stmt.run(m.guildId, m.userId, m.username, m.displayName, m.updatedAt);
    }
  });
  write(members);
  return members.length;
}

/** One member's cached name, or undefined if it has never been seen. */
export function getMemberName(
  db: Database,
  guildId: string,
  userId: string,
): MemberName | undefined {
  return db
    .prepare(`SELECT username, display_name AS displayName FROM members WHERE guild_id = ? AND user_id = ?`)
    .get(guildId, userId) as MemberName | undefined;
}

/**
 * The cached names for a set of ids in a guild, as a map keyed by user id. Ids
 * with no cached name are simply absent from the map, so callers fall back to
 * showing the id. Chunked so a large entrant list stays under SQLite's bound-
 * parameter limit.
 */
export function getMemberNames(
  db: Database,
  guildId: string,
  userIds: string[],
): Map<string, MemberName> {
  const out = new Map<string, MemberName>();
  const unique = [...new Set(userIds)];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT user_id AS userId, username, display_name AS displayName
           FROM members WHERE guild_id = ? AND user_id IN (${placeholders})`,
      )
      .all(guildId, ...chunk) as Array<MemberName & { userId: string }>;
    for (const r of rows) {
      out.set(r.userId, { username: r.username, displayName: r.displayName });
    }
  }
  return out;
}

/**
 * Entrant and winner ids in a guild's raffles that have no cached name yet — the
 * work list for the startup backfill. A member who has posted a counted message
 * is already named via the message path; this catches those who only ever
 * entered (or won) without a counted message.
 */
export function listUnnamedRaffleMemberIds(db: Database, guildId: string): string[] {
  const rows = db
    .prepare(
      `SELECT user_id FROM (
         SELECT e.user_id AS user_id
           FROM entries e JOIN raffles r ON r.raffle_id = e.raffle_id
          WHERE r.guild_id = ?
         UNION
         SELECT w.user_id AS user_id
           FROM wins w JOIN raffles r ON r.raffle_id = w.raffle_id
          WHERE r.guild_id = ?
       ) ids
       WHERE NOT EXISTS (
         SELECT 1 FROM members m WHERE m.guild_id = ? AND m.user_id = ids.user_id
       )`,
    )
    .all(guildId, guildId, guildId) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}
