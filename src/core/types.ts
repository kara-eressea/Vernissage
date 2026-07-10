/**
 * Shared domain types for Vernissage core logic.
 *
 * These types describe plain data passed into and out of the pure core
 * functions. Nothing here depends on discord.js or better-sqlite3.
 */

export type RaffleStatus =
  | "draft"
  | "scheduled"
  | "open"
  | "closed"
  | "drawn"
  | "completed"
  | "cancelled";

/** Where the activity window ends. See design.md "Key constraint". */
export type WindowAnchor = "start" | "rolling";

/** How a counted-channel rule applies. */
export type ChannelMode = "include" | "exclude";

/** How a raffle's draw is triggered. */
export type DrawMode = "auto" | "manual";

/** A single day's message count for one user (activity table row). */
export interface DailyCount {
  /** UTC ISO date, e.g. "2026-07-03". */
  day: string;
  count: number;
}

/** An inclusive range of UTC calendar days. */
export interface DayWindow {
  /** First day counted, UTC ISO date (inclusive). */
  startDay: string;
  /** Last day counted, UTC ISO date (inclusive). */
  endDay: string;
}

/** A prior win, used for cooldown checks. */
export interface WinRecord {
  raffleId: number;
  /** UTC ISO timestamp of the win. */
  wonAt: string;
}

/** Win cooldown configuration, resolved from guild defaults + raffle override. */
export interface WinCooldownConfig {
  /** Cannot enter for this many days after a win. null/0 = disabled. */
  cooldownDays: number | null;
  /** Must skip this many raffles after a win. null/0 = disabled. */
  cooldownCount: number | null;
}

/** Reasons an entry attempt can be rejected, in the design-doc check order. */
export type IneligibleReason =
  | "not_open"
  | "blacklisted"
  | "is_creator"
  | "missing_required_role"
  | "has_excluded_role"
  | "account_too_new"
  | "too_new_to_server"
  | "in_cooldown"
  | "prior_winner"
  | "insufficient_activity"
  | "already_entered";

export type EligibilityResult =
  | { ok: true }
  | { ok: false; reason: IneligibleReason };

/**
 * Everything the eligibility orchestrator needs, gathered by the Discord layer.
 * Kept as plain data so the check is a pure function.
 */
export interface EligibilityInput {
  /** Current raffle status; must be "open" to enter. */
  status: RaffleStatus;

  /** Whether the user is currently blacklisted (expiry already resolved). */
  blacklisted: boolean;

  /** Whether this user created the raffle (creators can't enter their own). */
  isCreator: boolean;

  /**
   * When set, the raffle skips every gate below except the already-entered
   * check — an "anyone not blacklisted may enter" escape hatch. Blacklist and
   * creator self-exclusion (checked above) still apply.
   */
  openToAll: boolean;

  /** Role ids the member currently holds, for the optional role gates. */
  userRoleIds: string[];
  /** A role the member must hold to enter; null = no required-role gate. */
  requiredRoleId: string | null;
  /** A role that bars entry if held; null = no excluded-role gate. */
  excludedRoleId: string | null;

  /** User's Discord id (snowflake) for account-age derivation. */
  userSnowflake: string;
  /** Minimum account age in days; null = no requirement. */
  minAccountAgeDays: number | null;

  /**
   * Minimum days the member must have been in the guild before entering (a
   * tenure lockout); null = no requirement. Evaluated against `joinedAt`.
   */
  minServerAgeDays: number | null;

  /** Win-cooldown configuration and the data needed to evaluate it. */
  cooldown: WinCooldownConfig;
  wins: WinRecord[];
  /** Number of raffles the user could have entered since their last win. */
  rafflesSinceLastWin: number;

  /** Whether this raffle bars anyone who has ever won here (non-rerolled). */
  excludePriorWinners: boolean;
  /** Whether the user has a prior non-rerolled win in this guild. */
  hasPriorWin: boolean;

  /** Activity requirement: X messages spread across at least K distinct days. */
  reqMessages: number;
  /** K: distinct active days required within the window; 0/negative = no floor. */
  reqActiveDays: number;
  reqDays: number;
  windowAnchor: WindowAnchor;
  /** Raffle start time, UTC ISO — the anchor for "start" mode. */
  raffleStart: string;

  /** When the user joined the guild, UTC ISO; null if unknown (tenure check). */
  joinedAt: string | null;

  /** The user's daily message counts (already scoped to counted channels). */
  dailyCounts: DailyCount[];

  /** Whether the user already has an active entry in this raffle. */
  alreadyEntered: boolean;

  /** The moment the entry is being attempted, UTC ISO. */
  now: string;
}
