/**
 * Server tenure: how long a member has been in the guild.
 *
 * Unlike account age (derived from the user snowflake), tenure is measured from
 * the member's guild join date, read live from the member object at entry time.
 * A leave-and-rejoin resets it — the current membership's join date is what
 * counts (design.md "Entry flow").
 */

import { MS_PER_DAY } from "./time.js";

/**
 * Whether the member has been in the guild at least `minDays` as of `now`.
 *
 * A null/0 requirement always passes. An unknown join date (`joinedAt === null`)
 * fails a positive requirement — a tenure floor we cannot verify blocks entry,
 * matching the strict-on-unknown stance elsewhere. The boundary is inclusive.
 */
export function meetsMinServerAge(
  joinedAt: string | null,
  minDays: number | null,
  now: string,
): boolean {
  if (minDays === null || minDays <= 0) {
    return true;
  }
  if (joinedAt === null) {
    return false;
  }
  const tenureMs = Date.parse(now) - Date.parse(joinedAt);
  return tenureMs >= minDays * MS_PER_DAY;
}
