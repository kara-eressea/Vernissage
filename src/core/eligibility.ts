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
 *   3. user did not create this raffle
 *   -- an "open to everyone" raffle skips 4–9, going straight to 10 --
 *   4. role gates: has the required role, lacks the excluded role
 *   5. account meets minimum age
 *   6. member meets minimum server tenure
 *   7. user is not within a win cooldown
 *   8. user is not a barred prior winner
 *   9. activity requirement: X messages across at least K distinct days
 *  10. user has not already entered
 */

import { meetsMinAccountAge } from "./accountAge.js";
import { activeDaysInWindow, messagesInWindow } from "./activity.js";
import { isInWinCooldown } from "./cooldown.js";
import { meetsMinServerAge } from "./serverTenure.js";
import { activityWindow } from "./time.js";
import type { DayWindow, EligibilityInput, EligibilityResult } from "./types.js";

/**
 * The activity window both the entry gate and `/raffle status` evaluate: the
 * `reqDays` days ending at the anchor (raffle start or now). A non-positive
 * `reqDays` is clamped to a single day so a malformed raffle row never throws;
 * `meetsActivityRequirement` short-circuits before reaching here in that case.
 */
function resolveActivityWindow(input: EligibilityInput): DayWindow {
  const anchor = input.windowAnchor === "start" ? input.raffleStart : input.now;
  return activityWindow(anchor, input.reqDays >= 1 ? input.reqDays : 1);
}

/**
 * Whether the user clears the activity requirement: at least X messages spread
 * across at least K distinct active days within the window. Both floors are
 * independent — a member can fail on either the volume or the spread. Exposed
 * for targeted tests and the `/raffle status` checkmark.
 *
 * A non-positive window imposes no activity gate at all, and each floor is
 * skipped when its requirement is below 1 (so X-only and K-only raffles both
 * work). Degrading a malformed row to "met" keeps a bad raffle from throwing at
 * entry time; creation-time validation is the real guard.
 */
export function meetsActivityRequirement(input: EligibilityInput): boolean {
  if (input.reqDays < 1) {
    return true;
  }
  const window = resolveActivityWindow(input);
  if (input.reqMessages >= 1 && messagesInWindow(input.dailyCounts, window) < input.reqMessages) {
    return false;
  }
  if (input.reqActiveDays >= 1 && activeDaysInWindow(input.dailyCounts, window) < input.reqActiveDays) {
    return false;
  }
  return true;
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

  if (input.isCreator) {
    return { ok: false, reason: "is_creator" };
  }

  // "Open to everyone" waives every remaining gate (roles, ages, cooldown,
  // prior-winner, activity) — the blacklist and creator checks above still
  // stand. Only the already-entered guard remains.
  if (!input.openToAll) {
    if (input.requiredRoleId !== null && !input.userRoleIds.includes(input.requiredRoleId)) {
      return { ok: false, reason: "missing_required_role" };
    }

    if (input.excludedRoleId !== null && input.userRoleIds.includes(input.excludedRoleId)) {
      return { ok: false, reason: "has_excluded_role" };
    }

    if (!meetsMinAccountAge(input.userSnowflake, input.minAccountAgeDays, input.now)) {
      return { ok: false, reason: "account_too_new" };
    }

    if (!meetsMinServerAge(input.joinedAt, input.minServerAgeDays, input.now)) {
      return { ok: false, reason: "too_new_to_server" };
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

    if (input.excludePriorWinners && input.hasPriorWin) {
      return { ok: false, reason: "prior_winner" };
    }

    if (!meetsActivityRequirement(input)) {
      return { ok: false, reason: "insufficient_activity" };
    }
  }

  if (input.alreadyEntered) {
    return { ok: false, reason: "already_entered" };
  }

  return { ok: true };
}
