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
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
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

export function scheduleModal(raffle: RaffleRow): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(buildWizardId("schedule", "submit", raffle.raffle_id))
    .setTitle("Schedule")
    .addComponents(
      textInput("start", "Starts", { required: true, placeholder: "tomorrow 20:00" }),
      textInput("end", "Ends", { required: true, placeholder: "in 7 days, or 2026-08-01 20:00" }),
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
      textInput("new_member_days", "New-member exemption window in days (optional)", {
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

function anchorSelect(raffle: RaffleRow): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildWizardId("eligibility", "anchor", raffle.raffle_id))
    .setPlaceholder("Activity window anchor")
    .addOptions(
      {
        label: "Before the raffle starts (recommended)",
        value: "start",
        default: raffle.window_anchor === "start",
      },
      {
        label: "Rolling — before each entry",
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
      { label: "Off", value: "off", default: raffle.new_member_exempt !== 1 },
      { label: "On", value: "on", default: raffle.new_member_exempt === 1 },
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function drawModeSelect(raffle: RaffleRow): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildWizardId("draw", "mode", raffle.raffle_id))
    .setPlaceholder("How the draw runs")
    .addOptions(
      { label: "Automatic at close", value: "auto", default: raffle.draw_mode !== "manual" },
      { label: "Manual (a mod triggers it)", value: "manual", default: raffle.draw_mode === "manual" },
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

type MessageRow =
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>;

function rows(...builders: MessageRow[]): Row[] {
  return builders.map((b) => b.toJSON() as Row);
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
        content: "**Step 2 of 5 — Schedule**\nWhen the raffle opens and closes.",
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
            button("eligibility", "next", id, "Next: draw", ButtonStyle.Success),
          ),
          footerRow("eligibility", id),
        ),
      };
    case "draw":
      return {
        content: "**Step 4 of 5 — Draw**\nWinner count, draw mode, and optional cooldown.",
        components: rows(
          drawModeSelect(raffle),
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
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            button("summary", "confirm", id, "Confirm & schedule", ButtonStyle.Success),
            button("summary", "back", id, "Edit a step"),
          ),
          footerRow("summary", id),
        ),
      };
  }
}
