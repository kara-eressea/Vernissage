/**
 * Displayed-name resolution.
 *
 * Per docs/dashboard.md "The displayed name follows the bot, per guild": the
 * chrome never hardcodes a product name. Guild-less screens (login, guild
 * picker) name no bot at all — just "Moderator Dashboard" — which also keeps the
 * "Vernissage" codename off every surface. Inside a guild, the name should be
 * the bot's nickname on that guild.
 *
 * The isolated Tier-1 web process has no gateway connection, so it cannot read
 * `guild.members.me.nickname` directly. Until the bot persists its per-guild
 * nickname for the dashboard to read (a small follow-up), the in-guild name
 * falls back to "Tombola" — the established user-facing name (see CLAUDE.md),
 * never the codename. `botNickname` is the seam that follow-up plugs into.
 */

const GUILDLESS_NAME = "Moderator Dashboard";
const DEFAULT_BOT_NAME = "Tombola";

/**
 * Resolve the name shown in the chrome. Pass null (or no guild) for guild-less
 * screens. Inside a guild, pass the stored bot nickname if one is known.
 */
export function resolveDisplayName(guild?: { botNickname?: string | null } | null): string {
  if (!guild) {
    return GUILDLESS_NAME;
  }
  return guild.botNickname?.trim() || DEFAULT_BOT_NAME;
}

export { GUILDLESS_NAME, DEFAULT_BOT_NAME };
