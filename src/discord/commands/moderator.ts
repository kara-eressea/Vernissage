/**
 * Shared moderator gate for `/raffle` subcommands.
 *
 * Extracts the invoking member's standing from an interaction and feeds it to
 * the pure `isModerator` decision (src/core/permissions.ts), with the bootstrap
 * fallback (owner / Manage Server before a mod role is set). Every mod-only
 * subcommand calls `ensureModerator` first; it replies ephemerally and returns
 * false when the caller is not allowed.
 */

import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Database } from "better-sqlite3";
import { isModerator } from "../../core/permissions.js";
import { getGuild } from "../../db/repositories/guilds.js";

/** Role ids the invoking member holds, across both member shapes discord.js hands us. */
export function memberRoleIds(interaction: ChatInputCommandInteraction): string[] {
  const member = interaction.member;
  if (!member) {
    return [];
  }
  const roles = member.roles;
  if (Array.isArray(roles)) {
    return [...roles];
  }
  return [...roles.cache.keys()];
}

/** Whether the interaction's member passes the moderator gate for this guild. */
export function isModeratorInteraction(
  interaction: ChatInputCommandInteraction,
  modRole: string | null,
): boolean {
  return isModerator({
    modRole,
    memberRoleIds: memberRoleIds(interaction),
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    hasManageGuild:
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
  });
}

/**
 * Ensure the caller may run a moderator command; reply and return false if not.
 * Returns the guild id on success so callers avoid re-reading it.
 */
export async function ensureModerator(
  interaction: ChatInputCommandInteraction,
  db: Database,
): Promise<string | null> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  const modRole = getGuild(db, guildId)?.mod_role ?? null;
  if (!isModeratorInteraction(interaction, modRole)) {
    await interaction.reply({
      content: "You do not have permission to manage raffles.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return guildId;
}
