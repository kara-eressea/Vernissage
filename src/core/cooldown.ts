/**
 * Win cooldown (pure).
 *
 * After winning, a user may be barred from entering again for a time (Z days)
 * and/or for a number of raffles (the next N). Either or both modes can be
 * active; if either constraint is unmet the user is still cooling down. See
 * design.md "Win cooldown".
 */

import type { WinCooldownConfig, WinRecord } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CooldownInput extends WinCooldownConfig {
  /** The user's win history. Empty means never won, so never in cooldown. */
  wins: WinRecord[];
  /**
   * How many raffles the user has had the opportunity to enter since their
   * most recent win (excluding the raffle they won). Drives the count mode.
   */
  rafflesSinceLastWin: number;
  /** Entry attempt time, UTC ISO. */
  now: string;
}

/** The most recent win by timestamp, or null if there are none. */
function latestWin(wins: WinRecord[]): WinRecord | null {
  let latest: WinRecord | null = null;
  for (const win of wins) {
    if (latest === null || win.wonAt > latest.wonAt) {
      latest = win;
    }
  }
  return latest;
}

/**
 * Whether the user is currently within a win cooldown.
 *
 * Time boundary is exclusive: exactly Z days after the win, the user may enter
 * again. Count boundary is likewise satisfied once N raffles have been skipped.
 */
export function isInWinCooldown(input: CooldownInput): boolean {
  const last = latestWin(input.wins);
  if (last === null) {
    return false;
  }

  if (input.cooldownDays !== null && input.cooldownDays > 0) {
    const elapsedMs = Date.parse(input.now) - Date.parse(last.wonAt);
    if (elapsedMs < input.cooldownDays * MS_PER_DAY) {
      return true;
    }
  }

  if (input.cooldownCount !== null && input.cooldownCount > 0) {
    if (input.rafflesSinceLastWin < input.cooldownCount) {
      return true;
    }
  }

  return false;
}
