/**
 * The two top-level raffle commands.
 *
 * The surface is split by audience, not by feature:
 *
 * - `/raffle` — what members do: enter, withdraw, status, list, claim. No
 *   Discord-side permission default, so everyone can see and run it.
 * - `/raffle-mod` — what moderators do: everything else. Gated with
 *   `ManageGuild` as `default_member_permissions`, so Discord hides the whole
 *   command (and with it the list of moderator capabilities) from ordinary
 *   members.
 *
 * They are two commands because `default_member_permissions` is a *command*
 * level setting: subcommands inherit it and cannot override it. One command
 * carrying both audiences therefore has to pick one visibility for all of them,
 * and picking `ManageGuild` hid `/raffle withdraw` from the members who needed
 * it (issue #49).
 *
 * The Discord-side gate is a visibility filter, never the authorisation: every
 * moderator handler independently calls the mod-role-aware `ensureModerator`
 * gate, so a member who reaches one anyway is still refused.
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
import { addFromDesignSubcommand, handleFromDesign } from "./fromDesign.js";
import {
  addEntrySubcommands,
  handleClaim,
  handleEnter,
  handleWithdraw,
  handleList,
  handleStatus,
} from "./entry.js";
import { addManageSubcommands, handleCancel, handleCreate, handleEdit } from "./manage.js";
import { addRecordWinSubcommand, handleRecordWin } from "./recordWin.js";
import { addRemoveEntrySubcommand, handleRemoveEntry } from "./removeEntry.js";
import { addResetSubcommand, handleReset } from "./reset.js";

/** The member-facing command name. */
export const RAFFLE_COMMAND = "raffle";
/** The moderator command name. */
export const RAFFLE_MOD_COMMAND = "raffle-mod";

/** Build `/raffle`, the member-facing command, wiring every subcommand to `ctx`. */
export function buildRaffleCommand(ctx: CommandContext): Command {
  const data = new SlashCommandBuilder()
    .setName(RAFFLE_COMMAND)
    .setDescription("Enter raffles and check where you stand.");
  addEntrySubcommands(data);

  return {
    data,
    execute: (interaction) => dispatchMember(interaction, ctx),
  };
}

/** Build `/raffle-mod`, the moderator command, wiring every subcommand (group) to `ctx`. */
export function buildRaffleModCommand(ctx: CommandContext): Command {
  const data = new SlashCommandBuilder()
    .setName(RAFFLE_MOD_COMMAND)
    .setDescription("Run and manage raffles.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  // Top-level subcommands added while `data` is still a full
  // SlashCommandBuilder, then the config subcommand group.
  addManageSubcommands(data);
  addFromDesignSubcommand(data);
  addDrawSubcommands(data);
  addBanSubcommands(data);
  addRemoveEntrySubcommand(data);
  addRecordWinSubcommand(data);
  addResetSubcommand(data);
  addEligibleSubcommand(data);
  data.addSubcommandGroup(addConfigGroup);

  return {
    data,
    execute: (interaction) => dispatchMod(interaction, ctx),
  };
}

/** Route a `/raffle` invocation to the handler for its subcommand. */
async function dispatchMember(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  switch (interaction.options.getSubcommand(false)) {
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
    default:
      await unknownSubcommand(interaction);
  }
}

/** Route a `/raffle-mod` invocation to the handler for its subcommand (group). */
async function dispatchMod(
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
    case "from-design":
      await handleFromDesign(interaction, ctx);
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
    case "remove-entry":
      await handleRemoveEntry(interaction, ctx);
      return;
    case "record-win":
      await handleRecordWin(interaction, ctx);
      return;
    case "reset":
      await handleReset(interaction, ctx);
      return;
    case "eligible":
      await handleEligible(interaction, ctx);
      return;
    default:
      await unknownSubcommand(interaction);
  }
}

function unknownSubcommand(interaction: ChatInputCommandInteraction): Promise<unknown> {
  return interaction.reply({
    content: "That subcommand is not available.",
    flags: MessageFlags.Ephemeral,
  });
}
