/**
 * Slash command registration.
 *
 * Registers commands as guild commands in every allowlisted guild. Guild
 * commands update instantly (unlike global commands, which propagate slowly),
 * which suits a private bot. Run via the deploy-commands script whenever the
 * command set changes.
 */

import { REST, Routes } from "discord.js";
import type { BotConfig } from "../config.js";
import type { Command } from "./commands/index.js";

/**
 * Register the given commands to every allowlisted guild. Returns the number of
 * commands registered per guild (the same set is registered in each).
 */
export async function registerCommands(
  config: BotConfig,
  commands: readonly Command[],
): Promise<number> {
  const rest = new REST().setToken(config.token);
  const body = commands.map((command) => command.data.toJSON());

  await Promise.all(
    config.guildIds.map((guildId) =>
      rest.put(Routes.applicationGuildCommands(config.appId, guildId), { body }),
    ),
  );

  return body.length;
}
