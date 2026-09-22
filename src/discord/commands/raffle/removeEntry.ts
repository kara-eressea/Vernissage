/**
 * `/raffle-mod remove-entry` — withdraw a member's entry on their behalf.
 *
 * The use case is help, not punishment (issue #47): a member who wants out of a
 * raffle but cannot work out how to do it themselves. It is therefore the member
 * facing `/raffle withdraw` with a moderator's hand on it, and shares that
 * command's rules through `withdrawEntry` — open raffles only, soft removal,
 * and re-entry allowed while the raffle stays open.
 *
 * To *bar* someone, `/raffle-mod ban` is the command: it sweeps their entries
 * from every open raffle and keeps them out. This one leaves them free to
 * re-enter, deliberately.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { withdrawEntry } from "../../../entries/withdrawal.js";
import { refreshEntryMessage } from "../../entryFlow.js";
import { resolveOpenRaffle } from "./resolveRaffle.js";
import { ensureModerator } from "../moderator.js";
import type { CommandContext } from "../index.js";

/** Add the remove-entry subcommand to the `/raffle-mod` builder. */
export function addRemoveEntrySubcommand(builder: SlashCommandBuilder): SlashCommandBuilder {
  builder.addSubcommand((s) =>
    s
      .setName("remove-entry")
      .setDescription("Withdraw a member's entry for them (they can re-enter).")
      .addUserOption((o) =>
        o.setName("user").setDescription("The member to withdraw.").setRequired(true),
      )
      .addIntegerOption((o) =>
        o
          .setName("raffle")
          .setDescription("Which raffle (id), if more than one is open.")
          .setMinValue(1),
      ),
  );
  return builder;
}

/** Handle `/raffle-mod remove-entry`. */
export async function handleRemoveEntry(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }

  const target = resolveOpenRaffle(ctx.db, guildId, interaction.options.getInteger("raffle"));
  if (typeof target === "string") {
    await reply(interaction, target);
    return;
  }

  const user = interaction.options.getUser("user", true);
  const result = withdrawEntry(ctx.db, {
    raffle: target,
    userId: user.id,
    actorId: interaction.user.id,
    now: new Date().toISOString(),
  });

  if (!result.ok) {
    await reply(
      interaction,
      result.reason === "not_open"
        ? "Entries can only be withdrawn while the raffle is open."
        : `${user} hasn't entered **${target.name ?? "the raffle"}**, so there's nothing to withdraw.`,
    );
    return;
  }

  void ctx.notifier.mirrorAudit(result.event);
  // Keep the public card's Entries count current, as on entry, self-withdrawal
  // and ban removal. Fire-and-forget: a slow edit never delays the reply.
  void refreshEntryMessage(ctx.db, ctx.notifier, target.raffle_id).catch((err) =>
    console.error(`Failed to refresh entry message for raffle ${target.raffle_id}:`, err),
  );

  await reply(
    interaction,
    `Withdrew ${user} from **${target.name ?? "the raffle"}**. They can re-enter while it's open — ` +
      `use \`/raffle-mod ban\` instead if they should be kept out. They are not notified, so tell them it's done.`,
  );
}

function reply(interaction: ChatInputCommandInteraction, content: string): Promise<unknown> {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
