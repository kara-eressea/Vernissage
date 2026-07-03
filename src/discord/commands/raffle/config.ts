/**
 * `/raffle config` — guild settings.
 *
 * Subcommands:
 *   - show    : display the current guild config and counted-channel rules.
 *   - set     : write scalar defaults (audit channel, mod role, hourly cap,
 *               cooldowns, minimum account age); a `clear` option unsets one.
 *   - channel : include/exclude a channel from message counting, or clear it.
 *
 * Handlers stay thin: they parse the interaction, run the pure moderator gate
 * and pure validation, call the repositories, write an audit_log row, and
 * format an ephemeral reply. No audit-channel posting happens yet — that seam
 * is issue #9. See design.md "Commands > Moderator" and "Auditability".
 */

import {
  MessageFlags,
  SlashCommandSubcommandGroupBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  CLEARABLE_FIELDS,
  validateCooldownCount,
  validateCooldownDays,
  validateHourlyCap,
  validateMinAccountAge,
  validateReqDays,
  validateReqMessages,
  validateTimezone,
  type ClearableField,
  type ConfigValidation,
} from "../../../core/config.js";
import { writeAudit } from "../../../db/repositories/audit.js";
import {
  listChannelRules,
  removeChannelRule,
  setChannelRule,
} from "../../../db/repositories/countedChannels.js";
import {
  getGuild,
  setGuildConfig,
  type GuildConfigPatch,
} from "../../../db/repositories/guilds.js";
import type { ChannelMode } from "../../../core/types.js";
import type { CommandContext } from "../index.js";
import { ensureModerator } from "../moderator.js";

/** Attach the `config` subcommand group to the shared `/raffle` builder. */
export function addConfigGroup(group: SlashCommandSubcommandGroupBuilder): SlashCommandSubcommandGroupBuilder {
  return group
    .setName("config")
    .setDescription("View or change this server's raffle settings.")
    .addSubcommand((s) =>
      s.setName("show").setDescription("Show the current server configuration."),
    )
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("Set server default settings.")
        .addChannelOption((o) =>
          o.setName("audit-channel").setDescription("Channel that receives audit posts."),
        )
        .addChannelOption((o) =>
          o
            .setName("announce-channel")
            .setDescription("Default channel where raffles are announced."),
        )
        .addRoleOption((o) =>
          o.setName("mod-role").setDescription("Role allowed to manage raffles."),
        )
        .addIntegerOption((o) =>
          o
            .setName("hourly-cap")
            .setDescription("Max counted messages per user per hour.")
            .setMinValue(0),
        )
        .addIntegerOption((o) =>
          o
            .setName("cooldown-days")
            .setDescription("Default days a winner must wait before re-entering.")
            .setMinValue(0),
        )
        .addIntegerOption((o) =>
          o
            .setName("cooldown-count")
            .setDescription("Default number of raffles a winner must skip.")
            .setMinValue(0),
        )
        .addIntegerOption((o) =>
          o
            .setName("min-account-age-days")
            .setDescription("Default minimum Discord account age, in days.")
            .setMinValue(0),
        )
        .addIntegerOption((o) =>
          o
            .setName("req-messages")
            .setDescription("Default messages required to enter (X).")
            .setMinValue(0),
        )
        .addIntegerOption((o) =>
          o
            .setName("req-days")
            .setDescription("Default activity window in days (Y).")
            .setMinValue(1),
        )
        .addStringOption((o) =>
          o
            .setName("timezone")
            .setDescription("IANA timezone for schedule input, e.g. Europe/Copenhagen."),
        )
        .addBooleanOption((o) =>
          o
            .setName("blacklist-generic-message")
            .setDescription("Show a generic failure (not 'blacklisted') to blacklisted members."),
        )
        .addStringOption((o) =>
          o
            .setName("clear")
            .setDescription("Unset a single setting back to its default.")
            .addChoices(
              { name: "audit channel", value: "audit_channel" },
              { name: "announce channel", value: "announce_channel" },
              { name: "mod role", value: "mod_role" },
              { name: "hourly cap", value: "hourly_cap" },
              { name: "cooldown days", value: "default_cooldown_days" },
              { name: "cooldown count", value: "default_cooldown_count" },
              { name: "minimum account age", value: "default_min_account_age_days" },
              { name: "messages required", value: "default_req_messages" },
              { name: "activity window days", value: "default_req_days" },
              { name: "timezone", value: "timezone" },
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("channel")
        .setDescription("Include or exclude a channel from message counting.")
        .addChannelOption((o) =>
          o.setName("channel").setDescription("The channel.").setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("mode")
            .setDescription("Whether to include, exclude, or clear the rule.")
            .setRequired(true)
            .addChoices(
              { name: "include", value: "include" },
              { name: "exclude", value: "exclude" },
              { name: "clear", value: "clear" },
            ),
        ),
    );
}

/** Reply ephemerally; all config replies are private to the invoking mod. */
function reply(interaction: ChatInputCommandInteraction, content: string): Promise<unknown> {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/**
 * Gate every config subcommand behind the shared moderator check, then dispatch.
 */
export async function handleConfig(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  const guildId = await ensureModerator(interaction, ctx.db);
  if (!guildId) {
    return;
  }

  switch (interaction.options.getSubcommand()) {
    case "show":
      await handleConfigShow(interaction, ctx, guildId);
      return;
    case "set":
      await handleConfigSet(interaction, ctx, guildId);
      return;
    case "channel":
      await handleConfigChannel(interaction, ctx, guildId);
      return;
    default:
      await reply(interaction, "Unknown config subcommand.");
  }
}

async function handleConfigShow(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  guildId: string,
): Promise<void> {
  const guild = getGuild(ctx.db, guildId);
  const rules = listChannelRules(ctx.db, guildId);
  const includes = rules.filter((r) => r.mode === "include").map((r) => `<#${r.channelId}>`);
  const excludes = rules.filter((r) => r.mode === "exclude").map((r) => `<#${r.channelId}>`);

  const fmtChannel = (id: string | null | undefined) => (id ? `<#${id}>` : "not set");
  const fmtRole = (id: string | null | undefined) => (id ? `<@&${id}>` : "not set");
  const fmtNum = (n: number | null | undefined, unit = "") =>
    n === null || n === undefined ? "not set" : `${n}${unit}`;

  // Explain counting precedence to match isChannelCounted: an exclude always
  // wins; if any includes exist they form an allowlist; otherwise all
  // non-excluded channels count.
  const countingNote = includes.length
    ? "Only included channels count (excludes still removed)."
    : excludes.length
      ? "All channels count except the excluded ones."
      : "All channels count (no rules set).";

  const lines = [
    "**Server raffle configuration**",
    `- Audit channel: ${fmtChannel(guild?.audit_channel)}`,
    `- Announce channel: ${fmtChannel(guild?.announce_channel)}`,
    `- Mod role: ${fmtRole(guild?.mod_role)}`,
    `- Hourly message cap: ${fmtNum(guild?.hourly_cap)}`,
    `- Default cooldown: ${fmtNum(guild?.default_cooldown_days, " day(s)")} / ${fmtNum(guild?.default_cooldown_count, " raffle(s)")}`,
    `- Default minimum account age: ${fmtNum(guild?.default_min_account_age_days, " day(s)")}`,
    `- Default activity requirement: ${fmtNum(guild?.default_req_messages, " message(s)")} in ${fmtNum(guild?.default_req_days, " day(s)")}`,
    `- Timezone: ${guild?.timezone ?? "not set (UTC)"}`,
    `- Blacklist rejections: ${guild?.blacklist_generic_message === 1 ? "generic message" : "named"}`,
    `- Counted channels — include: ${includes.length ? includes.join(", ") : "none"}`,
    `- Counted channels — exclude: ${excludes.length ? excludes.join(", ") : "none"}`,
    `_${countingNote}_`,
  ];
  await reply(interaction, lines.join("\n"));
}

async function handleConfigSet(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  guildId: string,
): Promise<void> {
  const patch: GuildConfigPatch = {};
  const errors: string[] = [];

  const auditChannel = interaction.options.getChannel("audit-channel");
  if (auditChannel) {
    patch.audit_channel = auditChannel.id;
  }
  const announceChannel = interaction.options.getChannel("announce-channel");
  if (announceChannel) {
    patch.announce_channel = announceChannel.id;
  }
  const modRole = interaction.options.getRole("mod-role");
  if (modRole) {
    patch.mod_role = modRole.id;
  }

  // Restricted to the numeric columns so assigning a validated number typechecks
  // (a plain keyof GuildConfigPatch would collapse to the fields' common type).
  type NumericField =
    | "hourly_cap"
    | "default_cooldown_days"
    | "default_cooldown_count"
    | "default_min_account_age_days"
    | "default_req_messages"
    | "default_req_days";
  const applyInt = (
    optName: string,
    validate: (raw: number) => ConfigValidation,
    column: NumericField,
  ): void => {
    const raw = interaction.options.getInteger(optName);
    if (raw === null) {
      return;
    }
    const result = validate(raw);
    if (result.ok) {
      patch[column] = result.value;
    } else {
      errors.push(result.error);
    }
  };
  applyInt("hourly-cap", validateHourlyCap, "hourly_cap");
  applyInt("cooldown-days", validateCooldownDays, "default_cooldown_days");
  applyInt("cooldown-count", validateCooldownCount, "default_cooldown_count");
  applyInt("min-account-age-days", validateMinAccountAge, "default_min_account_age_days");
  applyInt("req-messages", validateReqMessages, "default_req_messages");
  applyInt("req-days", validateReqDays, "default_req_days");

  const timezone = interaction.options.getString("timezone");
  if (timezone !== null) {
    const result = validateTimezone(timezone);
    if (result.ok) {
      patch.timezone = result.value;
    } else {
      errors.push(result.error);
    }
  }

  const blacklistGeneric = interaction.options.getBoolean("blacklist-generic-message");
  if (blacklistGeneric !== null) {
    patch.blacklist_generic_message = blacklistGeneric ? 1 : 0;
  }

  // A `clear` selection unsets one field to null. Applied last so it wins over
  // a same-field set in the same invocation.
  const clearField = interaction.options.getString("clear") as ClearableField | null;
  if (clearField && (CLEARABLE_FIELDS as readonly string[]).includes(clearField)) {
    patch[clearField] = null;
  }

  if (errors.length > 0) {
    await reply(interaction, errors.join("\n"));
    return;
  }
  if (Object.keys(patch).length === 0) {
    await reply(
      interaction,
      "Nothing to change — provide at least one setting, or a `clear` selection.",
    );
    return;
  }

  const now = new Date().toISOString();
  setGuildConfig(ctx.db, guildId, patch, now);
  writeAudit(ctx.db, {
    guildId,
    raffleId: null,
    eventType: "config_set",
    actorId: interaction.user.id,
    payload: patch,
    createdAt: now,
  });

  await reply(interaction, `Updated ${Object.keys(patch).length} setting(s).`);
}

async function handleConfigChannel(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  guildId: string,
): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);
  const mode = interaction.options.getString("mode", true);
  const now = new Date().toISOString();

  if (mode === "clear") {
    removeChannelRule(ctx.db, guildId, channel.id);
    writeAudit(ctx.db, {
      guildId,
      raffleId: null,
      eventType: "counted_channel_cleared",
      actorId: interaction.user.id,
      payload: { channelId: channel.id },
      createdAt: now,
    });
    await reply(interaction, `Cleared the counting rule for <#${channel.id}>.`);
    return;
  }

  setChannelRule(ctx.db, guildId, channel.id, mode as ChannelMode);
  writeAudit(ctx.db, {
    guildId,
    raffleId: null,
    eventType: "counted_channel_set",
    actorId: interaction.user.id,
    payload: { channelId: channel.id, mode },
    createdAt: now,
  });
  await reply(interaction, `Set <#${channel.id}> to **${mode}** for message counting.`);
}
