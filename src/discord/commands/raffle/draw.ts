/**
 * `/raffle draw` and `/raffle reroll`.
 *
 * The moderator-triggered ends of the draw lifecycle: manually draw a closed
 * raffle (for `draw_mode='manual'`, or to force an auto raffle that has not run
 * yet), and reroll a disqualified winner with a logged reason. All draw logic
 * lives in the pure core + the draw service (src/draw/service.ts); these
 * handlers only gate, parse, call the service, and format the reply. Posting can
 * hit the network, so each defers first and edits the reply after.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { userMention } from "../../../core/format.js";
import { getRaffle } from "../../../db/repositories/raffles.js";
import { listWinsForRaffle } from "../../../db/repositories/wins.js";
import { executeDraw, rerollWinner } from "../../../draw/service.js";
import type { CommandContext } from "../index.js";
import { ensureModerator } from "../moderator.js";

/** Add the draw/reroll subcommands to the `/raffle` builder. */
export function addDrawSubcommands(builder: SlashCommandBuilder): SlashCommandBuilder {
  builder
    .addSubcommand((s) =>
      s
        .setName("draw")
        .setDescription("Draw a closed raffle now (if not drawn automatically).")
        .addIntegerOption((o) =>
          o.setName("raffle").setDescription("The raffle id.").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("reroll")
        .setDescription("Replace a disqualified winner; logged with a reason.")
        .addIntegerOption((o) =>
          o.setName("raffle").setDescription("The raffle id.").setRequired(true).setMinValue(1),
        )
        .addUserOption((o) =>
          o.setName("winner").setDescription("The winner to disqualify.").setRequired(true),
        )
        .addStringOption((o) =>
          o.setName("reason").setDescription("Why they are being rerolled.").setRequired(true),
        ),
    );
  return builder;
}

/** Handle `/raffle draw`. */
export async function handleDraw(
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
    await interaction.reply({
      content: "No raffle with that id in this server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const outcome = await executeDraw(ctx.db, ctx.notifier, raffleId, new Date().toISOString());

  if (!outcome.ok) {
    const message =
      outcome.reason === "already_drawn"
        ? "That raffle has already been drawn."
        : outcome.reason === "not_closed"
          ? "Only a closed raffle can be drawn."
          : "No raffle with that id in this server.";
    await interaction.editReply({ content: message });
    return;
  }
  await interaction.editReply({
    content:
      outcome.winners.length === 0
        ? "Drawn — there were no eligible entrants."
        : `Drawn. Winner(s): ${outcome.winners.map(userMention).join(", ")}.`,
  });
}

/** Handle `/raffle reroll`. */
export async function handleReroll(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }
  const raffleId = interaction.options.getInteger("raffle", true);
  const winnerUser = interaction.options.getUser("winner", true);
  const reason = interaction.options.getString("reason", true);

  const raffle = getRaffle(ctx.db, raffleId);
  if (!raffle || raffle.guild_id !== guildId) {
    await interaction.reply({
      content: "No raffle with that id in this server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const win = listWinsForRaffle(ctx.db, raffleId).find(
    (w) => w.user_id === winnerUser.id && w.rerolled === 0,
  );
  if (!win) {
    await interaction.reply({
      content: "That user is not a current winner of this raffle.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const outcome = await rerollWinner(
    ctx.db,
    ctx.notifier,
    raffleId,
    win.win_id,
    reason,
    new Date().toISOString(),
  );

  if (!outcome.ok) {
    const message =
      outcome.reason === "not_drawn"
        ? "Only a drawn raffle can be rerolled."
        : outcome.reason === "invalid_win"
          ? "That user is not a current winner of this raffle."
          : "No raffle with that id in this server.";
    await interaction.editReply({ content: message });
    return;
  }
  await interaction.editReply({
    content: outcome.replacement
      ? `Rerolled ${userMention(outcome.disqualified)} → ${userMention(outcome.replacement)}.`
      : `Rerolled ${userMention(outcome.disqualified)}, but no replacement was available.`,
  });
}
