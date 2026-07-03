/**
 * The single top-level `/raffle` command.
 *
 * All raffle functionality hangs off one command as subcommand groups, so the
 * bot registers exactly one command. This module owns the shell and dispatches
 * to the right group handler; each feature area (config here; create/enter/
 * draw/ban in later issues) contributes its own subcommand group and handler.
 *
 * A coarse Discord-side gate (`ManageGuild`) hides the command from ordinary
 * members; the authoritative, mod-role-aware check lives in each handler via
 * the pure `isModerator` gate.
 */

import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { CommandContext } from "../index.js";
import type { Command } from "../types.js";
import { addConfigGroup, handleConfig } from "./config.js";

/** Build the `/raffle` command, wiring every subcommand group to `ctx`. */
export function buildRaffleCommand(ctx: CommandContext): Command {
  const data = new SlashCommandBuilder()
    .setName("raffle")
    .setDescription("Run and manage raffles.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup(addConfigGroup);
  // Later issues: `.addSubcommandGroup(addCreateGroup)`, etc.

  return {
    data,
    execute: (interaction) => dispatch(interaction, ctx),
  };
}

/** Route a `/raffle` invocation to the handler for its subcommand group. */
async function dispatch(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  switch (interaction.options.getSubcommandGroup(false)) {
    case "config":
      await handleConfig(interaction, ctx);
      return;
    default:
      await interaction.reply({
        content: "That subcommand is not available.",
        flags: MessageFlags.Ephemeral,
      });
  }
}
