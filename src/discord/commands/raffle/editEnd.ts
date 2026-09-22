/**
 * Open-raffle end-time correction.
 *
 * While a raffle is open its end time may be corrected — moved earlier or later,
 * but not before its start (design.md edit constraint). `/raffle-mod edit` on an open
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
import { getGuildRaffle, updateRaffleFields } from "../../../db/repositories/raffles.js";
import { auditAndMirror, type Notifier } from "../../notifier.js";
import { isModeratorInteraction } from "../moderator.js";

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

  // Re-authorise at the write, not only when `/raffle-mod edit` showed the modal
  // (issue #53). A modal can sit open indefinitely, and this submit moves a live
  // raffle's end time, so the standing that matters is the one held now.
  //
  // The mod role and the member's standing are both taken from the guild the
  // submit arrived in — reading them from different guilds is the only way they
  // could disagree — and the raffle is then scoped to that guild. Authorising
  // before the lookup also keeps a refusal from revealing whether the id exists.
  const guildId = interaction.guildId;
  const guild = guildId === null ? undefined : getGuild(deps.db, guildId);
  if (guildId === null || !isModeratorInteraction(interaction, guild?.mod_role ?? null)) {
    await interaction.reply({
      content: "You do not have permission to manage raffles.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const raffle = getGuildRaffle(deps.db, guildId, raffleId);
  if (!raffle) {
    await interaction.reply({ content: "That raffle no longer exists.", flags: MessageFlags.Ephemeral });
    return;
  }

  // The raffle's state can move while a modal sits open just as standing can,
  // and only an open raffle's end time may be corrected (design.md's edit
  // constraint). A submit landing after it closed would otherwise rewrite the
  // end time of a settled raffle — and audit it as an edit.
  if (raffle.status !== "open") {
    await interaction.reply({
      content: "That raffle is no longer open, so its end time can't be changed.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = new Date().toISOString();
  // Interpret the input in the guild's configured timezone, matching the
  // creation wizard, so "tomorrow 20:00" means the mods' local time, not UTC.
  const timeZone = guild?.timezone ?? null;
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
