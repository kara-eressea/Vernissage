/**
 * Open-raffle end-time extension.
 *
 * An open raffle may only have its end time extended (design.md edit
 * constraint). `/raffle edit` on an open raffle shows this modal; the submit is
 * dispatched here via the "editend" custom-id namespace. Parsing and the
 * extension-only rule come from the pure core.
 */

import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";
import type { Database } from "better-sqlite3";
import { AUDIT_EVENTS } from "../../../core/auditEvents.js";
import { validateOpenRaffleEdit } from "../../../core/raffleValidation.js";
import { parseFriendlyTime } from "../../../core/timeParse.js";
import { writeAudit } from "../../../db/repositories/audit.js";
import { getRaffle, updateRaffleFields } from "../../../db/repositories/raffles.js";
import type { Notifier } from "../../notifier.js";

/** Custom-id namespace for the end-extension modal submit. */
export const EDIT_END_PREFIX = "editend";

/** Build the end-time-extension modal for an open raffle. */
export function editEndModal(raffle: { raffle_id: number }): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${EDIT_END_PREFIX}:${raffle.raffle_id}`)
    .setTitle("Extend end time")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("end")
          .setLabel("New end time (must be later)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("in 3 days, or 2026-08-05 20:00"),
      ),
    );
}

export interface EditEndDeps {
  db: Database;
  notifier: Notifier;
}

/** Handle the end-extension modal submit. */
export async function handleEditEnd(
  interaction: ModalSubmitInteraction,
  deps: EditEndDeps,
): Promise<void> {
  const raffleId = Number(interaction.customId.split(":")[1]);
  const raffle = getRaffle(deps.db, raffleId);
  if (!raffle) {
    await interaction.reply({ content: "That raffle no longer exists.", flags: MessageFlags.Ephemeral });
    return;
  }

  const now = new Date().toISOString();
  const parsed = parseFriendlyTime(interaction.fields.getTextInputValue("end"), now);
  if (!parsed.ok) {
    await interaction.reply({ content: `⚠️ ${parsed.error}`, flags: MessageFlags.Ephemeral });
    return;
  }
  const check = validateOpenRaffleEdit(raffle.ends_at, parsed.utcIso);
  if (!check.ok) {
    await interaction.reply({ content: `⚠️ ${check.error}`, flags: MessageFlags.Ephemeral });
    return;
  }

  updateRaffleFields(deps.db, raffleId, { ends_at: parsed.utcIso });
  writeAudit(deps.db, {
    guildId: raffle.guild_id,
    raffleId,
    eventType: AUDIT_EVENTS.raffleEdited,
    actorId: interaction.user.id,
    payload: { ends_at: parsed.utcIso },
    createdAt: now,
  });
  void deps.notifier.mirrorAudit({
    guildId: raffle.guild_id,
    raffleId,
    eventType: AUDIT_EVENTS.raffleEdited,
    actorId: interaction.user.id,
    createdAt: now,
  });

  await interaction.reply({
    content: "End time extended.",
    flags: MessageFlags.Ephemeral,
  });
}
