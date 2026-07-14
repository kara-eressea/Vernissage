/**
 * The raffle-creation wizard: interaction handling.
 *
 * A thin Discord layer over the pure core: every decision (time parsing, per-
 * step validation, defaults resolution, summary text) is delegated to
 * src/core/*, and every collected value is persisted to the draft raffle row so
 * a restart resumes cleanly. This module owns the component/modal dispatch and
 * the ephemeral step navigation. See design.md "Raffle creation wizard".
 */

import {
  MessageFlags,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { Database } from "better-sqlite3";
import { AUDIT_EVENTS } from "../../core/auditEvents.js";
import { describeRaffle } from "../../core/raffleSummary.js";
import {
  resolveRaffleSettings,
  validateBasics,
  validateDraft,
  validateDraw,
  validateEligibility,
  validateSchedule,
  type RaffleDraftFields,
} from "../../core/raffleValidation.js";
import { formatWallClockInZone, parseFriendlyTimeInZone } from "../../core/timeParse.js";
import { getGuild } from "../../db/repositories/guilds.js";
import {
  getRaffle,
  setStatus,
  updateRaffleFields,
  type RaffleRow,
} from "../../db/repositories/raffles.js";
import {
  clearWizardState,
  getWizardState,
  upsertWizardStep,
  type WizardStep,
} from "../../db/repositories/wizardState.js";
import { resolveAnnounceChannelId } from "../../core/announceFormat.js";
import { channelAccessError } from "../channelAccess.js";
import { auditAndMirror, type Notifier } from "../notifier.js";
import { parseWizardId } from "./customId.js";
import {
  basicsModal,
  drawModal,
  eligibilityModal,
  renderStep,
  restrictionsScreen,
  scheduleModal,
  type WizardMessage,
} from "./render.js";

/** A wizard-driving interaction: button, select menu, or modal submit. */
export type WizardInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | RoleSelectMenuInteraction
  | ChannelSelectMenuInteraction
  | ModalSubmitInteraction;

export interface WizardDeps {
  db: Database;
  notifier: Notifier;
}

export interface Wizard {
  /** Open (or resume) the wizard for a draft raffle from a command. */
  start(interaction: ChatInputCommandInteraction, raffleId: number): Promise<void>;
  /** Handle a wizard component/modal interaction. */
  handle(interaction: WizardInteraction): Promise<void>;
}

/** Project a raffle row onto the draft-fields shape the validators consume. */
function toDraftFields(r: RaffleRow): RaffleDraftFields {
  return {
    name: r.name,
    description: r.description,
    prize: r.prize,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    winner_count: r.winner_count,
    req_messages: r.req_messages,
    req_days: r.req_days,
    req_active_days: r.req_active_days,
    open_to_all: r.open_to_all,
    exclude_prior_winners: r.exclude_prior_winners,
    required_role_id: r.required_role_id,
    excluded_role_id: r.excluded_role_id,
    cooldown_days: r.cooldown_days,
    cooldown_count: r.cooldown_count,
    claim_window_hours: r.claim_window_hours,
    is_test: r.is_test,
    draw_mode: r.draw_mode,
  };
}

/** Read an integer from a modal text field: {value} (null if blank) or {error}. */
function intField(
  interaction: ModalSubmitInteraction,
  id: string,
  label: string,
  required: boolean,
): { value: number | null } | { error: string } {
  const raw = interaction.fields.getTextInputValue(id).trim();
  if (raw === "") {
    return required ? { error: `${label} is required.` } : { value: null };
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    return { error: `${label} must be a whole number (got "${raw}").` };
  }
  return { value: n };
}

export function createWizard(deps: WizardDeps): Wizard {
  const { db } = deps;

  /** Render a step, edit-in-place for components/modals, reply for a command. */
  async function respond(
    interaction: WizardInteraction | ChatInputCommandInteraction,
    message: WizardMessage,
  ): Promise<void> {
    const payload = { content: message.content, components: message.components };
    if (interaction.isChatInputCommand()) {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } else if (interaction.isModalSubmit()) {
      if (interaction.isFromMessage()) {
        await interaction.update(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
    } else {
      await interaction.update(payload);
    }
  }

  /** Re-render `step` with a leading error banner. */
  function withError(step: WizardStep, raffle: RaffleRow, error: string): WizardMessage {
    const base = renderStep(step, raffle, summaryLines(raffle));
    return { content: `⚠️ ${error}\n\n${base.content}`, components: base.components };
  }

  /** The summary lines for a raffle, resolving guild defaults. */
  function summaryLines(raffle: RaffleRow): string[] {
    const guild = getGuild(db, raffle.guild_id);
    const settings = resolveRaffleSettings(toDraftFields(raffle), {
      default_cooldown_days: guild?.default_cooldown_days ?? null,
      default_cooldown_count: guild?.default_cooldown_count ?? null,
      default_min_account_age_days: guild?.default_min_account_age_days ?? null,
      default_min_server_age_days: guild?.default_min_server_age_days ?? null,
    });
    return describeRaffle(settings);
  }

  /** Advance to `step`, persist the pointer, and render it. */
  async function goToStep(
    interaction: WizardInteraction,
    raffleId: number,
    step: WizardStep,
  ): Promise<void> {
    upsertWizardStep(db, raffleId, step, new Date().toISOString());
    const raffle = getRaffle(db, raffleId)!;
    await respond(interaction, renderStep(step, raffle, summaryLines(raffle)));
  }

  async function start(
    interaction: ChatInputCommandInteraction,
    raffleId: number,
  ): Promise<void> {
    const raffle = getRaffle(db, raffleId);
    if (!raffle) {
      await interaction.reply({ content: "That draft no longer exists.", flags: MessageFlags.Ephemeral });
      return;
    }
    const step = (getWizardState(db, raffleId)?.step as WizardStep | undefined) ?? "basics";
    await respond(interaction, renderStep(step, raffle, summaryLines(raffle)));
  }

  async function handle(interaction: WizardInteraction): Promise<void> {
    const parsed = parseWizardId(interaction.customId);
    if (!parsed) {
      return;
    }
    const raffle = getRaffle(db, parsed.raffleId);
    if (!raffle) {
      await respond(interaction, { content: "That draft no longer exists.", components: [] });
      return;
    }

    // Actions available on every step's footer.
    if (parsed.action === "cancel") {
      clearWizardState(db, parsed.raffleId);
      await respond(interaction, {
        content: "Cancelled. The draft was left untouched — resume any time with `/raffle edit`.",
        components: [],
      });
      return;
    }
    if (parsed.action === "savedraft") {
      await respond(interaction, {
        content: "Saved as a draft. Resume with `/raffle edit`; nothing is published until you confirm.",
        components: [],
      });
      return;
    }

    switch (parsed.step) {
      case "basics":
        return handleBasics(interaction, raffle, parsed.action);
      case "schedule":
        return handleSchedule(interaction, raffle, parsed.action);
      case "eligibility":
        return handleEligibility(interaction, raffle, parsed.action);
      case "draw":
        return handleDraw(interaction, raffle, parsed.action);
      case "summary":
        return handleSummary(interaction, raffle, parsed.action);
    }
  }

  async function handleBasics(
    interaction: WizardInteraction,
    raffle: RaffleRow,
    action: string,
  ): Promise<void> {
    if (action === "open" && interaction.isButton()) {
      await interaction.showModal(basicsModal(raffle));
      return;
    }
    if (action === "submit" && interaction.isModalSubmit()) {
      const name = interaction.fields.getTextInputValue("name").trim();
      const prize = interaction.fields.getTextInputValue("prize").trim();
      const description = interaction.fields.getTextInputValue("description").trim() || null;
      const check = validateBasics({ name, prize });
      if (!check.ok) {
        await respond(interaction, withError("basics", raffle, check.error));
        return;
      }
      updateRaffleFields(db, raffle.raffle_id, { name, prize, description });
      await goToStep(interaction, raffle.raffle_id, "schedule");
    }
  }

  async function handleSchedule(
    interaction: WizardInteraction,
    raffle: RaffleRow,
    action: string,
  ): Promise<void> {
    if (action === "open" && interaction.isButton()) {
      const timeZone = getGuild(db, raffle.guild_id)?.timezone ?? null;
      await interaction.showModal(
        scheduleModal(raffle, {
          start: raffle.starts_at ? formatWallClockInZone(raffle.starts_at, timeZone) : null,
          end: raffle.ends_at ? formatWallClockInZone(raffle.ends_at, timeZone) : null,
        }),
      );
      return;
    }
    if (action === "submit" && interaction.isModalSubmit()) {
      const now = new Date().toISOString();
      // Interpret wall-clock input in the guild's configured timezone (if any),
      // so "tomorrow 20:00" means the mods' local 20:00, not 20:00 UTC.
      const timeZone = getGuild(db, raffle.guild_id)?.timezone ?? null;
      const startText = interaction.fields.getTextInputValue("start");
      const endText = interaction.fields.getTextInputValue("end");
      const start = parseFriendlyTimeInZone(startText, now, timeZone);
      if (!start.ok) {
        await respond(interaction, withError("schedule", raffle, start.error));
        return;
      }
      const end = parseFriendlyTimeInZone(endText, now, timeZone);
      if (!end.ok) {
        await respond(interaction, withError("schedule", raffle, end.error));
        return;
      }
      const check = validateSchedule(start.utcIso, end.utcIso, now);
      if (!check.ok) {
        await respond(interaction, withError("schedule", raffle, check.error));
        return;
      }
      updateRaffleFields(db, raffle.raffle_id, { starts_at: start.utcIso, ends_at: end.utcIso });
      await goToStep(interaction, raffle.raffle_id, "eligibility");
    }
  }

  async function handleEligibility(
    interaction: WizardInteraction,
    raffle: RaffleRow,
    action: string,
  ): Promise<void> {
    const id = raffle.raffle_id;
    if (action === "opentoall" && interaction.isStringSelectMenu()) {
      updateRaffleFields(db, id, { open_to_all: interaction.values[0] === "on" ? 1 : 0 });
      return rerender(interaction, id, "eligibility");
    }
    if (action === "nums" && interaction.isButton()) {
      await interaction.showModal(eligibilityModal(raffle));
      return;
    }
    if (action === "numsubmit" && interaction.isModalSubmit()) {
      const x = intField(interaction, "req_messages", "Messages required", true);
      const y = intField(interaction, "req_days", "Activity window (days)", true);
      const k = intField(interaction, "req_active_days", "Active days", false);
      const bad = [x, y, k].find((f) => "error" in f);
      if (bad && "error" in bad) {
        await respond(interaction, withError("eligibility", raffle, bad.error));
        return;
      }
      updateRaffleFields(db, id, {
        req_messages: (x as { value: number | null }).value,
        req_days: (y as { value: number | null }).value,
        req_active_days: (k as { value: number | null }).value,
      });
      return rerender(interaction, id, "eligibility");
    }
    if (action === "defaults" && interaction.isButton()) {
      applyEligibilityDefaults(raffle);
      return rerender(interaction, id, "eligibility");
    }
    // The "More restrictions…" sub-screen: prior-winner + role gates. These live
    // off the main step (Discord caps a message at five component rows), so they
    // re-render the sub-screen rather than the step.
    if (action === "more" && interaction.isButton()) {
      await respond(interaction, restrictionsScreen(raffle));
      return;
    }
    if (action === "priorwin" && interaction.isStringSelectMenu()) {
      updateRaffleFields(db, id, { exclude_prior_winners: interaction.values[0] === "on" ? 1 : 0 });
      return rerenderRestrictions(interaction, id);
    }
    if (action === "reqrole" && interaction.isRoleSelectMenu()) {
      // Empty selection clears the gate.
      updateRaffleFields(db, id, { required_role_id: interaction.values[0] ?? null });
      return rerenderRestrictions(interaction, id);
    }
    if (action === "exclrole" && interaction.isRoleSelectMenu()) {
      updateRaffleFields(db, id, { excluded_role_id: interaction.values[0] ?? null });
      return rerenderRestrictions(interaction, id);
    }
    if (action === "back" && interaction.isButton()) {
      return rerender(interaction, id, "eligibility");
    }
    if (action === "next" && interaction.isButton()) {
      const fresh = getRaffle(db, id)!;
      const check = validateEligibility(toDraftFields(fresh));
      if (!check.ok) {
        await respond(interaction, withError("eligibility", fresh, check.error));
        return;
      }
      await goToStep(interaction, id, "draw");
    }
  }

  async function handleDraw(
    interaction: WizardInteraction,
    raffle: RaffleRow,
    action: string,
  ): Promise<void> {
    const id = raffle.raffle_id;
    if (action === "mode" && interaction.isStringSelectMenu()) {
      updateRaffleFields(db, id, { draw_mode: interaction.values[0] });
      return rerender(interaction, id, "draw");
    }
    if (action === "test" && interaction.isStringSelectMenu()) {
      updateRaffleFields(db, id, { is_test: interaction.values[0] === "on" ? 1 : 0 });
      return rerender(interaction, id, "draw");
    }
    if (action === "nums" && interaction.isButton()) {
      await interaction.showModal(drawModal(raffle));
      return;
    }
    if (action === "numsubmit" && interaction.isModalSubmit()) {
      const winners = intField(interaction, "winner_count", "Number of winners", true);
      const cdDays = intField(interaction, "cooldown_days", "Cooldown days", false);
      const cdCount = intField(interaction, "cooldown_count", "Cooldown raffles", false);
      const claim = intField(interaction, "claim_window_hours", "Claim window (hours)", false);
      const bad = [winners, cdDays, cdCount, claim].find((f) => "error" in f);
      if (bad && "error" in bad) {
        await respond(interaction, withError("draw", raffle, bad.error));
        return;
      }
      updateRaffleFields(db, id, {
        // winner_count is required, so its value is a number once past the check.
        winner_count: (winners as { value: number }).value,
        cooldown_days: (cdDays as { value: number | null }).value,
        cooldown_count: (cdCount as { value: number | null }).value,
        claim_window_hours: (claim as { value: number | null }).value,
      });
      return rerender(interaction, id, "draw");
    }
    if (action === "defaults" && interaction.isButton()) {
      applyDrawDefaults(raffle);
      return rerender(interaction, id, "draw");
    }
    if (action === "next" && interaction.isButton()) {
      const fresh = getRaffle(db, id)!;
      const check = validateDraw(toDraftFields(fresh));
      if (!check.ok) {
        await respond(interaction, withError("draw", fresh, check.error));
        return;
      }
      await goToStep(interaction, id, "summary");
    }
  }

  async function handleSummary(
    interaction: WizardInteraction,
    raffle: RaffleRow,
    action: string,
  ): Promise<void> {
    const id = raffle.raffle_id;
    if (action === "channel" && interaction.isChannelSelectMenu()) {
      // Reject a channel the bot cannot post in up front — otherwise the
      // failure surfaces only when the raffle opens invisibly (issue #3's
      // pattern). Empty selection clears the per-raffle override (falls back
      // to the guild default announce channel at post time).
      const error = channelAccessError(
        interaction.guild?.members?.me,
        interaction.channels.first(),
        "announce",
      );
      if (error) {
        await respond(interaction, withError("summary", raffle, error));
        return;
      }
      updateRaffleFields(db, id, { channel_id: interaction.values[0] ?? null });
      return rerender(interaction, id, "summary");
    }
    if (action === "back" && interaction.isButton()) {
      await goToStep(interaction, id, "basics");
      return;
    }
    if (action === "confirm" && interaction.isButton()) {
      const now = new Date().toISOString();
      const fresh = getRaffle(db, id)!;
      const check = validateDraft(toDraftFields(fresh), now);
      if (!check.ok) {
        await respond(interaction, withError("summary", fresh, check.error));
        return;
      }
      // The raffle needs somewhere to announce itself, and the bot must be
      // able to post there — otherwise it opens with no entry message and
      // nobody can enter. Checked here (not in the pure validator) because it
      // reads guild config and live channel permissions.
      const announceChannelId = resolveAnnounceChannelId(
        fresh.channel_id,
        getGuild(db, fresh.guild_id)?.announce_channel ?? null,
      );
      if (!announceChannelId) {
        await respond(
          interaction,
          withError(
            "summary",
            fresh,
            "There is no channel to announce this raffle in. Pick one below, or set a server default with /raffle config set announce-channel.",
          ),
        );
        return;
      }
      const accessError = channelAccessError(
        interaction.guild?.members?.me,
        interaction.guild?.channels?.cache?.get(announceChannelId),
        "announce",
      );
      if (accessError) {
        await respond(interaction, withError("summary", fresh, accessError));
        return;
      }
      setStatus(db, id, "scheduled");
      auditAndMirror(db, deps.notifier, {
        guildId: fresh.guild_id,
        raffleId: id,
        eventType: AUDIT_EVENTS.raffleScheduled,
        actorId: interaction.user.id,
        payload: { name: fresh.name },
        createdAt: now,
      });
      clearWizardState(db, id);
      await respond(interaction, {
        content: `🎉 **${fresh.name}** is scheduled. It will open automatically at its start time.`,
        components: [],
      });
    }
  }

  /** Reload the raffle and re-render the current step in place. */
  async function rerender(
    interaction: WizardInteraction,
    raffleId: number,
    step: WizardStep,
  ): Promise<void> {
    const raffle = getRaffle(db, raffleId)!;
    await respond(interaction, renderStep(step, raffle, summaryLines(raffle)));
  }

  /** Reload the raffle and re-render the eligibility restrictions sub-screen. */
  async function rerenderRestrictions(
    interaction: WizardInteraction,
    raffleId: number,
  ): Promise<void> {
    const raffle = getRaffle(db, raffleId)!;
    await respond(interaction, restrictionsScreen(raffle));
  }

  /** "Use defaults" for eligibility: fill only the still-unset fields. */
  function applyEligibilityDefaults(raffle: RaffleRow): void {
    const guild = getGuild(db, raffle.guild_id);
    updateRaffleFields(db, raffle.raffle_id, {
      req_messages: raffle.req_messages ?? guild?.default_req_messages ?? null,
      req_days: raffle.req_days ?? guild?.default_req_days ?? null,
      req_active_days: raffle.req_active_days ?? guild?.default_req_active_days ?? null,
    });
  }

  /** "Use defaults" for the draw step: fill only the still-unset fields. */
  function applyDrawDefaults(raffle: RaffleRow): void {
    const guild = getGuild(db, raffle.guild_id);
    updateRaffleFields(db, raffle.raffle_id, {
      winner_count: raffle.winner_count ?? 1,
      draw_mode: raffle.draw_mode ?? "auto",
      cooldown_days: raffle.cooldown_days ?? guild?.default_cooldown_days ?? null,
      cooldown_count: raffle.cooldown_count ?? guild?.default_cooldown_count ?? null,
    });
  }

  return { start, handle };
}
