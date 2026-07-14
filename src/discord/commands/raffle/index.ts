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
import { addBanSubcommands, handleBan, handleBanlist, handleUnban } from "./blacklist.js";
import { addConfigGroup, handleConfig } from "./config.js";
import { addDrawSubcommands, handleAnnounce, handleDraw, handleReroll } from "./draw.js";
import { addEligibleSubcommand, handleEligible } from "./eligible.js";
import {
  addEntrySubcommands,
  handleClaim,
  handleEnter,
  handleWithdraw,
  handleList,
  handleStatus,
} from "./entry.js";
import { addManageSubcommands, handleCancel, handleCreate, handleEdit } from "./manage.js";
import { addResetSubcommand, handleReset } from "./reset.js";

/** Build the `/raffle` command, wiring every subcommand (group) to `ctx`. */
export function buildRaffleCommand(ctx: CommandContext): Command {
  const data = new SlashCommandBuilder()
    .setName("raffle")
    .setDescription("Run and manage raffles.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  // Top-level subcommands (create/edit/cancel) added while `data` is still a
  // full SlashCommandBuilder, then the config subcommand group.
  addManageSubcommands(data);
  addEntrySubcommands(data);
  addDrawSubcommands(data);
  addBanSubcommands(data);
  addResetSubcommand(data);
  addEligibleSubcommand(data);
  data.addSubcommandGroup(addConfigGroup);

  return {
    data,
    execute: (interaction) => dispatch(interaction, ctx),
  };
}

/** Route a `/raffle` invocation to the handler for its subcommand (group). */
async function dispatch(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  // Subcommand groups (config) first; then top-level subcommands.
  if (interaction.options.getSubcommandGroup(false) === "config") {
    await handleConfig(interaction, ctx);
    return;
  }
  switch (interaction.options.getSubcommand(false)) {
    case "create":
      await handleCreate(interaction, ctx);
      return;
    case "edit":
      await handleEdit(interaction, ctx);
      return;
    case "cancel":
      await handleCancel(interaction, ctx);
      return;
    case "enter":
      await handleEnter(interaction, ctx);
      return;
    case "withdraw":
      await handleWithdraw(interaction, ctx);
      return;
    case "status":
      await handleStatus(interaction, ctx);
      return;
    case "list":
      await handleList(interaction, ctx);
      return;
    case "claim":
      await handleClaim(interaction, ctx);
      return;
    case "draw":
      await handleDraw(interaction, ctx);
      return;
    case "announce":
      await handleAnnounce(interaction, ctx);
      return;
    case "reroll":
      await handleReroll(interaction, ctx);
      return;
    case "ban":
      await handleBan(interaction, ctx);
      return;
    case "unban":
      await handleUnban(interaction, ctx);
      return;
    case "banlist":
      await handleBanlist(interaction, ctx);
      return;
    case "reset":
      await handleReset(interaction, ctx);
      return;
    case "eligible":
      await handleEligible(interaction, ctx);
      return;
    default:
      await interaction.reply({
        content: "That subcommand is not available.",
        flags: MessageFlags.Ephemeral,
      });
  }
}
