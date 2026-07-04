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
import { getGuild } from "../../../db/repositories/guilds.js";
import {
  getGuildRaffle,
  getRaffle,
  listByStatus,
  type RaffleRow,
} from "../../../db/repositories/raffles.js";
import { getActiveWinForUser } from "../../../db/repositories/wins.js";
import { recordClaim } from "../../../draw/service.js";
import { parseEnterButtonId } from "../../components/enterButton.js";
import {
  attemptEntry,
  gatherEligibilityInput,
  type EntryContext,
} from "../../entryFlow.js";
import {
  entryFailureMessage,
  entrySuccessMessage,
  raffleListMessage,
  statusMessage,
} from "../../messages/entryReplies.js";
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
    .addSubcommand((s) => s.setName("list").setDescription("List open and upcoming raffles."))
    .addSubcommand((s) =>
      s
        .setName("claim")
        .setDescription("Claim a prize you won within its claim window.")
        .addIntegerOption((o) =>
          o.setName("raffle").setDescription("Which raffle (id), if you won more than one.").setMinValue(1),
        ),
    );
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
 * Role ids the member holds, across both member shapes discord.js hands us: a
 * full `GuildMember` (roles is a manager with a cache) or the raw API member
 * (roles is a string array). Empty when there is no member (e.g. a DM).
 */
function roleIdsOf(member: unknown): string[] {
  const roles = (member as GuildMember | null)?.roles;
  if (!roles) {
    return [];
  }
  return Array.isArray(roles) ? [...roles] : [...roles.cache.keys()];
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
    const raffle = getGuildRaffle(db, guildId, explicitId);
    if (!raffle) {
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
  await runEntry(
    interaction,
    ctx,
    target,
    interaction.user.id,
    roleIdsOf(interaction.member),
    joinedAtIso(interaction.member),
  );
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
  await runEntry(
    interaction,
    ctx,
    raffle,
    interaction.user.id,
    roleIdsOf(interaction.member),
    joinedAtIso(interaction.member),
  );
}

/** Shared entry path for the button and the slash command. */
async function runEntry(
  interaction: RepliableInteraction,
  ctx: CommandContext,
  raffle: RaffleRow,
  userId: string,
  userRoleIds: string[],
  joinedAt: string | null,
): Promise<void> {
  const entryCtx: EntryContext = {
    raffle,
    guild: getGuild(ctx.db, raffle.guild_id),
    userId,
    userRoleIds,
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
    userRoleIds: roleIdsOf(interaction.member),
    joinedAt: joinedAtIso(interaction.member),
    now: new Date().toISOString(),
  });

  await ephemeral(interaction, statusMessage(target.name, input));
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
  await ephemeral(interaction, raffleListMessage(raffles));
}

/**
 * Resolve which drawn raffle a `/raffle claim` refers to: an explicit id, else
 * the single raffle where the caller has an unclaimed prize. Returns the row, or
 * a string explaining why it could not be resolved.
 */
function resolveClaimRaffle(
  db: CommandContext["db"],
  guildId: string,
  userId: string,
  explicitId: number | null,
): RaffleRow | string {
  if (explicitId !== null) {
    const raffle = getGuildRaffle(db, guildId, explicitId);
    if (!raffle) {
      return "No raffle with that id exists in this server.";
    }
    return raffle;
  }
  const claimable = listByStatus(db, guildId, ["drawn"]).filter((r) => {
    const win = getActiveWinForUser(db, r.raffle_id, userId);
    return win && win.claim_deadline !== null && win.claimed_at === null;
  });
  if (claimable.length === 0) {
    return "You have no prizes to claim right now.";
  }
  if (claimable.length > 1) {
    const ids = claimable.map((r) => `#${r.raffle_id} (${r.name ?? "unnamed"})`).join(", ");
    return `You've won more than one — pick which to claim with the \`raffle\` option: ${ids}.`;
  }
  return claimable[0]!;
}

export async function handleClaim(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await ephemeral(interaction, "This command can only be used in a server.");
    return;
  }
  const userId = interaction.user.id;
  const target = resolveClaimRaffle(ctx.db, guildId, userId, interaction.options.getInteger("raffle"));
  if (typeof target === "string") {
    await ephemeral(interaction, target);
    return;
  }

  const outcome = await recordClaim(ctx.db, ctx.notifier, target.raffle_id, userId, new Date().toISOString());
  if (outcome.ok) {
    await ephemeral(interaction, `🎁 Claimed! Your prize for **${target.name ?? "the raffle"}** is reserved for you.`);
    return;
  }
  const message =
    outcome.reason === "not_winner"
      ? "You're not a current winner of that raffle."
      : outcome.reason === "no_claim_required"
        ? "That raffle needs no claim — the prize is already yours."
        : outcome.reason === "already_claimed"
          ? "You've already claimed that prize."
          : outcome.reason === "not_drawn"
            ? "That raffle hasn't been drawn yet."
            : "No raffle with that id exists in this server.";
  await ephemeral(interaction, message);
}
