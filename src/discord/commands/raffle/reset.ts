/**
 * `/raffle reset <user> <scope>`.
 *
 * A moderator maintenance command for when something goes awry: reset one
 * member's raffle standing in this guild, scoped to what needs undoing
 * (design.md "Resetting eligibility"). It never touches anyone else and never
 * crosses guilds.
 *
 *   - cooldown : waive the member's still-gating wins so their win cooldown and
 *                prior-winner bar are lifted (win records are preserved).
 *   - activity : delete the member's counted-message history (DB rows plus any
 *                counts still buffered in memory).
 *   - all      : both of the above.
 *
 * Every reset writes an audit_log row and mirrors a count-free line to the audit
 * channel. Handler stays thin: gate, parse, call the repositories in one
 * transaction, drop the in-memory buffer, format an ephemeral reply.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { AUDIT_EVENTS } from "../../../core/auditEvents.js";
import { userMention } from "../../../core/format.js";
import { deleteUserActivity } from "../../../db/repositories/activity.js";
import { writeAudit } from "../../../db/repositories/audit.js";
import { waiveUserWins } from "../../../db/repositories/wins.js";
import type { CommandContext } from "../index.js";
import { ensureModerator } from "../moderator.js";

/** The reset scopes and whether each clears wins and/or activity. */
const SCOPES = {
  all: { wins: true, activity: true },
  cooldown: { wins: true, activity: false },
  activity: { wins: false, activity: true },
} as const;

type ResetScope = keyof typeof SCOPES;

/** Add the reset subcommand to the `/raffle` builder. */
export function addResetSubcommand(builder: SlashCommandBuilder): SlashCommandBuilder {
  builder.addSubcommand((s) =>
    s
      .setName("reset")
      .setDescription("Reset a member's raffle standing in this server.")
      .addUserOption((o) =>
        o.setName("user").setDescription("The member to reset.").setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("What to reset.")
          .setRequired(true)
          .addChoices(
            { name: "all (cooldown + activity)", value: "all" },
            { name: "cooldown (win cooldown + prior-winner bar)", value: "cooldown" },
            { name: "activity (counted-message history)", value: "activity" },
          ),
      ),
  );
  return builder;
}

function reply(interaction: ChatInputCommandInteraction, content: string): Promise<unknown> {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Handle `/raffle reset`. */
export async function handleReset(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }
  const user = interaction.options.getUser("user", true);
  const scope = interaction.options.getString("scope", true) as ResetScope;
  const plan = SCOPES[scope];
  const now = new Date().toISOString();

  // Waives and/or the activity delete, plus the audit row, are one state change.
  const { winsWaived, activityRowsDeleted } = ctx.db.transaction(() => {
    const winsWaived = plan.wins ? waiveUserWins(ctx.db, guildId, user.id) : 0;
    const activityRowsDeleted = plan.activity ? deleteUserActivity(ctx.db, guildId, user.id) : 0;
    writeAudit(ctx.db, {
      guildId,
      raffleId: null,
      eventType: AUDIT_EVENTS.eligibilityReset,
      actorId: interaction.user.id,
      payload: { userId: user.id, scope, winsWaived, activityRowsDeleted },
      createdAt: now,
    });
    return { winsWaived, activityRowsDeleted };
  })();

  // Drop the member's still-buffered counts so the next flush can't re-create
  // rows we just deleted. In-memory only, so it lives outside the transaction.
  if (plan.activity) {
    ctx.counter?.forgetUser(guildId, user.id);
  }

  // Mirror a count-free line to the audit channel (formatAuditLine only shows the
  // scope, never the numbers).
  void ctx.notifier.mirrorAudit({
    guildId,
    raffleId: null,
    eventType: AUDIT_EVENTS.eligibilityReset,
    actorId: interaction.user.id,
    payload: { userId: user.id, scope },
    createdAt: now,
  });

  const parts: string[] = [];
  if (plan.wins) {
    parts.push(
      winsWaived > 0
        ? `cleared ${winsWaived} win${winsWaived === 1 ? "" : "s"} from their cooldown and prior-winner bar`
        : "no win cooldown to clear",
    );
  }
  if (plan.activity) {
    parts.push(
      activityRowsDeleted > 0
        ? `deleted ${activityRowsDeleted} day${activityRowsDeleted === 1 ? "" : "s"} of counted activity`
        : "no counted activity to delete",
    );
  }
  await reply(interaction, `Reset ${userMention(user.id)}: ${parts.join("; ")}.`);
}
