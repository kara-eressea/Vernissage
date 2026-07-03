/**
 * UTC time and daily-window math.
 *
 * All raffle timestamps are stored in UTC ISO format (see CLAUDE.md). Activity
 * is bucketed into UTC calendar days, so the activity window is expressed as an
 * inclusive range of UTC dates. Window edges fall on UTC midnight; that is the
 * resolution the design commits to for daily buckets.
 */

import type { DayWindow } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse a UTC ISO string (or Date) into epoch milliseconds. */
function toEpochMs(when: string | Date): number {
  const ms = when instanceof Date ? when.getTime() : Date.parse(when);
  if (Number.isNaN(ms)) {
    throw new RangeError(`Invalid timestamp: ${String(when)}`);
  }
  return ms;
}

/**
 * The UTC calendar day for a timestamp, as an ISO date string "YYYY-MM-DD".
 */
export function utcDay(when: string | Date): string {
  const day = new Date(toEpochMs(when)).toISOString();
  // "2026-07-03T12:34:56.000Z" -> "2026-07-03"
  return day.slice(0, 10);
}

/**
 * Shift a UTC ISO date string by a whole number of days. Positive moves
 * forward, negative moves back. Returns another "YYYY-MM-DD" string.
 */
export function addDays(day: string, delta: number): string {
  // Anchor at UTC midnight so DST never enters the picture.
  const base = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(base)) {
    throw new RangeError(`Invalid day: ${day}`);
  }
  return new Date(base + delta * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The inclusive UTC-day window of `reqDays` days ending at `anchor`.
 *
 * "At least X messages in the last Y days" resolves, with daily buckets, to Y
 * inclusive calendar days: the anchor's day plus the preceding Y-1 days. A
 * reqDays of 1 is just the anchor day itself.
 */
export function activityWindow(anchor: string | Date, reqDays: number): DayWindow {
  if (!Number.isInteger(reqDays) || reqDays < 1) {
    throw new RangeError(`reqDays must be a positive integer, got ${reqDays}`);
  }
  const endDay = utcDay(anchor);
  const startDay = addDays(endDay, -(reqDays - 1));
  return { startDay, endDay };
}
