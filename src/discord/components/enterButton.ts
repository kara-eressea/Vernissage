/**
 * The Enter button on a raffle's message.
 *
 * The custom id encodes the raffle id (`raffle:enter:<id>`) so a click binds to
 * a specific raffle even when several are open at once (design.md "Edge cases":
 * the entry button binds to a specific raffle id). The id build/parse are pure
 * and unit-tested; the builder produces the discord.js component the announcer
 * attaches when it posts an open raffle's message.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

/** Custom-id namespace the interaction router dispatches Enter clicks on. */
export const ENTER_PREFIX = "raffle";

/** Build the Enter button's custom id for a raffle. */
export function buildEnterButtonId(raffleId: number): string {
  return `${ENTER_PREFIX}:enter:${raffleId}`;
}

/** Parse a raffle id from an Enter button custom id, or null if it is not one. */
export function parseEnterButtonId(customId: string): number | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== ENTER_PREFIX || parts[1] !== "enter") {
    return null;
  }
  const id = Number(parts[2]);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/** The Enter button for a raffle. */
export function buildEnterButton(raffleId: number): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(buildEnterButtonId(raffleId))
    .setLabel("Enter")
    .setEmoji("🎟️")
    .setStyle(ButtonStyle.Primary);
}

/** The action row wrapping the Enter button, ready to attach to a message. */
export function buildEnterRow(raffleId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buildEnterButton(raffleId));
}
