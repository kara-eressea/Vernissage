/**
 * `/raffle create`, `/raffle edit`, `/raffle cancel`.
 *
 * The lifecycle commands that produce and retire raffles. `create` and a
 * draft/scheduled `edit` open the wizard; an open `edit` allows only an
 * end-time extension; `cancel` retires any pre-drawn raffle with a reason. All
 * status/edit rules come from the pure core (src/core/raffleValidation.ts); the
 * handlers only parse, gate, call repos, audit, and format.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { AUDIT_EVENTS } from "../../../core/auditEvents.js";
import { editModeForStatus, isCancellable } from "../../../core/raffleValidation.js";
import { writeAudit } from "../../../db/repositories/audit.js";
import {
  createDraft,
  getRaffle,
  setStatus,
  updateRaffleFields,
} from "../../../db/repositories/raffles.js";
import { clearWizardState, upsertWizardStep } from "../../../db/repositories/wizardState.js";
import type { CommandContext } from "../index.js";
import { createWizard } from "../../wizard/index.js";
import { editEndModal } from "./editEnd.js";
import { ensureModerator } from "../moderator.js";

/** Add create/edit/cancel subcommands to the `/raffle` builder. */
export function addManageSubcommands(builder: SlashCommandBuilder): SlashCommandBuilder {
  builder
    .addSubcommand((s) =>
      s
        .setName("create")
        .setDescription("Create a new raffle with the guided wizard.")
        .addStringOption((o) => o.setName("name").setDescription("Prefill the raffle name."))
        .addStringOption((o) => o.setName("prize").setDescription("Prefill the prize.")),
    )
    .addSubcommand((s) =>
      s
        .setName("edit")
        .setDescription("Edit a draft/scheduled raffle, or extend an open raffle's end time.")
        .addIntegerOption((o) =>
          o.setName("raffle").setDescription("The raffle id.").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("cancel")
        .setDescription("Cancel a raffle before it is drawn.")
        .addIntegerOption((o) =>
          o.setName("raffle").setDescription("The raffle id.").setRequired(true).setMinValue(1),
        )
        .addStringOption((o) =>
          o.setName("reason").setDescription("Why it is being cancelled.").setRequired(true),
        ),
    );
  return builder;
}

function reply(interaction: ChatInputCommandInteraction, content: string): Promise<unknown> {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

export async function handleCreate(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }
  const now = new Date().toISOString();
  const raffleId = createDraft(ctx.db, guildId, interaction.user.id, now);

  // Optional power-user prefill.
  const name = interaction.options.getString("name");
  const prize = interaction.options.getString("prize");
  if (name || prize) {
    updateRaffleFields(ctx.db, raffleId, {
      ...(name ? { name } : {}),
      ...(prize ? { prize } : {}),
    });
  }

  writeAudit(ctx.db, {
    guildId,
    raffleId,
    eventType: AUDIT_EVENTS.raffleCreated,
    actorId: interaction.user.id,
    payload: { name },
    createdAt: now,
  });
  upsertWizardStep(ctx.db, raffleId, "basics", now);

  const wizard = createWizard({ db: ctx.db, notifier: ctx.notifier });
  await wizard.start(interaction, raffleId);
}

export async function handleEdit(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }
  const raffleId = interaction.options.getInteger("raffle", true);
  const raffle = getRaffle(ctx.db, raffleId);
  if (!raffle || raffle.guild_id !== guildId) {
    await reply(interaction, "No raffle with that id exists in this server.");
    return;
  }

  switch (editModeForStatus(raffle.status)) {
    case "wizard": {
      const wizard = createWizard({ db: ctx.db, notifier: ctx.notifier });
      await wizard.start(interaction, raffleId);
      return;
    }
    case "extend-end":
      // Only the end time may change on an open raffle; the modal submit is
      // validated and audited by the editend interaction handler.
      await interaction.showModal(editEndModal(raffle));
      return;
    case "rejected":
      await reply(interaction, `A ${raffle.status} raffle can no longer be edited.`);
  }
}

export async function handleCancel(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }
  const raffleId = interaction.options.getInteger("raffle", true);
  const reason = interaction.options.getString("reason", true);
  const raffle = getRaffle(ctx.db, raffleId);
  if (!raffle || raffle.guild_id !== guildId) {
    await reply(interaction, "No raffle with that id exists in this server.");
    return;
  }
  if (!isCancellable(raffle.status)) {
    await reply(interaction, `A ${raffle.status} raffle cannot be cancelled.`);
    return;
  }

  const now = new Date().toISOString();
  setStatus(ctx.db, raffleId, "cancelled");
  clearWizardState(ctx.db, raffleId);
  // The reason is recorded in the audit_log row (mod-visible) but the mirrored
  // audit-channel line never shows it (formatAuditLine ignores `reason`).
  writeAudit(ctx.db, {
    guildId,
    raffleId,
    eventType: AUDIT_EVENTS.raffleCancelled,
    actorId: interaction.user.id,
    payload: { reason },
    createdAt: now,
  });
  void ctx.notifier.mirrorAudit({
    guildId,
    raffleId,
    eventType: AUDIT_EVENTS.raffleCancelled,
    actorId: interaction.user.id,
    createdAt: now,
  });

  await reply(interaction, `Cancelled raffle #${raffleId}.`);
}
