/**
 * `/raffle eligible`.
 *
 * A moderator read-out of who would be eligible right now under the server's
 * default entry settings, with no raffle in play — a standing view of the pool
 * a new raffle would draw from. It reuses the same pure `checkEligibility` the
 * entry flow uses, so it can never disagree with the real gate.
 *
 * The report is DB-only: it enumerates members from counted activity, so it
 * needs a default activity requirement to apply and cannot see members who have
 * never sent a counted message. The per-raffle gates (role gates, prior-winner
 * bar, new-member exemption) are not applied — they have no guild default. Full
 * semantics: design.md "Listing the eligible pool".
 *
 * Handler stays thin: gate, read defaults, gather per-user cooldown/blacklist
 * data, call the pure snapshot, format an ephemeral reply. It changes no state,
 * so it writes no audit row.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { snapshotEligibleUsers, type SnapshotCandidate } from "../../../core/eligibilitySnapshot.js";
import { userMention } from "../../../core/format.js";
import { activityWindow } from "../../../core/time.js";
import { listGuildCountsInWindow } from "../../../db/repositories/activity.js";
import { isBlacklisted } from "../../../db/repositories/blacklist.js";
import { getGuild } from "../../../db/repositories/guilds.js";
import { countRafflesSince } from "../../../db/repositories/raffles.js";
import { getUserWins } from "../../../db/repositories/wins.js";
import type { CommandContext } from "../index.js";
import { ensureModerator } from "../moderator.js";

/** Most member mentions to list before summarizing the rest, to stay well under
 * Discord's 2000-char message limit (each mention is ~22 chars). */
const MAX_LISTED = 80;

/** Add the eligible subcommand to the `/raffle` builder. */
export function addEligibleSubcommand(builder: SlashCommandBuilder): SlashCommandBuilder {
  builder.addSubcommand((s) =>
    s
      .setName("eligible")
      .setDescription("List members eligible right now under the server's default settings."),
  );
  return builder;
}

/** Handle `/raffle eligible`. */
export async function handleEligible(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }

  const guild = getGuild(ctx.db, guildId);
  const reqMessages = guild?.default_req_messages ?? 0;
  const reqDays = guild?.default_req_days ?? 0;
  if (reqMessages < 1 || reqDays < 1) {
    await interaction.reply({
      content:
        "Set a default activity requirement first with `/raffle config set req-messages:… req-days:…`. " +
        "This report finds eligible members from counted activity, so it needs a default message/day bar to apply.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = new Date().toISOString();
  const window = activityWindow(now, reqDays);
  const active = listGuildCountsInWindow(ctx.db, guildId, window.startDay, window.endDay);

  const defaults = {
    minAccountAgeDays: guild?.default_min_account_age_days ?? null,
    cooldownDays: guild?.default_cooldown_days ?? null,
    cooldownCount: guild?.default_cooldown_count ?? null,
    reqMessages,
    reqActiveDays: guild?.default_req_active_days ?? 0,
    reqDays,
  };

  const candidates: SnapshotCandidate[] = active.map((u) => {
    const wins = getUserWins(ctx.db, guildId, u.userId);
    const latestWonAt = wins.reduce<string | null>(
      (latest, w) => (latest === null || w.wonAt > latest ? w.wonAt : latest),
      null,
    );
    const rafflesSinceLastWin =
      latestWonAt === null ? 0 : countRafflesSince(ctx.db, guildId, latestWonAt);
    return {
      userId: u.userId,
      dailyCounts: u.counts,
      wins,
      rafflesSinceLastWin,
      blacklisted: isBlacklisted(ctx.db, guildId, u.userId, now),
    };
  });

  const { considered, eligibleUserIds } = snapshotEligibleUsers(candidates, defaults, now);

  await interaction.reply({
    content: formatEligibleReport(eligibleUserIds, considered, defaults),
    flags: MessageFlags.Ephemeral,
    // A read-out only — never ping the members it names.
    allowedMentions: { parse: [] },
  });
}

/** Compact one-line recap of the defaults the snapshot applied. */
function describeDefaults(defaults: {
  minAccountAgeDays: number | null;
  cooldownDays: number | null;
  cooldownCount: number | null;
  reqMessages: number;
  reqActiveDays: number;
  reqDays: number;
}): string {
  const spread =
    defaults.reqActiveDays > 1 ? ` across ${defaults.reqActiveDays} separate days` : "";
  const parts = [`≥${defaults.reqMessages} messages${spread} in ${defaults.reqDays} days`];
  if (defaults.minAccountAgeDays && defaults.minAccountAgeDays > 0) {
    parts.push(`account ≥${defaults.minAccountAgeDays} days old`);
  }
  if (defaults.cooldownDays && defaults.cooldownDays > 0) {
    parts.push(`off a ${defaults.cooldownDays}-day win cooldown`);
  }
  if (defaults.cooldownCount && defaults.cooldownCount > 0) {
    parts.push(`sat out ${defaults.cooldownCount} raffle${defaults.cooldownCount === 1 ? "" : "s"} since a win`);
  }
  return parts.join(", ");
}

/** Format the ephemeral report: headline count, applied defaults, member list. */
function formatEligibleReport(
  eligibleUserIds: string[],
  considered: number,
  defaults: Parameters<typeof describeDefaults>[0],
): string {
  const n = eligibleUserIds.length;
  const header =
    `**${n}** of ${considered} recently-active member${considered === 1 ? "" : "s"} ` +
    `would be eligible right now under the current defaults.`;
  const applied = `Applied: ${describeDefaults(defaults)}. Per-raffle gates (roles, prior-winner bar, new-member exemption) are not included — a specific raffle may differ.`;

  if (n === 0) {
    return `${header}\n${applied}`;
  }

  const listed = eligibleUserIds.slice(0, MAX_LISTED).map(userMention).join(" ");
  const overflow = n - Math.min(n, MAX_LISTED);
  const tail = overflow > 0 ? `\n…and ${overflow} more.` : "";
  return `${header}\n${applied}\n\n${listed}${tail}`;
}
