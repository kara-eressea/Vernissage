/**
 * Guild config repository.
 *
 * Holds per-guild defaults and settings (audit channel, mod role, hourly cap,
 * cooldown/account-age defaults). Rows are created lazily on first write via
 * setGuildConfig.
 */

import type { Database } from "better-sqlite3";
import { applyColumnPatch } from "../patch.js";

export interface GuildRow {
  guild_id: string;
  audit_channel: string | null;
  announce_channel: string | null;
  mod_role: string | null;
  hourly_cap: number | null;
  default_cooldown_days: number | null;
  default_cooldown_count: number | null;
  default_min_account_age_days: number | null;
  default_req_messages: number | null;
  default_req_days: number | null;
  timezone: string | null;
  blacklist_generic_message: number;
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
 * Runtime allowlist of columns `setGuildConfig` may write. The TS type above is
 * erased at runtime, so this Set is the actual guard `applyColumnPatch` uses
 * against a stray key being interpolated into the UPDATE's column list.
 */
export const SETTABLE_COLUMNS: ReadonlySet<string> = new Set<keyof GuildConfigPatch>([
  "audit_channel",
  "announce_channel",
  "mod_role",
  "hourly_cap",
  "default_cooldown_days",
  "default_cooldown_count",
  "default_min_account_age_days",
  "default_req_messages",
  "default_req_days",
  "timezone",
  "blacklist_generic_message",
]);

/**
 * Apply a config patch to a guild, creating the row on first write.
 *
 * This distinguishes "leave as-is" from "clear": a key absent from `patch` is
 * untouched, while a key present with a `null` value is written as NULL. That is
 * exactly what `/raffle config` needs. `created_at` is set once on the initial
 * insert and never overwritten.
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

  applyColumnPatch(db, "guilds", "guild_id", guildId, patch, SETTABLE_COLUMNS);
}
