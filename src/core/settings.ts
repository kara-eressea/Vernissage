/**
 * Entry-setting resolution (pure).
 *
 * A raffle's cooldown and minimum-account-age settings fall back to the guild
 * defaults when unset (design.md "Win cooldown": configurable per guild,
 * overridable per raffle). This coalescing lives here so the entry flow and the
 * status display agree on the effective values. No discord.js/database import.
 */

/** The raffle fields that can fall back to a guild default. */
export interface RaffleEntryFields {
  min_account_age_days: number | null;
  cooldown_days: number | null;
  cooldown_count: number | null;
}

/** The guild defaults consulted when a raffle leaves a field unset. */
export interface GuildEntryDefaults {
  default_min_account_age_days: number | null;
  default_cooldown_days: number | null;
  default_cooldown_count: number | null;
}

export interface ResolvedEntrySettings {
  minAccountAgeDays: number | null;
  cooldownDays: number | null;
  cooldownCount: number | null;
}

/** Resolve a raffle's effective entry settings: per-raffle override ?? guild default. */
export function resolveEntrySettings(
  raffle: RaffleEntryFields,
  defaults: GuildEntryDefaults,
): ResolvedEntrySettings {
  return {
    minAccountAgeDays: raffle.min_account_age_days ?? defaults.default_min_account_age_days,
    cooldownDays: raffle.cooldown_days ?? defaults.default_cooldown_days,
    cooldownCount: raffle.cooldown_count ?? defaults.default_cooldown_count,
  };
}
