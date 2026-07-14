/**
 * Raffle-designer spec building and validation (pure).
 *
 * The dashboard's Raffle Designer submits a composed raffle to the bot's
 * authenticated handoff endpoint as raw form values; this module turns that
 * submission into a validated, ready-to-apply `PendingRaffleSpec` (design.md
 * "Raffle Designer handoff"). It is the trust boundary's re-validation: the bot
 * never trusts the client's own normalisation. It converts the wall-clock
 * schedule (typed in the guild's timezone) to UTC exactly as the creation wizard
 * does, resolves eligibility (server defaults vs. custom vs. open-to-everyone),
 * and runs the same `validateDraft` the wizard's Confirm runs.
 *
 * No discord.js or database import — only core time/validation helpers.
 */

import type { RaffleDraftFields } from "./raffleValidation.js";
import { validateDraft } from "./raffleValidation.js";
import { parseFriendlyTimeInZone } from "./timeParse.js";

/**
 * The validated, ready-to-apply raffle fields carried across the handoff. The
 * schedule is UTC-normalised; booleans map to the raffles table's 0/1 columns at
 * redemption. Role gates and the server-wide account-age floor are not part of a
 * designer spec.
 */
export interface PendingRaffleSpec {
  name: string;
  prize: string;
  description: string | null;
  /** UTC ISO. */
  starts_at: string;
  /** UTC ISO. */
  ends_at: string;
  winner_count: number;
  /** "auto" | "manual". */
  draw_mode: string;
  is_test: boolean;
  claim_window_hours: number | null;
  open_to_all: boolean;
  exclude_prior_winners: boolean;
  req_messages: number | null;
  req_days: number | null;
  req_active_days: number | null;
  cooldown_days: number | null;
  cooldown_count: number | null;
}

/** The raw composer values the dashboard submits (untrusted). */
export interface DesignerSubmission {
  name: string;
  prize: string;
  description: string | null;
  /** Wall-clock in the guild timezone, e.g. "2026-07-17T18:00" (datetime-local). */
  start: string;
  end: string;
  winnerCount: number;
  drawMode: string;
  isTest: boolean;
  /** Hours to claim, or null when the claim window is off. */
  claimWindowHours: number | null;
  openToAll: boolean;
  barPastWinners: boolean;
  /** "defaults" applies the guild's saved eligibility; "custom" uses the values below. */
  reqMode: string;
  reqMessages: number;
  reqDays: number;
  reqActiveDays: number;
  cooldownDays: number;
}

/** The guild context the spec resolves against (timezone + saved eligibility). */
export interface DesignerGuildContext {
  timezone: string | null;
  defaultReqMessages: number | null;
  defaultReqDays: number | null;
  defaultReqActiveDays: number | null;
  defaultCooldownDays: number | null;
  defaultCooldownCount: number | null;
}

/** Building a spec either succeeds or fails with a user-facing reason. */
export type BuildSpecResult =
  | { ok: true; spec: PendingRaffleSpec }
  | { ok: false; error: string };

/** Coerce to a finite integer, falling back when the input isn't a number. */
function toInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Normalise a datetime-local value to the minute-precision wall-clock form the
 * timezone parser accepts (`YYYY-MM-DDTHH:MM`). Returns null if it isn't a
 * recognisable date-time (e.g. an empty field).
 */
function normalizeLocalDateTime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}T${m[2]!.padStart(2, "0")}:${m[3]}`;
}

/**
 * Build and validate a `PendingRaffleSpec` from a designer submission. Converts
 * the schedule to UTC using the guild timezone and runs the full wizard
 * validation; returns the spec on success or a friendly error to surface.
 */
export function buildPendingSpec(
  submission: DesignerSubmission,
  guild: DesignerGuildContext,
  now: string,
): BuildSpecResult {
  const startLocal = normalizeLocalDateTime(submission.start);
  if (!startLocal) {
    return { ok: false, error: "Please set a valid opening time." };
  }
  const endLocal = normalizeLocalDateTime(submission.end);
  if (!endLocal) {
    return { ok: false, error: "Please set a valid closing time." };
  }
  const start = parseFriendlyTimeInZone(startLocal, now, guild.timezone);
  if (!start.ok) {
    return { ok: false, error: start.error };
  }
  const end = parseFriendlyTimeInZone(endLocal, now, guild.timezone);
  if (!end.ok) {
    return { ok: false, error: end.error };
  }

  const openToAll = submission.openToAll;
  const useDefaults = submission.reqMode !== "custom";

  // Open-to-everyone waives the activity bar entirely, so its dials are null.
  let reqMessages: number | null = null;
  let reqDays: number | null = null;
  let reqActiveDays: number | null = null;
  let cooldownDays: number | null = null;
  let cooldownCount: number | null = null;
  if (!openToAll) {
    if (useDefaults) {
      reqMessages = guild.defaultReqMessages;
      reqDays = guild.defaultReqDays;
      reqActiveDays = guild.defaultReqActiveDays;
      cooldownDays = guild.defaultCooldownDays;
      cooldownCount = guild.defaultCooldownCount;
    } else {
      reqMessages = toInt(submission.reqMessages, 0);
      reqDays = toInt(submission.reqDays, 0);
      reqActiveDays = toInt(submission.reqActiveDays, 0);
      cooldownDays = toInt(submission.cooldownDays, 0);
      cooldownCount = null;
    }
  }

  const name = submission.name.trim();
  const prize = submission.prize.trim();
  const description = submission.description?.trim() || null;
  const winnerCount = toInt(submission.winnerCount, 1);
  const isTest = submission.isTest;
  const claimWindowHours =
    submission.claimWindowHours === null ? null : toInt(submission.claimWindowHours, 0);

  // Re-validate exactly as the wizard's Confirm does (the pure half; the live
  // announce-channel check happens at redemption in the bot).
  const draftFields: RaffleDraftFields = {
    name: name || null,
    description,
    prize: prize || null,
    starts_at: start.utcIso,
    ends_at: end.utcIso,
    winner_count: winnerCount,
    req_messages: reqMessages,
    req_days: reqDays,
    req_active_days: reqActiveDays,
    open_to_all: openToAll ? 1 : 0,
    exclude_prior_winners: submission.barPastWinners ? 1 : 0,
    required_role_id: null,
    excluded_role_id: null,
    cooldown_days: cooldownDays,
    cooldown_count: cooldownCount,
    claim_window_hours: claimWindowHours,
    is_test: isTest ? 1 : 0,
    draw_mode: submission.drawMode,
  };
  const check = validateDraft(draftFields, now);
  if (!check.ok) {
    return { ok: false, error: check.error };
  }

  return {
    ok: true,
    spec: {
      name,
      prize,
      description,
      starts_at: start.utcIso,
      ends_at: end.utcIso,
      winner_count: winnerCount,
      draw_mode: submission.drawMode,
      is_test: isTest,
      claim_window_hours: claimWindowHours,
      open_to_all: openToAll,
      exclude_prior_winners: submission.barPastWinners,
      req_messages: reqMessages,
      req_days: reqDays,
      req_active_days: reqActiveDays,
      cooldown_days: cooldownDays,
      cooldown_count: cooldownCount,
    },
  };
}
