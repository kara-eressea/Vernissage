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
  /**
   * The raffle won, or null for a win imported with `/raffle record-win` — one
   * from before the bot, which has no raffle (design.md "Imported wins"). The
   * cooldown reads only `wonAt`; this identifies the win for callers that care.
   */
  raffleId: number | null;
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
  /**
   * The instant every point-in-time gate is judged as of: the activity window
   * ends here and the win cooldown is measured against it. For a real entry this
   * is the raffle's start (activity is always anchored to start — post-
   * announcement activity can't create eligibility, and a cooldown that lapses
   * mid-raffle still bars a raffle that opened during it). The `/raffle eligible`
   * snapshot, which has no raffle, passes `now` so its window ends now.
   */
  raffleStart: string;

  /** When the user joined the guild, UTC ISO; null if unknown (tenure check). */
  joinedAt: string | null;

  /** The user's daily message counts (already scoped to counted channels). */
  dailyCounts: DailyCount[];

  /**
   * The activity measurement frozen when the raffle opened, if it has one.
   *
   * Eligibility locks at open: what a member did is measured once, then never
   * re-measured, so messages sent after the doors open cannot create it — not
   * even later the same UTC day, which the day-resolution window would otherwise
   * allow (design.md "Entry flow"). When present this supersedes `dailyCounts`
   * for the activity gate; when absent (a raffle that opened before snapshots
   * existed, or the no-raffle snapshot report) the counts are measured live.
   */
  frozenActivity?: { messages: number; activeDays: number } | null;

  /** Whether the user already has an active entry in this raffle. */
  alreadyEntered: boolean;

  /** The moment the entry is being attempted, UTC ISO. */
  now: string;
}
