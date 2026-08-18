/**
 * Activity counting math (pure).
 *
 * Message counting itself happens in the gateway layer; here we only sum the
 * stored daily buckets over a window and express the per-hour cap as a pure
 * step. Raw message content is never involved — only counts.
 */

import { addDays, utcDay } from "./time.js";
import type { DailyCount, DayWindow } from "./types.js";

/**
 * Total messages recorded within an inclusive UTC-day window.
 *
 * `dailyCounts` may contain days outside the window; only days within
 * [startDay, endDay] are summed. String comparison is valid for ISO dates.
 */
export function messagesInWindow(
  dailyCounts: DailyCount[],
  window: DayWindow,
): number {
  let total = 0;
  for (const { day, count } of dailyCounts) {
    if (day >= window.startDay && day <= window.endDay) {
      total += count;
    }
  }
  return total;
}

/**
 * How many distinct UTC days within the window the member was active on — a day
 * counts if it has any counted message (count >= 1). This is the burst-resistant
 * half of the activity gate: a single day of 100 greetings is one active day, so
 * it can't satisfy a multi-day requirement (design.md "Entry flow").
 *
 * `dailyCounts` may contain days outside the window or zero-count rows; both are
 * ignored. String comparison is valid for ISO dates.
 */
export function activeDaysInWindow(
  dailyCounts: DailyCount[],
  window: DayWindow,
): number {
  let days = 0;
  for (const { day, count } of dailyCounts) {
    if (count >= 1 && day >= window.startDay && day <= window.endDay) {
      days += 1;
    }
  }
  return days;
}

/**
 * Apply an optional per-hour cap to a running count within the current hour.
 *
 * Given the count already recorded this hour and the number of new messages,
 * return how many of the new messages should actually be counted. A null cap
 * means uncapped. This is the pure kernel the batched flush service will call.
 */
export function cappedIncrement(
  countThisHour: number,
  newMessages: number,
  cap: number | null,
): number {
  if (newMessages <= 0) {
    return 0;
  }
  if (cap === null) {
    return newMessages;
  }
  const remaining = cap - countThisHour;
  if (remaining <= 0) {
    return 0;
  }
  return Math.min(newMessages, remaining);
}

/**
 * How long counted activity is kept: six months of daily buckets.
 *
 * Retention used to track the longest lookback in use, which kept the table
 * minimal but deleted history the dashboard's trends and per-raffle views want,
 * and — because it was measured from *now* while a raffle's window is frozen at
 * its start — could delete days a still-open raffle was being judged on. A flat
 * horizon is simpler to reason about and cheap: one row per member per active
 * day is a few thousand rows a year for a server of this size.
 */
export const ACTIVITY_RETENTION_DAYS = 180;

/**
 * The UTC day strictly before which activity rows may be pruned (design.md
 * activity table).
 *
 * Two things bound it, and the earlier one wins:
 *   - the flat retention horizon (`ACTIVITY_RETENTION_DAYS` back from `now`), and
 *   - `earliestNeededDay`: the first day any scheduled or open raffle still needs,
 *     since a raffle's activity window is anchored at its start and therefore
 *     recedes into the past as the raffle runs. Without this, a long-running or
 *     long-lookback raffle would have the ground cut from under it mid-flight and
 *     late entrants would be judged on a truncated window.
 *
 * `safetyDays` keeps a further buffer so an off-by-one can never delete a day a
 * check still needs. Returns the cutoff for `pruneActivityBefore`, which deletes
 * rows with `day < cutoff`.
 */
export function pruneCutoffDay(
  now: string,
  earliestNeededDay: string | null,
  retentionDays = ACTIVITY_RETENTION_DAYS,
  safetyDays = 1,
): string {
  const byRetention = addDays(utcDay(now), -(retentionDays + safetyDays));
  if (earliestNeededDay === null) {
    return byRetention;
  }
  const byRaffle = addDays(earliestNeededDay, -safetyDays);
  return byRaffle < byRetention ? byRaffle : byRetention;
}
