/**
 * Entry eligibility (pure orchestrator).
 *
 * Runs the entry checks in the exact order the design doc specifies and
 * short-circuits on the first failure, returning a machine-readable reason the
 * Discord layer turns into a friendly message. No Discord or DB dependencies.
 *
 * Order (design.md "Entry flow"):
 *   1. raffle is open
 *   2. user is not blacklisted
 *   3. account meets minimum age
 *   4. user is not within a win cooldown
 *   5. activity requirement (with new-member exemption)
 *   6. user has not already entered
 */

import { meetsMinAccountAge } from "./accountAge.js";
import { messagesInWindow } from "./activity.js";
import { isInWinCooldown } from "./cooldown.js";
import { activityWindow } from "./time.js";
import type { DayWindow, EligibilityInput, EligibilityResult } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whether the new-member exemption applies: the raffle enables it and the user
 * joined the guild within the last J days. A missing join date never qualifies.
 */
export function isNewMemberExempt(input: EligibilityInput): boolean {
  if (!input.newMemberExempt || input.newMemberDays === null || input.newMemberDays <= 0) {
    return false;
  }
  if (input.joinedAt === null) {
    return false;
  }
  const sinceJoinMs = Date.parse(input.now) - Date.parse(input.joinedAt);
  return sinceJoinMs <= input.newMemberDays * MS_PER_DAY;
}

/**
 * Whether the user clears the activity requirement, honoring the window anchor
 * and the new-member exemption. Exposed for targeted tests.
 */
export function meetsActivityRequirement(input: EligibilityInput): boolean {
  if (isNewMemberExempt(input)) {
    return true;
  }
  // A malformed or requirement-free raffle (no message floor, or a non-positive
  // window) imposes no activity gate. Degrading to "met" keeps a bad row from
  // throwing at entry time; creation-time validation is the real guard.
  if (input.reqMessages < 1 || input.reqDays < 1) {
    return true;
  }
  const anchor = input.windowAnchor === "start" ? input.raffleStart : input.now;
  const window = activityWindow(anchor, input.reqDays);
  return messagesInWindow(input.dailyCounts, window) >= input.reqMessages;
}

export interface ActivityProgress {
  /** Whether the new-member exemption waives the activity requirement. */
  exempt: boolean;
  /** Messages the user has in the window. */
  have: number;
  /** Messages required (X). */
  need: number;
  /** The UTC-day window evaluated. */
  window: DayWindow;
}

/**
 * The user's progress toward the activity requirement, for `/raffle status`.
 * Uses the same window/anchor math as the eligibility check.
 */
export function activityProgress(input: EligibilityInput): ActivityProgress {
  const anchor = input.windowAnchor === "start" ? input.raffleStart : input.now;
  // Mirror meetsActivityRequirement's tolerance: clamp a non-positive window to
  // a single day so `/raffle status` never throws on a malformed raffle row.
  const window = activityWindow(anchor, input.reqDays >= 1 ? input.reqDays : 1);
  return {
    exempt: isNewMemberExempt(input),
    have: messagesInWindow(input.dailyCounts, window),
    need: input.reqMessages,
    window,
  };
}

/**
 * Evaluate all entry checks in order and return the first failure, or ok.
 */
export function checkEligibility(input: EligibilityInput): EligibilityResult {
  if (input.status !== "open") {
    return { ok: false, reason: "not_open" };
  }

  if (input.blacklisted) {
    return { ok: false, reason: "blacklisted" };
  }

  if (!meetsMinAccountAge(input.userSnowflake, input.minAccountAgeDays, input.now)) {
    return { ok: false, reason: "account_too_new" };
  }

  const inCooldown = isInWinCooldown({
    cooldownDays: input.cooldown.cooldownDays,
    cooldownCount: input.cooldown.cooldownCount,
    wins: input.wins,
    rafflesSinceLastWin: input.rafflesSinceLastWin,
    now: input.now,
  });
  if (inCooldown) {
    return { ok: false, reason: "in_cooldown" };
  }

  if (!meetsActivityRequirement(input)) {
    return { ok: false, reason: "insufficient_activity" };
  }

  if (input.alreadyEntered) {
    return { ok: false, reason: "already_entered" };
  }

  return { ok: true };
}
