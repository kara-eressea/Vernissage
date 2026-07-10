/**
 * Entry-setting resolution (pure).
 *
 * A raffle's cooldown and minimum-account-age settings fall back to the guild
 * defaults when unset (design.md "Win cooldown": configurable per guild,
 * overridable per raffle). This coalescing lives here so the entry flow and the
 * status display agree on the effective values. No discord.js/database import.
 */

/** The raffle fields that can fall back to a guild default (cooldown only). */
export interface RaffleEntryFields {
  cooldown_days: number | null;
  cooldown_count: number | null;
}

/**
 * The guild defaults consulted at entry time. Account age and server tenure are
 * server-wide policy (no per-raffle override, as of schema v15); the cooldown
 * defaults still fall back only when a raffle leaves them unset.
 */
export interface GuildEntryDefaults {
  default_min_account_age_days: number | null;
  default_min_server_age_days: number | null;
  default_cooldown_days: number | null;
  default_cooldown_count: number | null;
}

export interface ResolvedEntrySettings {
  minAccountAgeDays: number | null;
  minServerAgeDays: number | null;
  cooldownDays: number | null;
  cooldownCount: number | null;
}

/**
 * Resolve a raffle's effective entry settings. Account age and server tenure
 * come straight from the guild defaults; cooldown is per-raffle override ??
 * guild default.
 */
export function resolveEntrySettings(
  raffle: RaffleEntryFields,
  defaults: GuildEntryDefaults,
): ResolvedEntrySettings {
  return {
    minAccountAgeDays: defaults.default_min_account_age_days,
    minServerAgeDays: defaults.default_min_server_age_days,
    cooldownDays: raffle.cooldown_days ?? defaults.default_cooldown_days,
    cooldownCount: raffle.cooldown_count ?? defaults.default_cooldown_count,
  };
}
