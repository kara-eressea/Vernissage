/**
 * `/raffle from-design <token>` — redeem a dashboard Raffle Designer handoff.
 *
 * The dashboard stages a composed raffle as an inert pending spec (via the bot's
 * authenticated handoff endpoint) and hands the moderator a friendly token. This
 * command redeems it: it re-authorises the caller, checks the token is theirs and
 * still valid, shows an ephemeral summary, and — only on the Confirm button —
 * creates the raffle through the exact same scheduling seam the creation wizard's
 * Confirm uses (design.md "Raffle Designer handoff"). Nothing is created until
 * the moderator confirms, and everything (authorisation, validation, the audit
 * trail) happens here in Discord, not on the dashboard.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Database } from "better-sqlite3";
import { AUDIT_EVENTS } from "../../../core/auditEvents.js";
import { normalizeToken } from "../../../core/friendlyToken.js";
import { formatWallClockInZone } from "../../../core/timeParse.js";
import { writeAudit } from "../../../db/repositories/audit.js";
import { getGuild } from "../../../db/repositories/guilds.js";
import {
  getPendingRaffle,
  markPendingRedeemed,
  parsePendingSpec,
  type PendingRaffleRow,
  type PendingRaffleSpec,
} from "../../../db/repositories/pendingRaffles.js";
import { createDraft, getRaffle, updateRaffleFields } from "../../../db/repositories/raffles.js";
import type { RaffleFieldPatch } from "../../../db/repositories/raffles.js";
import { confirmAndSchedule } from "../../raffleScheduling.js";
import { type Notifier } from "../../notifier.js";
import type { CommandContext } from "../index.js";
import { ensureModerator, isModeratorInteraction } from "../moderator.js";

/** The custom-id namespace the interaction router dispatches confirm/cancel on. */
export const FROMDESIGN_PREFIX = "fromdesign";

/** Build a from-design component custom id: `fromdesign:<action>:<token>`. */
export function buildFromDesignId(action: string, token: string): string {
  return `${FROMDESIGN_PREFIX}:${action}:${token}`;
}

/** Parse a from-design custom id, or null if it isn't one. Tokens may contain hyphens, not colons. */
export function parseFromDesignId(customId: string): { action: string; token: string } | null {
  const parts = customId.split(":");
  if (parts.length < 3 || parts[0] !== FROMDESIGN_PREFIX) {
    return null;
  }
  return { action: parts[1]!, token: parts.slice(2).join(":") };
}

/** Add the `from-design` subcommand to the `/raffle` builder. */
export function addFromDesignSubcommand(builder: SlashCommandBuilder): SlashCommandBuilder {
  builder.addSubcommand((s) =>
    s
      .setName("from-design")
      .setDescription("Create a raffle from a code made in the dashboard's Raffle Designer.")
      .addStringOption((o) =>
        o
          .setName("token")
          .setDescription("The code the dashboard gave you, e.g. gentle-harbor-4821.")
          .setRequired(true),
      ),
  );
  return builder;
}

/** Why a token can't be redeemed by this caller now, or null if it's good. */
function pendingProblem(
  row: PendingRaffleRow | undefined,
  guildId: string,
  userId: string,
  now: string,
): string | null {
  if (!row) {
    return "That code isn't valid. Check it, or compose the raffle again in the dashboard.";
  }
  if (row.guild_id !== guildId) {
    return "That code was made for a different server.";
  }
  if (row.redeemed_at) {
    return "That code has already been used.";
  }
  if (row.staged_by_user_id !== userId) {
    return "That code was made by a different moderator. Ask them to run it, or compose your own in the dashboard.";
  }
  if (row.expires_at < now) {
    return "That code has expired. Compose the raffle again in the dashboard.";
  }
  return null;
}

/** The ephemeral summary lines shown before confirming. */
function summarizeSpec(spec: PendingRaffleSpec, timezone: string | null): string[] {
  const when = (iso: string): string => formatWallClockInZone(iso, timezone);
  const tzLabel = timezone ?? "UTC";
  const lines = [
    `🎟 **${spec.name}** — ${spec.prize}`,
    `Opens **${when(spec.starts_at)}** · closes **${when(spec.ends_at)}** (${tzLabel})`,
    `${spec.winner_count} winner${spec.winner_count === 1 ? "" : "s"} · ${spec.draw_mode === "manual" ? "drawn manually" : "auto-draw at close"}${spec.is_test ? " · 🧪 test raffle" : ""}`,
  ];
  if (spec.open_to_all) {
    lines.push("Eligibility: **open to everyone** in the server");
  } else {
    const bits = [`${spec.req_messages ?? 0} msgs / ${spec.req_days ?? 0} days`];
    if (spec.req_active_days) bits.push(`${spec.req_active_days} active days`);
    if (spec.cooldown_days) bits.push(`${spec.cooldown_days}d win cooldown`);
    lines.push(`Eligibility: ${bits.join(" · ")}`);
  }
  if (spec.exclude_prior_winners) lines.push("Past winners are barred");
  if (spec.claim_window_hours) lines.push(`Winners have ${spec.claim_window_hours}h to claim`);
  return lines;
}

/** The Confirm / Cancel button row, carrying the token. */
function confirmRow(token: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildFromDesignId("confirm", token))
      .setLabel("Create & schedule")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(buildFromDesignId("cancel", token))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );
}

/** Map a staged spec to a raffle-column patch (booleans → 0/1). */
function specToPatch(spec: PendingRaffleSpec): RaffleFieldPatch {
  return {
    name: spec.name,
    description: spec.description,
    prize: spec.prize,
    starts_at: spec.starts_at,
    ends_at: spec.ends_at,
    winner_count: spec.winner_count,
    req_messages: spec.req_messages,
    req_days: spec.req_days,
    req_active_days: spec.req_active_days,
    open_to_all: spec.open_to_all ? 1 : 0,
    exclude_prior_winners: spec.exclude_prior_winners ? 1 : 0,
    cooldown_days: spec.cooldown_days,
    cooldown_count: spec.cooldown_count,
    claim_window_hours: spec.claim_window_hours,
    is_test: spec.is_test ? 1 : 0,
    draw_mode: spec.draw_mode,
  };
}

/** `/raffle from-design <token>`: validate the token and show a confirm summary. */
export async function handleFromDesign(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }
  const now = new Date().toISOString();
  const token = normalizeToken(interaction.options.getString("token", true));
  const row = getPendingRaffle(ctx.db, token);
  const problem = pendingProblem(row, guildId, interaction.user.id, now);
  if (problem) {
    await interaction.reply({ content: problem, flags: MessageFlags.Ephemeral });
    return;
  }
  const spec = parsePendingSpec(row!);
  const timezone = getGuild(ctx.db, guildId)?.timezone ?? null;
  const lines = summarizeSpec(spec, timezone);
  await interaction.reply({
    content: `**Create this raffle from \`${token}\`?**\n${lines.join("\n")}\n\n_Nothing is created until you confirm._`,
    components: [confirmRow(token)],
    flags: MessageFlags.Ephemeral,
  });
}

export interface FromDesignDeps {
  db: Database;
  notifier: Notifier;
}

/** Handle the Confirm / Cancel button: on Confirm, create + schedule the raffle. */
export async function handleFromDesignComponent(
  interaction: ButtonInteraction,
  deps: FromDesignDeps,
): Promise<void> {
  const parsed = parseFromDesignId(interaction.customId);
  if (!parsed) {
    return;
  }
  if (parsed.action === "cancel") {
    await interaction.update({ content: "Cancelled — nothing was created.", components: [] });
    return;
  }
  if (parsed.action !== "confirm") {
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.update({ content: "This can only be used in a server.", components: [] });
    return;
  }
  // Re-authorise at the point of the write, not just when the summary was shown.
  const modRole = getGuild(deps.db, guildId)?.mod_role ?? null;
  if (!isModeratorInteraction(interaction, modRole)) {
    await interaction.update({
      content: "You do not have permission to manage raffles.",
      components: [],
    });
    return;
  }

  const now = new Date().toISOString();
  const row = getPendingRaffle(deps.db, parsed.token);
  const problem = pendingProblem(row, guildId, interaction.user.id, now);
  if (problem) {
    await interaction.update({ content: problem, components: [] });
    return;
  }
  const spec = parsePendingSpec(row!);

  // Create the draft, populate it from the spec, and run the shared scheduling
  // seam (re-validation + live announce-channel check + status flip + audit).
  const raffleId = createDraft(deps.db, guildId, interaction.user.id, now);
  updateRaffleFields(deps.db, raffleId, specToPatch(spec));
  writeAudit(deps.db, {
    guildId,
    raffleId,
    eventType: AUDIT_EVENTS.raffleCreated,
    actorId: interaction.user.id,
    payload: { name: spec.name, from_design: parsed.token },
    createdAt: now,
  });
  const fresh = getRaffle(deps.db, raffleId)!;
  const outcome = confirmAndSchedule(deps.db, deps.notifier, fresh, interaction.guild, interaction.user.id, now);
  if (!outcome.ok) {
    // The draft is kept so the work isn't lost — fixable in Discord like any draft.
    await interaction.update({
      content: `Couldn't schedule it: ${outcome.error}\nSaved as draft #${raffleId} — fix it with \`/raffle edit ${raffleId}\`.`,
      components: [],
    });
    return;
  }
  markPendingRedeemed(deps.db, parsed.token, raffleId, now);
  await interaction.update({
    content: `🎉 **${spec.name}** is scheduled (raffle #${raffleId}). It will open automatically at its start time.`,
    components: [],
  });
}
