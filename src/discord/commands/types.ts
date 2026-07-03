/**
 * Slash command contract.
 *
 * Every command exposes its builder data (for registration) and an execute
 * handler (for dispatch). Handlers stay thin: they parse the interaction, call
 * core functions, and format the reply — no business logic lives here (see
 * CLAUDE.md conventions).
 */

import type {
  ChatInputCommandInteraction,
  RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";

export interface Command {
  /** Command builder data; must expose its name and serialize for the API. */
  data: {
    name: string;
    toJSON(): RESTPostAPIApplicationCommandsJSONBody;
  };
  /** Handle an invocation of this command. */
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}
