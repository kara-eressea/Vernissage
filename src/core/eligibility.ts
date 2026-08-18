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
import type {
  DayWindow,
  EligibilityInput,
  EligibilityResult,
  IneligibleReason,
} from "./types.js";

/**
 * The activity window both the entry gate and `/raffle status` evaluate: the
 * `reqDays` days ending at the eligibility instant (`raffleStart`). A
 * non-positive `reqDays` is clamped to a single day so a malformed raffle row
 * never throws; `meetsActivityRequirement` short-circuits before reaching here
 * in that case.
 */
function resolveActivityWindow(input: EligibilityInput): DayWindow {
  return activityWindow(input.raffleStart, input.reqDays >= 1 ? input.reqDays : 1);
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
      // Judged as of the raffle start, like the activity window: a cooldown that
      // lapses mid-raffle still bars a raffle that opened during it.
      now: input.raffleStart,
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

/** Every gate a member fails, rather than just the first (see below). */
export interface EligibilityExplanation {
  ok: boolean;
  /**
   * Each gate the member fails, in the design's check order. Empty when they
   * pass. `reasons[0]` is always exactly what `checkEligibility` returns, so the
   * two can never disagree about the headline reason.
   */
  reasons: IneligibleReason[];
}

/**
 * Evaluate every entry check without short-circuiting.
 *
 * `checkEligibility` stops at the first failure, which is right for the entry
 * flow — it mirrors what the member is told. A moderator answering "why couldn't
 * they enter?" usually wants the whole picture instead ("they fail activity *and*
 * are in cooldown"), so this reports all of them. The entry flow keeps using the
 * short-circuiting version; this exists for the dashboard (docs/dashboard.md
 * "One small piece of genuinely new core logic").
 *
 * It applies the same rules in the same order, including the waivers: an
 * "open to everyone" raffle reports no gate below the creator check, because
 * none of them apply to it. The one deliberate difference is that a raffle which
 * is not open reports `not_open` *and* keeps evaluating, so a moderator looking
 * at a closed or already-drawn raffle still sees who would have qualified.
 */
export function explainEligibility(input: EligibilityInput): EligibilityExplanation {
  const reasons: IneligibleReason[] = [];

  if (input.status !== "open") {
    reasons.push("not_open");
  }
  if (input.blacklisted) {
    reasons.push("blacklisted");
  }
  if (input.isCreator) {
    reasons.push("is_creator");
  }

  if (!input.openToAll) {
    if (input.requiredRoleId !== null && !input.userRoleIds.includes(input.requiredRoleId)) {
      reasons.push("missing_required_role");
    }
    if (input.excludedRoleId !== null && input.userRoleIds.includes(input.excludedRoleId)) {
      reasons.push("has_excluded_role");
    }
    if (!meetsMinAccountAge(input.userSnowflake, input.minAccountAgeDays, input.now)) {
      reasons.push("account_too_new");
    }
    if (!meetsMinServerAge(input.joinedAt, input.minServerAgeDays, input.now)) {
      reasons.push("too_new_to_server");
    }
    const inCooldown = isInWinCooldown({
      cooldownDays: input.cooldown.cooldownDays,
      cooldownCount: input.cooldown.cooldownCount,
      wins: input.wins,
      rafflesSinceLastWin: input.rafflesSinceLastWin,
      now: input.raffleStart,
    });
    if (inCooldown) {
      reasons.push("in_cooldown");
    }
    if (input.excludePriorWinners && input.hasPriorWin) {
      reasons.push("prior_winner");
    }
    if (!meetsActivityRequirement(input)) {
      reasons.push("insufficient_activity");
    }
  }

  if (input.alreadyEntered) {
    reasons.push("already_entered");
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Which of the two activity floors a member misses, for a report that wants to
 * say "enough messages, but not spread over enough days". Both can be true.
 * Returns nulls when no activity gate applies.
 */
export function activityShortfall(input: EligibilityInput): {
  messages: number;
  activeDays: number;
  missesVolume: boolean;
  missesSpread: boolean;
} {
  const window = resolveActivityWindow(input);
  const messages = messagesInWindow(input.dailyCounts, window);
  const activeDays = activeDaysInWindow(input.dailyCounts, window);
  const gated = input.reqDays >= 1;
  return {
    messages,
    activeDays,
    missesVolume: gated && input.reqMessages >= 1 && messages < input.reqMessages,
    missesSpread: gated && input.reqActiveDays >= 1 && activeDays < input.reqActiveDays,
  };
}
