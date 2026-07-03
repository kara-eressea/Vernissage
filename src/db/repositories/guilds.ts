/**
 * Guild config repository.
 *
 * Holds per-guild defaults and settings (audit channel, mod role, hourly cap,
 * cooldown/account-age defaults). Rows are created lazily via upsertGuild.
 */

import type { Database } from "better-sqlite3";

export interface GuildRow {
  guild_id: string;
  audit_channel: string | null;
  mod_role: string | null;
  hourly_cap: number | null;
  default_cooldown_days: number | null;
  default_cooldown_count: number | null;
  default_min_account_age_days: number | null;
  created_at: string | null;
}

/** Fetch a guild's config row, or undefined if it has none yet. */
export function getGuild(db: Database, guildId: string): GuildRow | undefined {
  return db
    .prepare(`SELECT * FROM guilds WHERE guild_id = ?`)
    .get(guildId) as GuildRow | undefined;
}

/**
 * The guild's per-user hourly message cap, or null if uncapped / unconfigured.
 * Convenience read for the message counter's hot path.
 */
export function getHourlyCap(db: Database, guildId: string): number | null {
  const row = db
    .prepare(`SELECT hourly_cap FROM guilds WHERE guild_id = ?`)
    .get(guildId) as { hourly_cap: number | null } | undefined;
  return row?.hourly_cap ?? null;
}

/**
 * Create the guild row if absent, or update the provided fields if present.
 * Only fields present in `patch` are written; omitted fields are left as-is.
 */
export function upsertGuild(
  db: Database,
  guildId: string,
  patch: Partial<Omit<GuildRow, "guild_id">> & { created_at: string },
): void {
  db.prepare(
    `INSERT INTO guilds (
       guild_id, audit_channel, mod_role, hourly_cap,
       default_cooldown_days, default_cooldown_count,
       default_min_account_age_days, created_at
     ) VALUES (
       @guild_id, @audit_channel, @mod_role, @hourly_cap,
       @default_cooldown_days, @default_cooldown_count,
       @default_min_account_age_days, @created_at
     )
     ON CONFLICT (guild_id) DO UPDATE SET
       audit_channel = coalesce(excluded.audit_channel, audit_channel),
       mod_role = coalesce(excluded.mod_role, mod_role),
       hourly_cap = coalesce(excluded.hourly_cap, hourly_cap),
       default_cooldown_days = coalesce(excluded.default_cooldown_days, default_cooldown_days),
       default_cooldown_count = coalesce(excluded.default_cooldown_count, default_cooldown_count),
       default_min_account_age_days = coalesce(excluded.default_min_account_age_days, default_min_account_age_days)`,
  ).run({
    guild_id: guildId,
    audit_channel: patch.audit_channel ?? null,
    mod_role: patch.mod_role ?? null,
    hourly_cap: patch.hourly_cap ?? null,
    default_cooldown_days: patch.default_cooldown_days ?? null,
    default_cooldown_count: patch.default_cooldown_count ?? null,
    default_min_account_age_days: patch.default_min_account_age_days ?? null,
    created_at: patch.created_at,
  });
}
