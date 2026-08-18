/**
 * `/raffle record-win <user> <won-at> [note]`.
 *
 * Record a prize a member won *outside* this bot — before it was installed, or
 * in an event run some other way — so it gates their win cooldown and the
 * prior-winner bar exactly like a raffle drawn here (design.md "Imported wins").
 * The migration path for a server adopting the bot with a history already behind
 * it, and the reason `wins` no longer requires a raffle (schema v20).
 *
 * One member per invocation, repeatable, mirroring `/raffle ban` and
 * `/raffle reset`. The undo is `/raffle reset <user> cooldown`, which waives
 * imported wins along with drawn ones.
 *
 * Handler stays thin: gate, parse the date in the guild's timezone, write the
 * win and its audit row in one transaction, mirror a note-free line to the audit
 * channel, and report the cooldown the import actually produced — so a moderator
 * can see the effect rather than trust it.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { AUDIT_EVENTS } from "../../../core/auditEvents.js";
import { winCooldownStatus } from "../../../core/cooldown.js";
import { userMention } from "../../../core/format.js";
import { discordTimestamp } from "../../../core/time.js";
import { parseFriendlyTimeInZone } from "../../../core/timeParse.js";
import { writeAudit } from "../../../db/repositories/audit.js";
import { getGuild } from "../../../db/repositories/guilds.js";
import { countRafflesSince } from "../../../db/repositories/raffles.js";
import { addExternalWin, getUserWins } from "../../../db/repositories/wins.js";
import type { CommandContext } from "../index.js";
import { ensureModerator } from "../moderator.js";

/** Longest note we store, so an accidental paste can't fill the column. */
const MAX_NOTE = 200;

/** Add the record-win subcommand to the `/raffle` builder. */
export function addRecordWinSubcommand(builder: SlashCommandBuilder): SlashCommandBuilder {
  builder.addSubcommand((s) =>
    s
      .setName("record-win")
      .setDescription("Record a prize a member won outside this bot, so it counts toward their cooldown.")
      .addUserOption((o) =>
        o.setName("user").setDescription("The member who won.").setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("won-at")
          .setDescription('When they won, e.g. "2026-06-15" or "3 weeks ago".')
          .setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("note")
          .setDescription("What they won it in — for moderators only, never posted publicly.")
          .setMaxLength(MAX_NOTE),
      ),
  );
  return builder;
}

function reply(interaction: ChatInputCommandInteraction, content: string): Promise<unknown> {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Handle `/raffle record-win`. */
export async function handleRecordWin(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }
  const user = interaction.options.getUser("user", true);
  const rawWonAt = interaction.options.getString("won-at", true);
  const note = interaction.options.getString("note")?.trim() || null;
  const now = new Date().toISOString();
  const guild = getGuild(ctx.db, guildId);

  const parsed = parseFriendlyTimeInZone(rawWonAt, now, guild?.timezone ?? null);
  if (!parsed.ok) {
    await reply(interaction, parsed.error);
    return;
  }
  // A future win date would push the cooldown further out the later it is —
  // silently the wrong shape of mistake, so refuse it rather than store it.
  if (Date.parse(parsed.utcIso) > Date.parse(now)) {
    await reply(
      interaction,
      "That date is in the future. Record a win only after it has happened — the cooldown is measured from the date you give.",
    );
    return;
  }

  const event = {
    guildId,
    raffleId: null,
    eventType: AUDIT_EVENTS.externalWinRecorded,
    actorId: interaction.user.id,
    payload: { userId: user.id, wonAt: parsed.utcIso, note },
    createdAt: now,
  };
  ctx.db.transaction(() => {
    addExternalWin(ctx.db, {
      guildId,
      userId: user.id,
      wonAt: parsed.utcIso,
      note,
    });
    writeAudit(ctx.db, event);
  })();

  // Mirror without the note: it is arbitrary moderator text about a member, and
  // the audit channel is readable by everyone (design.md "Auditability").
  void ctx.notifier.mirrorAudit({ ...event, payload: { userId: user.id, wonAt: parsed.utcIso } });

  await reply(interaction, confirmation(ctx, guildId, user.id, parsed.utcIso, now));
}

/**
 * The ephemeral confirmation, stating the cooldown the import actually produced.
 *
 * Recomputed from the stored wins rather than predicted, so what the moderator
 * reads is what the entry gate will decide. The guild defaults are used, since an
 * import belongs to no raffle — a raffle that overrides the cooldown will differ,
 * which the copy says rather than implies.
 */
function confirmation(
  ctx: CommandContext,
  guildId: string,
  userId: string,
  wonAt: string,
  now: string,
): string {
  const guild = getGuild(ctx.db, guildId);
  const wins = getUserWins(ctx.db, guildId, userId);
  const latestWonAt = wins.reduce<string | null>(
    (latest, w) => (latest === null || w.wonAt > latest ? w.wonAt : latest),
    null,
  );
  const status = winCooldownStatus({
    cooldownDays: guild?.default_cooldown_days ?? null,
    cooldownCount: guild?.default_cooldown_count ?? null,
    wins,
    rafflesSinceLastWin:
      latestWonAt === null ? 0 : countRafflesSince(ctx.db, guildId, latestWonAt),
    now,
  });

  const head = `📥 Recorded a past win for ${userMention(userId)} on ${discordTimestamp(wonAt, "D")}.`;
  if (!status.active) {
    // Either no cooldown is configured, or this win is old enough to have lapsed.
    return `${head} It counts toward their history — but no win cooldown is in effect for them right now.`;
  }
  const parts: string[] = [];
  if (status.endsAt && Date.parse(status.endsAt) > Date.parse(now)) {
    parts.push(`until ${discordTimestamp(status.endsAt, "R")}`);
  }
  if (status.rafflesRemaining && status.rafflesRemaining > 0) {
    parts.push(`for ${status.rafflesRemaining} more raffle(s)`);
  }
  const detail = parts.length ? ` ${parts.join(", ")}` : "";
  return (
    `${head} They're now on a win cooldown${detail}, by the server defaults — ` +
    `a raffle that sets its own cooldown will differ. Undo with \`/raffle reset\` (scope: cooldown).`
  );
}
