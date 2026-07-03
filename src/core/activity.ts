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
 * The UTC day strictly before which activity rows may be pruned (design.md:
 * "prune rows older than the longest lookback window in use").
 *
 * Given `now`, the longest activity lookback in use (`maxReqDays`), and a safety
 * margin, returns the cutoff day for `pruneActivityBefore` (which deletes rows
 * with `day < cutoff`). The margin keeps a buffer of still-safe days so an
 * off-by-one or a slightly longer window never deletes rows a check still needs.
 */
export function pruneCutoffDay(
  now: string,
  maxReqDays: number,
  safetyDays = 1,
): string {
  return addDays(utcDay(now), -(maxReqDays + safetyDays));
}
