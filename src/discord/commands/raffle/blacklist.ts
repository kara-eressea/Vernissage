/**
 * `/raffle ban`, `/raffle unban`, `/raffle banlist`.
 *
 * The moderator blacklist surface (design.md "Blacklist"). Banning a user with
 * an active entry in an open raffle soft-removes that entry and logs it to the
 * audit channel *without* the private reason; the mod's free-text reason lives
 * only on the ban row and mod-facing surfaces (banlist, the ephemeral reply).
 * Duration parsing is pure (src/core/duration.ts); entry removal is DB
 * orchestration (src/blacklist/entryRemoval.ts). Handlers stay thin.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { AUDIT_EVENTS } from "../../../core/auditEvents.js";
import { parseBanDuration } from "../../../core/duration.js";
import { userMention } from "../../../core/format.js";
import { discordTimestamp } from "../../../core/time.js";
import { removeEntriesForBan } from "../../../blacklist/entryRemoval.js";
import { writeAudit } from "../../../db/repositories/audit.js";
import { addBan, listBans, removeBan } from "../../../db/repositories/blacklist.js";
import type { CommandContext } from "../index.js";
import { ensureModerator } from "../moderator.js";

/** Add the ban/unban/banlist subcommands to the `/raffle` builder. */
export function addBanSubcommands(builder: SlashCommandBuilder): SlashCommandBuilder {
  builder
    .addSubcommand((s) =>
      s
        .setName("ban")
        .setDescription("Blacklist a user from raffles.")
        .addUserOption((o) => o.setName("user").setDescription("The user to ban.").setRequired(true))
        .addStringOption((o) =>
          o.setName("duration").setDescription("e.g. 30m, 24h, 7d, 2w. Blank = permanent."),
        )
        .addStringOption((o) => o.setName("reason").setDescription("Mod-only reason.")),
    )
    .addSubcommand((s) =>
      s
        .setName("unban")
        .setDescription("Lift a user's blacklist (does not restore removed entries).")
        .addUserOption((o) =>
          o.setName("user").setDescription("The user to unban.").setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s.setName("banlist").setDescription("List the guild's current blacklist (mod-only)."),
    );
  return builder;
}

function reply(interaction: ChatInputCommandInteraction, content: string): Promise<unknown> {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Handle `/raffle ban`. */
export async function handleBan(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }
  const user = interaction.options.getUser("user", true);
  const durationInput = interaction.options.getString("duration");
  const reason = interaction.options.getString("reason");
  const now = new Date().toISOString();

  let expiresAt: string | null;
  try {
    expiresAt = parseBanDuration(durationInput, now);
  } catch (err) {
    await reply(interaction, `⚠️ ${(err as Error).message}`);
    return;
  }

  // Ban, its audit row, and the entry removals are one state change: wrap them
  // in a single transaction so a crash can't leave a ban without its audit row
  // (removeEntriesForBan's own transaction nests safely via a savepoint).
  const affected = ctx.db.transaction(() => {
    addBan(ctx.db, {
      guildId,
      userId: user.id,
      bannedBy: interaction.user.id,
      reason,
      bannedAt: now,
      expiresAt,
    });
    // The reason is deliberately kept out of the audit payload (mod-only surface).
    writeAudit(ctx.db, {
      guildId,
      raffleId: null,
      eventType: AUDIT_EVENTS.blacklistAdded,
      actorId: interaction.user.id,
      payload: { userId: user.id },
      createdAt: now,
    });
    return removeEntriesForBan(ctx.db, guildId, user.id, now, interaction.user.id);
  })();

  // Mirror the ban and each entry removal to the audit channel — reason-free by
  // construction (formatAuditLine never reads a reason).
  void ctx.notifier.mirrorAudit({
    guildId,
    raffleId: null,
    eventType: AUDIT_EVENTS.blacklistAdded,
    actorId: interaction.user.id,
    payload: { userId: user.id },
    createdAt: now,
  });
  for (const raffleId of affected) {
    void ctx.notifier.mirrorAudit({
      guildId,
      raffleId,
      eventType: AUDIT_EVENTS.entryRemoved,
      actorId: interaction.user.id,
      payload: { userId: user.id },
      createdAt: now,
    });
  }

  const until = expiresAt ? `until ${discordTimestamp(expiresAt)}` : "permanently";
  const removed =
    affected.length > 0
      ? ` Removed their entry from ${affected.length} open raffle${affected.length === 1 ? "" : "s"}.`
      : "";
  const reasonNote = reason ? ` Reason: ${reason}` : "";
  await reply(interaction, `Banned ${userMention(user.id)} ${until}.${removed}${reasonNote}`);
}

/** Handle `/raffle unban`. */
export async function handleUnban(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }
  const user = interaction.options.getUser("user", true);
  const now = new Date().toISOString();

  // Unban + its audit row are one state change (atomic).
  ctx.db.transaction(() => {
    removeBan(ctx.db, guildId, user.id);
    writeAudit(ctx.db, {
      guildId,
      raffleId: null,
      eventType: AUDIT_EVENTS.blacklistRemoved,
      actorId: interaction.user.id,
      payload: { userId: user.id },
      createdAt: now,
    });
  })();
  void ctx.notifier.mirrorAudit({
    guildId,
    raffleId: null,
    eventType: AUDIT_EVENTS.blacklistRemoved,
    actorId: interaction.user.id,
    payload: { userId: user.id },
    createdAt: now,
  });

  await reply(
    interaction,
    `Lifted the blacklist on ${userMention(user.id)}. Previously removed entries are not restored.`,
  );
}

/** Handle `/raffle banlist`. */
export async function handleBanlist(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }
  const now = new Date().toISOString();
  const bans = listBans(ctx.db, guildId);
  if (bans.length === 0) {
    await reply(interaction, "No users are currently blacklisted.");
    return;
  }

  const lines = bans.map((b) => {
    const expired = b.expires_at !== null && Date.parse(b.expires_at) <= Date.parse(now);
    const when = b.expires_at
      ? `${expired ? "expired" : "until"} ${discordTimestamp(b.expires_at)}`
      : "permanent";
    const reason = b.reason ? ` — ${b.reason}` : "";
    return `• ${userMention(b.user_id)} (${when})${reason}`;
  });
  await reply(interaction, `**Blacklist (${bans.length}):**\n${lines.join("\n")}`);
}
