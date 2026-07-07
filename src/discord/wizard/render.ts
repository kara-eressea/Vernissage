/**
 * Wizard UI builders (discord.js component/modal construction).
 *
 * Pure-ish view layer: given a draft raffle's current values it builds the
 * modals and the per-step ephemeral message (buttons + select menus). All
 * wording that is business logic (the summary, eligibility phrasing) comes from
 * the core formatters; this module only assembles Discord builders.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { discordTimestamp } from "../../core/time.js";
import type { RaffleRow } from "../../db/repositories/raffles.js";
import type { WizardStep } from "../../db/repositories/wizardState.js";
import { buildWizardId } from "./customId.js";

/** The JSON action-row shape accepted by message reply/update `components`. */
type Row = ReturnType<ActionRowBuilder<ButtonBuilder>["toJSON"]>;

export interface WizardMessage {
  content: string;
  components: Row[];
}

function textInput(
  id: string,
  label: string,
  opts: {
    required?: boolean;
    value?: string | number | null;
    paragraph?: boolean;
    placeholder?: string;
  } = {},
): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(opts.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(opts.required ?? false);
  if (opts.value != null) input.setValue(String(opts.value));
  if (opts.placeholder) input.setPlaceholder(opts.placeholder);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

export function basicsModal(raffle: RaffleRow): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(buildWizardId("basics", "submit", raffle.raffle_id))
    .setTitle("Raffle basics")
    .addComponents(
      textInput("name", "Name", { required: true, value: raffle.name }),
      textInput("prize", "Prize", { required: true, value: raffle.prize }),
      textInput("description", "Description (optional)", {
        paragraph: true,
        value: raffle.description,
      }),
    );
}

/**
 * The schedule modal. `prefill` carries any already-saved times rendered as
 * guild-local "YYYY-MM-DD HH:MM" wall-clock text (see formatWallClockInZone),
 * so revisiting the step shows the stored schedule instead of blank required
 * fields that read as forgotten.
 */
export function scheduleModal(
  raffle: RaffleRow,
  prefill: { start: string | null; end: string | null } = { start: null, end: null },
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(buildWizardId("schedule", "submit", raffle.raffle_id))
    .setTitle("Schedule")
    .addComponents(
      textInput("start", "Starts", {
        required: true,
        value: prefill.start,
        placeholder: "tomorrow 20:00",
      }),
      textInput("end", "Ends", {
        required: true,
        value: prefill.end,
        placeholder: "in 7 days, or 2026-08-01 20:00",
      }),
    );
}

export function eligibilityModal(raffle: RaffleRow): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(buildWizardId("eligibility", "numsubmit", raffle.raffle_id))
    .setTitle("Activity requirement")
    .addComponents(
      textInput("req_messages", "Messages required (X)", {
        required: true,
        value: raffle.req_messages,
        placeholder: "20",
      }),
      textInput("req_days", "Over how many days (Y)", {
        required: true,
        value: raffle.req_days,
        placeholder: "14",
      }),
      textInput("min_account_age_days", "Min account age in days (optional)", {
        value: raffle.min_account_age_days,
      }),
      // Discord caps text-input labels at 45 characters; keep these short.
      textInput("new_member_days", "New-member exemption in days (optional)", {
        value: raffle.new_member_days,
      }),
    );
}

export function drawModal(raffle: RaffleRow): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(buildWizardId("draw", "numsubmit", raffle.raffle_id))
    .setTitle("Draw settings")
    .addComponents(
      textInput("winner_count", "Number of winners", {
        required: true,
        value: raffle.winner_count,
        placeholder: "1",
      }),
      textInput("cooldown_days", "Winner cooldown in days (optional)", {
        value: raffle.cooldown_days,
      }),
      textInput("cooldown_count", "Winner cooldown in raffles (optional)", {
        value: raffle.cooldown_count,
      }),
      textInput("claim_window_hours", "Claim window in hours (optional)", {
        value: raffle.claim_window_hours,
        placeholder: "24",
      }),
    );
}

function button(
  step: string,
  action: string,
  raffleId: number,
  label: string,
  style: ButtonStyle = ButtonStyle.Secondary,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(buildWizardId(step, action, raffleId))
    .setLabel(label)
    .setStyle(style);
}

/** The Save-as-draft / Cancel footer present on every step. */
function footerRow(step: WizardStep, raffleId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(step, "savedraft", raffleId, "Save as draft"),
    button(step, "cancel", raffleId, "Cancel", ButtonStyle.Danger),
  );
}

// These select menus arrive with the raffle's current value pre-selected, and
// Discord then shows only the chosen option's label — the placeholder naming
// the setting is never visible. So every option label leads with its topic
// ("Activity window: …") to stay self-describing, and the description (shown in
// the open dropdown) explains what picking it means. Labels and descriptions
// cap at 100 characters.

function anchorSelect(raffle: RaffleRow): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildWizardId("eligibility", "anchor", raffle.raffle_id))
    .setPlaceholder("Activity window anchor")
    .addOptions(
      {
        label: "Activity window: before the raffle starts",
        description: "Recommended — everyone is judged on the same window; activity after opening doesn't count.",
        value: "start",
        default: raffle.window_anchor === "start",
      },
      {
        label: "Activity window: rolling, before each entry",
        description: "The window is measured back from the moment each member enters.",
        value: "rolling",
        default: raffle.window_anchor === "rolling",
      },
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function exemptSelect(raffle: RaffleRow): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildWizardId("eligibility", "exempt", raffle.raffle_id))
    .setPlaceholder("New-member exemption")
    .addOptions(
      {
        label: "New-member exemption: off",
        description: "Everyone must meet the activity requirement.",
        value: "off",
        default: raffle.new_member_exempt !== 1,
      },
      {
        label: "New-member exemption: on",
        description: "Members who joined within the exemption window skip the activity requirement.",
        value: "on",
        default: raffle.new_member_exempt === 1,
      },
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function priorWinnersSelect(raffle: RaffleRow): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildWizardId("eligibility", "priorwin", raffle.raffle_id))
    .setPlaceholder("Past winners")
    .addOptions(
      {
        label: "Past winners: may enter",
        description: "Anyone eligible may enter, even if they have won here before.",
        value: "off",
        default: raffle.exclude_prior_winners !== 1,
      },
      {
        label: "Past winners: barred",
        description: "Members who have ever won a raffle here cannot enter this one.",
        value: "on",
        default: raffle.exclude_prior_winners === 1,
      },
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function requiredRoleSelect(raffle: RaffleRow): ActionRowBuilder<RoleSelectMenuBuilder> {
  const menu = new RoleSelectMenuBuilder()
    .setCustomId(buildWizardId("eligibility", "reqrole", raffle.raffle_id))
    .setPlaceholder("Require a role to enter (optional)")
    .setMinValues(0)
    .setMaxValues(1);
  if (raffle.required_role_id) {
    menu.setDefaultRoles(raffle.required_role_id);
  }
  return new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu);
}

function excludedRoleSelect(raffle: RaffleRow): ActionRowBuilder<RoleSelectMenuBuilder> {
  const menu = new RoleSelectMenuBuilder()
    .setCustomId(buildWizardId("eligibility", "exclrole", raffle.raffle_id))
    .setPlaceholder("Bar a role from entering (optional)")
    .setMinValues(0)
    .setMaxValues(1);
  if (raffle.excluded_role_id) {
    menu.setDefaultRoles(raffle.excluded_role_id);
  }
  return new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu);
}

function announceChannelSelect(raffle: RaffleRow): ActionRowBuilder<ChannelSelectMenuBuilder> {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(buildWizardId("summary", "channel", raffle.raffle_id))
    .setPlaceholder("Announce in… (defaults to the server's announce channel)")
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(0)
    .setMaxValues(1);
  if (raffle.channel_id) {
    menu.setDefaultChannels(raffle.channel_id);
  }
  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu);
}

function testSelect(raffle: RaffleRow): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildWizardId("draw", "test", raffle.raffle_id))
    .setPlaceholder("Prize mode")
    .addOptions(
      {
        label: "Prize mode: real raffle",
        description: "A prize is awarded; the win counts toward cooldowns and the prior-winner bar.",
        value: "off",
        default: raffle.is_test !== 1,
      },
      {
        label: "Prize mode: test raffle",
        description: "No prize; the result does not affect anyone's future eligibility.",
        value: "on",
        default: raffle.is_test === 1,
      },
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function drawModeSelect(raffle: RaffleRow): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildWizardId("draw", "mode", raffle.raffle_id))
    .setPlaceholder("How the draw runs")
    .addOptions(
      {
        label: "Draw: automatic at close",
        description: "Winners are drawn the moment the raffle's end time passes.",
        value: "auto",
        default: raffle.draw_mode !== "manual",
      },
      {
        label: "Draw: manual",
        description: "The raffle closes, then waits for a mod to run /raffle draw.",
        value: "manual",
        default: raffle.draw_mode === "manual",
      },
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

type MessageRow =
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>
  | ActionRowBuilder<RoleSelectMenuBuilder>
  | ActionRowBuilder<ChannelSelectMenuBuilder>;

function rows(...builders: MessageRow[]): Row[] {
  return builders.map((b) => b.toJSON() as Row);
}

/**
 * The eligibility step's "More restrictions…" sub-screen: optional gates that
 * don't fit the main step's rows — bar past winners, and require or exclude a
 * role. All default to off/unset. "Back" returns to the eligibility step.
 */
export function restrictionsScreen(raffle: RaffleRow): WizardMessage {
  const id = raffle.raffle_id;
  return {
    content:
      "**Extra restrictions** (all optional)\n" +
      "Bar past winners, and require or exclude a role. The raffle's creator is always barred from their own raffle.",
    components: rows(
      priorWinnersSelect(raffle),
      requiredRoleSelect(raffle),
      excludedRoleSelect(raffle),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("eligibility", "back", id, "Back to eligibility", ButtonStyle.Primary),
      ),
      footerRow("eligibility", id),
    ),
  };
}

/**
 * Build the ephemeral message for a given wizard step, reflecting the draft's
 * current values. Modals are opened via the step's buttons.
 */
export function renderStep(step: WizardStep, raffle: RaffleRow, summaryLines?: string[]): WizardMessage {
  const id = raffle.raffle_id;
  switch (step) {
    case "basics":
      return {
        content: "**Step 1 of 5 — Basics**\nName, prize, and an optional description.",
        components: rows(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            button("basics", "open", id, "Enter basics", ButtonStyle.Primary),
          ),
          footerRow("basics", id),
        ),
      };
    case "schedule":
      return {
        // Echo any saved times as Discord timestamps (rendered in each
        // viewer's local time) so a timezone mistake is visible at a glance.
        content:
          "**Step 2 of 5 — Schedule**\nWhen the raffle opens and closes." +
          (raffle.starts_at && raffle.ends_at
            ? `\nCurrently: opens ${discordTimestamp(raffle.starts_at)}, closes ${discordTimestamp(raffle.ends_at)}.`
            : ""),
        components: rows(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            button("schedule", "open", id, "Set schedule", ButtonStyle.Primary),
          ),
          footerRow("schedule", id),
        ),
      };
    case "eligibility":
      return {
        content: "**Step 3 of 5 — Eligibility**\nWho can enter. Set the activity numbers, or use guild defaults.",
        components: rows(
          anchorSelect(raffle),
          exemptSelect(raffle),
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            button("eligibility", "nums", id, "Set activity numbers", ButtonStyle.Primary),
            button("eligibility", "defaults", id, "Use defaults"),
            button("eligibility", "more", id, "More restrictions…"),
            button("eligibility", "next", id, "Next: draw", ButtonStyle.Success),
          ),
          footerRow("eligibility", id),
        ),
      };
    case "draw":
      return {
        content:
          "**Step 4 of 5 — Draw**\nWinner count, draw mode, optional cooldown, and whether this is a test raffle.",
        components: rows(
          drawModeSelect(raffle),
          testSelect(raffle),
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            button("draw", "nums", id, "Set winners & cooldown", ButtonStyle.Primary),
            button("draw", "defaults", id, "Use defaults"),
            button("draw", "next", id, "Review summary", ButtonStyle.Success),
          ),
          footerRow("draw", id),
        ),
      };
    case "summary":
      return {
        content: `**Step 5 of 5 — Summary**\n${(summaryLines ?? []).join("\n")}`,
        components: rows(
          announceChannelSelect(raffle),
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            button("summary", "confirm", id, "Confirm & schedule", ButtonStyle.Success),
            button("summary", "back", id, "Edit a step"),
          ),
          footerRow("summary", id),
        ),
      };
  }
}
