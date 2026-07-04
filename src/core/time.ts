/**
 * UTC time and daily-window math.
 *
 * All raffle timestamps are stored in UTC ISO format (see CLAUDE.md). Activity
 * is bucketed into UTC calendar days, so the activity window is expressed as an
 * inclusive range of UTC dates. Window edges fall on UTC midnight; that is the
 * resolution the design commits to for daily buckets.
 */

import type { DayWindow } from "./types.js";

/** Milliseconds in a day. The single definition shared across the core. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse a UTC ISO string (or Date) into epoch milliseconds. */
function toEpochMs(when: string | Date): number {
  const ms = when instanceof Date ? when.getTime() : Date.parse(when);
  if (Number.isNaN(ms)) {
    throw new RangeError(`Invalid timestamp: ${String(when)}`);
  }
  return ms;
}

/**
 * Discord timestamp styles for `<t:epoch:style>` markup: short/long time,
 * short/long date, short/long date-time, and relative ("in 3 hours"). Discord
 * renders these in each viewer's own timezone. See design.md "Time handling".
 */
export type DiscordTimestampStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

/**
 * Render a UTC ISO timestamp as Discord timestamp markup, e.g.
 * `<t:1751545200:F>`. The epoch is whole seconds (Discord ignores fractions).
 */
export function discordTimestamp(
  when: string | Date,
  style: DiscordTimestampStyle = "F",
): string {
  const seconds = Math.floor(toEpochMs(when) / 1000);
  return `<t:${seconds}:${style}>`;
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
 * The UTC calendar hour for a timestamp, as "YYYY-MM-DDTHH". Used to key the
 * in-memory per-hour tally that enforces the anti-spam message cap.
 */
export function utcHour(when: string | Date): string {
  const iso = new Date(toEpochMs(when)).toISOString();
  // "2026-07-03T12:34:56.000Z" -> "2026-07-03T12"
  return iso.slice(0, 13);
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

/**
 * The UTC offset, in minutes east of UTC, that `timeZone` has at the instant
 * `iso`. Positive is east (e.g. +120 for Europe/Copenhagen in summer, +60 in
 * winter), so a wall-clock time in the zone equals `wallMs - offset*60000` in
 * UTC. Resolving the offset for the specific instant means DST is handled
 * correctly, even when the target instant is on the other side of a DST switch
 * from now. Pure — Intl is a standard built-in.
 */
export function offsetMinutesFor(iso: string | Date, timeZone: string): number {
  const date = iso instanceof Date ? iso : new Date(toEpochMs(iso));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  // The same instant expressed as the zone's wall clock, then read back as if it
  // were UTC. The gap between that and the true instant is the zone's offset.
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asIfUtc - date.getTime()) / 60_000);
}
