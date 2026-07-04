/**
 * Guild allowlist enforcement.
 *
 * Vernissage is a private bot: it operates only in the guilds on its configured
 * allowlist (one or more; see config.ts). On startup and whenever it is added to
 * a guild, it leaves any guild not on the list (design.md "Technical stack":
 * Public Bot disabled, leave non-allowlisted guilds).
 *
 * The decision itself is a pure function so it can be unit-tested; the wiring
 * that actually calls guild.leave() lives in attachGuildAllowlist.
 */

import { Events, type Client, type Guild } from "discord.js";

/** Whether the bot should leave `guildId`, given the allowed guild ids. */
export function shouldLeaveGuild(
  guildId: string,
  allowedGuildIds: ReadonlySet<string>,
): boolean {
  return !allowedGuildIds.has(guildId);
}

/**
 * Attach listeners so the bot leaves any guild not on the allowlist, whether it
 * is already in it at startup or is added to it later. Idempotent per client.
 * Leaving is best-effort; failures are logged, not thrown, so one stubborn guild
 * cannot crash startup.
 */
export function attachGuildAllowlist(
  client: Client,
  allowedGuildIds: readonly string[],
): void {
  const allowed = new Set(allowedGuildIds);

  const leaveIfForeign = async (guild: Guild): Promise<void> => {
    if (!shouldLeaveGuild(guild.id, allowed)) {
      return;
    }
    try {
      await guild.leave();
      console.warn(`Left guild ${guild.id} (${guild.name}); it is not on the allowlist.`);
    } catch (err) {
      console.error(`Failed to leave non-allowlisted guild ${guild.id}:`, err);
    }
  };

  // Sweep existing guilds once the client is ready.
  client.once(Events.ClientReady, (ready) => {
    for (const guild of ready.guilds.cache.values()) {
      void leaveIfForeign(guild);
    }
  });

  // And leave immediately if added to a foreign guild later.
  client.on(Events.GuildCreate, (guild) => {
    void leaveIfForeign(guild);
  });
}
