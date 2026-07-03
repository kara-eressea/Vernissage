/**
 * Home-guild enforcement.
 *
 * Vernissage is a private, single-guild bot. On startup and whenever it is
 * added to a guild, it leaves any guild that is not the configured home guild
 * (see design.md "Technical stack": Public Bot disabled, leave non-home guilds).
 *
 * The decision itself is a pure function so it can be unit-tested; the wiring
 * that actually calls guild.leave() lives in attachHomeGuildEnforcement.
 */

import { Events, type Client, type Guild } from "discord.js";

/** Whether the bot should leave `guildId`, given the configured home guild. */
export function shouldLeaveGuild(guildId: string, homeGuildId: string): boolean {
  return guildId !== homeGuildId;
}

/**
 * Attach listeners so the bot leaves any non-home guild it is in or is added
 * to. Idempotent per client. Leaving is best-effort; failures are logged, not
 * thrown, so one stubborn guild cannot crash startup.
 */
export function attachHomeGuildEnforcement(
  client: Client,
  homeGuildId: string,
): void {
  const leaveIfForeign = async (guild: Guild): Promise<void> => {
    if (!shouldLeaveGuild(guild.id, homeGuildId)) {
      return;
    }
    try {
      await guild.leave();
      console.warn(
        `Left non-home guild ${guild.id} (${guild.name}); home is ${homeGuildId}.`,
      );
    } catch (err) {
      console.error(`Failed to leave non-home guild ${guild.id}:`, err);
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
