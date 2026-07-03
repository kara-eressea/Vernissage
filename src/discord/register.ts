/**
 * Slash command registration.
 *
 * Registers commands as guild commands for the single home guild. Guild
 * commands update instantly (unlike global commands, which propagate slowly),
 * which suits a private single-guild bot. Run via the deploy-commands script
 * whenever the command set changes.
 */

import { REST, Routes } from "discord.js";
import type { BotConfig } from "../config.js";
import type { Command } from "./commands/index.js";

/**
 * Register the given commands to the home guild. Returns the number registered.
 */
export async function registerCommands(
  config: BotConfig,
  commands: readonly Command[],
): Promise<number> {
  const rest = new REST().setToken(config.token);
  const body = commands.map((command) => command.data.toJSON());

  await rest.put(
    Routes.applicationGuildCommands(config.appId, config.homeGuildId),
    { body },
  );

  return body.length;
}
