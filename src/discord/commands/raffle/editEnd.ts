/**
 * Open-raffle end-time correction.
 *
 * While a raffle is open its end time may be corrected — moved earlier or later,
 * but not before its start (design.md edit constraint). `/raffle edit` on an open
 * raffle shows this modal; the submit is dispatched here via the "editend"
 * custom-id namespace. Parsing (in the guild's timezone) and the after-start rule
 * come from the pure core.
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
import { parseFriendlyTimeInZone } from "../../../core/timeParse.js";
import { getGuild } from "../../../db/repositories/guilds.js";
import { getRaffle, updateRaffleFields } from "../../../db/repositories/raffles.js";
import { auditAndMirror, type Notifier } from "../../notifier.js";

/** Custom-id namespace for the end-correction modal submit. */
export const EDIT_END_PREFIX = "editend";

/** Build the end-time-correction modal for an open raffle. */
export function editEndModal(raffle: { raffle_id: number }): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${EDIT_END_PREFIX}:${raffle.raffle_id}`)
    .setTitle("Edit end time")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("end")
          .setLabel("New end time (earlier or later)")
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
  // Interpret the input in the guild's configured timezone, matching the
  // creation wizard, so "tomorrow 20:00" means the mods' local time, not UTC.
  const timeZone = getGuild(deps.db, raffle.guild_id)?.timezone ?? null;
  const parsed = parseFriendlyTimeInZone(interaction.fields.getTextInputValue("end"), now, timeZone);
  if (!parsed.ok) {
    await interaction.reply({ content: `⚠️ ${parsed.error}`, flags: MessageFlags.Ephemeral });
    return;
  }
  const check = validateOpenRaffleEdit(raffle.starts_at, parsed.utcIso);
  if (!check.ok) {
    await interaction.reply({ content: `⚠️ ${check.error}`, flags: MessageFlags.Ephemeral });
    return;
  }

  updateRaffleFields(deps.db, raffleId, { ends_at: parsed.utcIso });
  auditAndMirror(deps.db, deps.notifier, {
    guildId: raffle.guild_id,
    raffleId,
    eventType: AUDIT_EVENTS.raffleEdited,
    actorId: interaction.user.id,
    payload: { ends_at: parsed.utcIso },
    createdAt: now,
  });

  await interaction.reply({
    content: "End time updated.",
    flags: MessageFlags.Ephemeral,
  });
}
