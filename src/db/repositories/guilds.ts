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

/** The settable guild-config columns (everything except the id and created_at). */
export type GuildConfigPatch = Partial<
  Omit<GuildRow, "guild_id" | "created_at">
>;

/**
 * Apply a config patch to a guild, creating the row on first write.
 *
 * Unlike `upsertGuild`, this distinguishes "leave as-is" from "clear": a key
 * absent from `patch` is untouched, while a key present with a `null` value is
 * written as NULL. That is exactly what `/raffle config` needs — the coalescing
 * `upsertGuild` can never clear a previously-set field. `created_at` is set once
 * on the initial insert and never overwritten.
 */
export function setGuildConfig(
  db: Database,
  guildId: string,
  patch: GuildConfigPatch,
  now: string,
): void {
  // Ensure the row exists so the UPDATE below has something to write. Only the
  // very first insert stamps created_at; later calls leave it untouched.
  db.prepare(
    `INSERT INTO guilds (guild_id, created_at) VALUES (?, ?)
     ON CONFLICT (guild_id) DO NOTHING`,
  ).run(guildId, now);

  // Only keys explicitly present (value !== undefined) are written; a null
  // value clears the column. Keys come from GuildConfigPatch, so the column
  // names interpolated here are code-controlled, never user input.
  const keys = (Object.keys(patch) as (keyof GuildConfigPatch)[]).filter(
    (key) => patch[key] !== undefined,
  );
  if (keys.length === 0) {
    return;
  }

  const assignments = keys.map((key) => `${key} = @${key}`).join(", ");
  const params: Record<string, string | number | null> = { guild_id: guildId };
  for (const key of keys) {
    params[key] = patch[key] ?? null;
  }

  db.prepare(`UPDATE guilds SET ${assignments} WHERE guild_id = @guild_id`).run(
    params,
  );
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
