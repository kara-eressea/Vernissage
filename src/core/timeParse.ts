/**
 * Friendly time parsing (pure).
 *
 * The schedule step of the creation wizard accepts human input ("tomorrow
 * 20:00", "in 3 days", "2026-08-01 20:00") and resolves it to a UTC ISO
 * timestamp for storage. Wall-clock inputs are interpreted in the moderator's
 * timezone, expressed as `tzOffsetMinutes` (minutes east of UTC, e.g. +120 for
 * CEST); the default of 0 means UTC. The Discord layer echoes the parsed time
 * back with `<t:epoch:F>` markup so the mod can verify it before confirming
 * (see design.md "Time handling").
 *
 * No discord.js/database import — fully unit-testable.
 */

import { addDays } from "./time.js";

export type ParseResult =
  | { ok: true; utcIso: string }
  | { ok: false; error: string };

const MS_PER = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
} as const;

const REL = /^in\s+(\d+)\s+(minute|hour|day|week)s?$/i;
const DAY_REL = /^(today|tomorrow)\s+(\d{1,2}):(\d{2})$/i;
const ABS_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/;
const ABS_DATE = /^(\d{4}-\d{2}-\d{2})$/;
const HAS_TZ = /(Z|[+-]\d{2}:?\d{2})$/;

function fromEpoch(ms: number): ParseResult {
  if (!Number.isFinite(ms)) {
    return { ok: false, error: "That time could not be understood." };
  }
  return { ok: true, utcIso: new Date(ms).toISOString() };
}

/** Validate an HH:MM pair; returns null if out of range. */
function timeParts(h: string, m: string): { h: number; m: number } | null {
  const hour = Number(h);
  const minute = Number(m);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { h: hour, m: minute };
}

/**
 * Parse `input` to a UTC ISO timestamp, interpreting wall-clock forms in the
 * `tzOffsetMinutes` timezone. Returns a friendly error for anything unrecognized
 * or out of range. Does not enforce future-vs-past — that is the schedule
 * validator's job.
 */
export function parseFriendlyTime(
  input: string,
  nowUtc: string,
  tzOffsetMinutes = 0,
): ParseResult {
  const text = input.trim();
  if (text === "") {
    return { ok: false, error: "Please enter a time." };
  }
  const nowMs = Date.parse(nowUtc);
  if (Number.isNaN(nowMs)) {
    throw new RangeError(`Invalid nowUtc: ${nowUtc}`);
  }
  const tzMs = tzOffsetMinutes * MS_PER.minute;

  // "in N minutes/hours/days/weeks" — relative to now.
  const rel = REL.exec(text);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2]!.toLowerCase() as keyof typeof MS_PER;
    return fromEpoch(nowMs + amount * MS_PER[unit]);
  }

  // "today HH:MM" / "tomorrow HH:MM" — relative to the mod's local calendar day.
  const dayRel = DAY_REL.exec(text);
  if (dayRel) {
    const parts = timeParts(dayRel[2]!, dayRel[3]!);
    if (!parts) {
      return { ok: false, error: "That time of day is out of range (use 00:00–23:59)." };
    }
    const localDay = new Date(nowMs + tzMs).toISOString().slice(0, 10);
    const targetDay = /tomorrow/i.test(dayRel[1]!) ? addDays(localDay, 1) : localDay;
    const wallMs = Date.parse(
      `${targetDay}T${String(parts.h).padStart(2, "0")}:${String(parts.m).padStart(2, "0")}:00.000Z`,
    );
    return fromEpoch(wallMs - tzMs);
  }

  // Absolute "YYYY-MM-DD HH:MM" (or with a T) — a wall-clock time in the tz.
  const absDt = ABS_DATETIME.exec(text);
  if (absDt) {
    const parts = timeParts(absDt[2]!, absDt[3]!);
    if (!parts) {
      return { ok: false, error: "That time of day is out of range (use 00:00–23:59)." };
    }
    const wallMs = Date.parse(
      `${absDt[1]}T${String(parts.h).padStart(2, "0")}:${String(parts.m).padStart(2, "0")}:00.000Z`,
    );
    if (Number.isNaN(wallMs)) {
      return { ok: false, error: "That date could not be understood." };
    }
    return fromEpoch(wallMs - tzMs);
  }

  // Bare "YYYY-MM-DD" — local midnight in the tz.
  const absDate = ABS_DATE.exec(text);
  if (absDate) {
    const wallMs = Date.parse(`${absDate[1]}T00:00:00.000Z`);
    if (Number.isNaN(wallMs)) {
      return { ok: false, error: "That date could not be understood." };
    }
    return fromEpoch(wallMs - tzMs);
  }

  // A full ISO timestamp that already carries a timezone (Z or ±offset).
  if (HAS_TZ.test(text)) {
    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) {
      return fromEpoch(ms);
    }
  }

  return {
    ok: false,
    error:
      'Sorry, I couldn\'t read that time. Try "tomorrow 20:00", "in 3 days", or "2026-08-01 20:00".',
  };
}
