/**
 * Default-settings eligibility snapshot (pure).
 *
 * Answers "who would be eligible right now, under this guild's default entry
 * settings?" with no raffle in play — the data behind `/raffle eligible`. It
 * reuses the same pure `checkEligibility` the entry flow uses, so the report can
 * never drift from the real gate.
 *
 * Because there is no raffle, the checks that only exist per raffle are not
 * applied: role gates and the prior-winner bar. The server-tenure floor is also
 * skipped — like the entry snapshot it has no member join dates. What it does
 * apply are the guild-wide bars it can evaluate from stored data: not
 * blacklisted, account old enough, off any win cooldown, and the default
 * activity requirement (X messages across K distinct days) — measured over a
 * *rolling* window ending now (there is no raffle start to anchor to). See
 * design.md "Listing the eligible pool" for why it approximates rather than
 * mirrors a specific raffle.
 */

import { checkEligibility } from "./eligibility.js";
import type { DailyCount, EligibilityInput, WinRecord } from "./types.js";

/** The guild defaults the snapshot evaluates against. */
export interface SnapshotDefaults {
  minAccountAgeDays: number | null;
  cooldownDays: number | null;
  cooldownCount: number | null;
  /** Default messages required (X); must be >= 1 for the snapshot to apply. */
  reqMessages: number;
  /** Default distinct active days required (K); 0 = no distinct-day floor. */
  reqActiveDays: number;
  /** Default activity window in days (Y); must be >= 1. */
  reqDays: number;
}

/** One candidate to evaluate, assembled by the Discord layer from repos. */
export interface SnapshotCandidate {
  /** The member's Discord id (snowflake), also used for account-age derivation. */
  userId: string;
  /** Their counted daily messages within the snapshot window. */
  dailyCounts: DailyCount[];
  /** Their non-rerolled, non-waived wins in this guild (cooldown input). */
  wins: WinRecord[];
  /** Raffles drawn since their last win (count-based cooldown input). */
  rafflesSinceLastWin: number;
  /** Whether they are currently blacklisted. */
  blacklisted: boolean;
}

/**
 * Project a candidate into the pure `EligibilityInput`, filling the per-raffle
 * fields with their no-raffle neutral values: an open status (so the gate runs),
 * no role gates, no prior-winner bar, no new-member exemption, and a rolling
 * window anchored at `now`.
 */
export function buildSnapshotInput(
  candidate: SnapshotCandidate,
  defaults: SnapshotDefaults,
  now: string,
): EligibilityInput {
  return {
    status: "open",
    blacklisted: candidate.blacklisted,
    isCreator: false,
    openToAll: false,
    userRoleIds: [],
    requiredRoleId: null,
    excludedRoleId: null,
    userSnowflake: candidate.userId,
    minAccountAgeDays: defaults.minAccountAgeDays,
    // Tenure can't be evaluated without member join dates; leave it unset.
    minServerAgeDays: null,
    cooldown: { cooldownDays: defaults.cooldownDays, cooldownCount: defaults.cooldownCount },
    wins: candidate.wins,
    rafflesSinceLastWin: candidate.rafflesSinceLastWin,
    excludePriorWinners: false,
    hasPriorWin: false,
    reqMessages: defaults.reqMessages,
    reqActiveDays: defaults.reqActiveDays,
    reqDays: defaults.reqDays,
    windowAnchor: "rolling",
    raffleStart: now,
    joinedAt: null,
    dailyCounts: candidate.dailyCounts,
    alreadyEntered: false,
    now,
  };
}

export interface SnapshotResult {
  /** How many candidates were evaluated (users with activity in the window). */
  considered: number;
  /** Ids of the candidates that pass, preserving the input order. */
  eligibleUserIds: string[];
}

/**
 * Evaluate every candidate against the guild defaults and return the eligible
 * ids plus how many were considered.
 */
export function snapshotEligibleUsers(
  candidates: SnapshotCandidate[],
  defaults: SnapshotDefaults,
  now: string,
): SnapshotResult {
  const eligibleUserIds = candidates
    .filter((c) => checkEligibility(buildSnapshotInput(c, defaults, now)).ok)
    .map((c) => c.userId);
  return { considered: candidates.length, eligibleUserIds };
}
