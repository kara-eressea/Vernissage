/**
 * Interaction router.
 *
 * Dispatches an incoming chat-input command to the matching Command, with
 * uniform handling for unknown commands and handler errors so a single bad
 * interaction never crashes the process. The command lookup is a pure function
 * (selectCommand) for easy testing.
 */

import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { commandMap, type Command } from "./commands/index.js";

/** Find the command matching a name, or undefined if none is registered. */
export function selectCommand(
  commandName: string,
  commands: readonly Command[],
): Command | undefined {
  return commandMap(commands).get(commandName);
}

/**
 * Route a chat-input command interaction to its handler. Non-command
 * interactions are ignored. Replies ephemerally on unknown command or error.
 */
export async function routeInteraction(
  interaction: ChatInputCommandInteraction,
  commands: readonly Command[],
): Promise<void> {
  const command = selectCommand(interaction.commandName, commands);

  if (!command) {
    await interaction.reply({
      content: "That command is no longer available.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    const message = {
      content: "Something went wrong handling that command.",
      flags: MessageFlags.Ephemeral,
    } as const;
    // The handler may have already replied or deferred.
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(message);
    } else {
      await interaction.reply(message);
    }
  }
}
