/**
 * User-facing raffle subcommands: `/raffle enter`, `status`, `list`, and the
 * Enter button handler.
 *
 * These are the member-facing entry points (no mod gate). They resolve the
 * target raffle, gather context (the member's join date, the guild config),
 * hand off to the shared `attemptEntry` orchestration, and format an ephemeral
 * reply. The button and `/raffle enter` share the exact same path.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type RepliableInteraction,
} from "discord.js";
import { activityProgress } from "../../../core/eligibility.js";
import { winCooldownStatus } from "../../../core/cooldown.js";
import { discordTimestamp } from "../../../core/time.js";
import { isBlacklisted } from "../../../db/repositories/blacklist.js";
import { getGuild } from "../../../db/repositories/guilds.js";
import { getRaffle, listByStatus, type RaffleRow } from "../../../db/repositories/raffles.js";
import { parseEnterButtonId } from "../../components/enterButton.js";
import {
  attemptEntry,
  gatherEligibilityInput,
  type EntryContext,
} from "../../entryFlow.js";
import { entryFailureMessage, entrySuccessMessage } from "../../messages/entryReplies.js";
import type { CommandContext } from "../index.js";

/** Add the user-facing subcommands to the `/raffle` builder. */
export function addEntrySubcommands(builder: SlashCommandBuilder): SlashCommandBuilder {
  builder
    .addSubcommand((s) =>
      s
        .setName("enter")
        .setDescription("Enter an open raffle.")
        .addIntegerOption((o) =>
          o.setName("raffle").setDescription("Which raffle (id), if more than one is open.").setMinValue(1),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("status")
        .setDescription("Check your eligibility for a raffle.")
        .addIntegerOption((o) =>
          o.setName("raffle").setDescription("Which raffle (id).").setMinValue(1),
        ),
    )
    .addSubcommand((s) => s.setName("list").setDescription("List open and upcoming raffles."));
  return builder;
}

function ephemeral(interaction: RepliableInteraction, content: string): Promise<unknown> {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** The member's guild-join time as UTC ISO, or null if unavailable. */
function joinedAtIso(member: unknown): string | null {
  const ts = (member as GuildMember | null)?.joinedTimestamp ?? null;
  return ts === null ? null : new Date(ts).toISOString();
}

/**
 * Resolve which raffle a user means: an explicit id, else the single open
 * raffle. Returns the row, or a string describing why it could not be resolved.
 */
function resolveTargetRaffle(
  db: CommandContext["db"],
  guildId: string,
  explicitId: number | null,
): RaffleRow | string {
  if (explicitId !== null) {
    const raffle = getRaffle(db, explicitId);
    if (!raffle || raffle.guild_id !== guildId) {
      return "No raffle with that id exists in this server.";
    }
    return raffle;
  }
  const open = listByStatus(db, guildId, ["open"]);
  if (open.length === 0) {
    return "There are no open raffles right now.";
  }
  if (open.length > 1) {
    const ids = open.map((r) => `#${r.raffle_id} (${r.name ?? "unnamed"})`).join(", ");
    return `More than one raffle is open — pick one with the \`raffle\` option: ${ids}.`;
  }
  return open[0]!;
}

export async function handleEnter(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await ephemeral(interaction, "This command can only be used in a server.");
    return;
  }
  const target = resolveTargetRaffle(ctx.db, guildId, interaction.options.getInteger("raffle"));
  if (typeof target === "string") {
    await ephemeral(interaction, target);
    return;
  }
  await runEntry(interaction, ctx, target, interaction.user.id, joinedAtIso(interaction.member));
}

export async function handleEnterButton(
  interaction: ButtonInteraction,
  ctx: CommandContext,
): Promise<void> {
  const raffleId = parseEnterButtonId(interaction.customId);
  if (raffleId === null) {
    return;
  }
  const raffle = getRaffle(ctx.db, raffleId);
  if (!raffle) {
    await ephemeral(interaction, "That raffle no longer exists.");
    return;
  }
  await runEntry(interaction, ctx, raffle, interaction.user.id, joinedAtIso(interaction.member));
}

/** Shared entry path for the button and the slash command. */
async function runEntry(
  interaction: RepliableInteraction,
  ctx: CommandContext,
  raffle: RaffleRow,
  userId: string,
  joinedAt: string | null,
): Promise<void> {
  const entryCtx: EntryContext = {
    raffle,
    guild: getGuild(ctx.db, raffle.guild_id),
    userId,
    joinedAt,
    now: new Date().toISOString(),
  };
  const { input, result } = attemptEntry(ctx.db, ctx.notifier, entryCtx);
  if (result.ok) {
    await ephemeral(interaction, entrySuccessMessage(raffle.name));
    return;
  }
  const generic = (entryCtx.guild?.blacklist_generic_message ?? 0) === 1;
  await ephemeral(interaction, entryFailureMessage(result.reason, input, generic));
}

export async function handleStatus(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await ephemeral(interaction, "This command can only be used in a server.");
    return;
  }
  const target = resolveTargetRaffle(ctx.db, guildId, interaction.options.getInteger("raffle"));
  if (typeof target === "string") {
    await ephemeral(interaction, target);
    return;
  }

  const input = gatherEligibilityInput(ctx.db, {
    raffle: target,
    guild: getGuild(ctx.db, guildId),
    userId: interaction.user.id,
    joinedAt: joinedAtIso(interaction.member),
    now: new Date().toISOString(),
  });

  const progress = activityProgress(input);
  const cooldown = winCooldownStatus({
    cooldownDays: input.cooldown.cooldownDays,
    cooldownCount: input.cooldown.cooldownCount,
    wins: input.wins,
    rafflesSinceLastWin: input.rafflesSinceLastWin,
    now: input.now,
  });

  const lines = [`**Your status for ${target.name ?? "the raffle"}**`];
  if (input.blacklisted) {
    lines.push("- ⛔ You're blacklisted from raffles in this server.");
  }
  lines.push(
    progress.exempt
      ? "- ✅ Activity: exempt (new member)"
      : `- ${progress.have >= progress.need ? "✅" : "⬜"} Activity: ${progress.have}/${progress.need} messages`,
  );
  lines.push(
    cooldown.active
      ? `- ⏳ Win cooldown active${cooldown.endsAt ? ` until ${discordTimestamp(cooldown.endsAt, "R")}` : ""}`
      : "- ✅ No win cooldown",
  );
  lines.push(input.alreadyEntered ? "- 🎟️ You're already entered." : "- ⬜ Not entered yet.");

  await ephemeral(interaction, lines.join("\n"));
}

export async function handleList(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await ephemeral(interaction, "This command can only be used in a server.");
    return;
  }
  const raffles = listByStatus(ctx.db, guildId, ["open", "scheduled"]);
  if (raffles.length === 0) {
    await ephemeral(interaction, "There are no open or upcoming raffles.");
    return;
  }
  const lines = raffles.map((r) => {
    const when =
      r.status === "open"
        ? r.ends_at
          ? `open, closes ${discordTimestamp(r.ends_at, "R")}`
          : "open"
        : r.starts_at
          ? `opens ${discordTimestamp(r.starts_at, "R")}`
          : "upcoming";
    return `- **${r.name ?? `Raffle #${r.raffle_id}`}** (#${r.raffle_id}) — ${when}`;
  });
  await ephemeral(interaction, `**Raffles**\n${lines.join("\n")}`);
}
