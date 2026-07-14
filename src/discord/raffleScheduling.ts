/**
 * The shared "schedule a validated draft" seam.
 *
 * Turning a fully-composed draft raffle into a `scheduled` one is the same set of
 * checks regardless of how the draft was built: full re-validation, resolving the
 * announce channel and confirming the bot can post there (a live-permission check
 * that can't live in the pure validator), the status flip, the audit row, and
 * wizard-state cleanup. Both the creation wizard's Confirm button and the
 * dashboard's `/raffle from-design` redemption call this, so the two paths
 * schedule a raffle identically (design.md "Raffle creation wizard", "Raffle
 * Designer handoff").
 *
 * It returns an outcome rather than replying, so each caller renders success or
 * the error string in its own idiom.
 */

import type { Database } from "better-sqlite3";
import type { Guild } from "discord.js";
import { resolveAnnounceChannelId } from "../core/announceFormat.js";
import { AUDIT_EVENTS } from "../core/auditEvents.js";
import { validateDraft, type RaffleDraftFields } from "../core/raffleValidation.js";
import { getGuild } from "../db/repositories/guilds.js";
import { setStatus, type RaffleRow } from "../db/repositories/raffles.js";
import { clearWizardState } from "../db/repositories/wizardState.js";
import { channelAccessError } from "./channelAccess.js";
import { auditAndMirror, type Notifier } from "./notifier.js";

/** Project a raffle row onto the draft-fields shape the validators consume. */
export function toDraftFields(r: RaffleRow): RaffleDraftFields {
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

/** Whether the draft became scheduled, or why it couldn't. */
export type ScheduleOutcome = { ok: true } | { ok: false; error: string };

/**
 * Re-validate a draft raffle and, if it passes and its announce channel is
 * postable, flip it to `scheduled`, audit it, and clear any wizard state. The
 * channel checks read live Discord state, so `guild` must be the interaction's
 * guild. Writes nothing on failure.
 */
export function confirmAndSchedule(
  db: Database,
  notifier: Notifier,
  raffle: RaffleRow,
  guild: Guild | null | undefined,
  actorId: string,
  now: string,
): ScheduleOutcome {
  const id = raffle.raffle_id;
  const check = validateDraft(toDraftFields(raffle), now);
  if (!check.ok) {
    return { ok: false, error: check.error };
  }
  // The raffle needs somewhere to announce itself, and the bot must be able to
  // post there — otherwise it opens with no entry message and nobody can enter.
  // Checked here (not in the pure validator) because it reads guild config and
  // live channel permissions.
  const announceChannelId = resolveAnnounceChannelId(
    raffle.channel_id,
    getGuild(db, raffle.guild_id)?.announce_channel ?? null,
  );
  if (!announceChannelId) {
    return {
      ok: false,
      error:
        "There is no channel to announce this raffle in. Pick one below, or set a server default with /raffle config set announce-channel.",
    };
  }
  const accessError = channelAccessError(
    guild?.members?.me,
    guild?.channels?.cache?.get(announceChannelId),
    "announce",
  );
  if (accessError) {
    return { ok: false, error: accessError };
  }
  setStatus(db, id, "scheduled");
  auditAndMirror(db, notifier, {
    guildId: raffle.guild_id,
    raffleId: id,
    eventType: AUDIT_EVENTS.raffleScheduled,
    actorId,
    payload: { name: raffle.name },
    createdAt: now,
  });
  clearWizardState(db, id);
  return { ok: true };
}
