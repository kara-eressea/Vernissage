/**
 * Eligible-pool service.
 *
 * "Who is eligible right now, under this guild's default entry settings?" —
 * assembles snapshot candidates from the repositories and runs the pure
 * `snapshotEligibleUsers` over them. Extracted from the `/raffle eligible`
 * handler so every surface that needs the standing pool (the command and the
 * moderator dashboard) computes it the same way and can never drift from the
 * real gate. Combines repos and pure core, like draw/service.ts — not pure
 * itself, but it does no Discord work and writes nothing.
 */

import { accountCreatedAt } from "../core/accountAge.js";
import { activeDaysInWindow, messagesInWindow } from "../core/activity.js";
import {
  activityShortfall,
  checkEligibility,
  explainEligibility,
} from "../core/eligibility.js";
import {
  buildSnapshotInput,
  snapshotEligibleUsers,
  type SnapshotCandidate,
  type SnapshotDefaults,
} from "../core/eligibilitySnapshot.js";
import { activityWindow, MS_PER_DAY } from "../core/time.js";
import type {
  DailyCount,
  DayWindow,
  EligibilityInput,
  IneligibleReason,
} from "../core/types.js";
import type { Database } from "../db/index.js";
import {
  getCountsInWindow,
  listGuildCountsInWindow,
} from "../db/repositories/activity.js";
import {
  listActivitySnapshot,
  type ActivitySnapshotRow,
  type FrozenActivity,
} from "../db/repositories/activitySnapshot.js";
import { listEntrants } from "../db/repositories/entries.js";
import { isBlacklisted } from "../db/repositories/blacklist.js";
import { getGuild } from "../db/repositories/guilds.js";
import {
  countRafflesBetween,
  countRafflesSince,
  getGuildRaffle,
} from "../db/repositories/raffles.js";
import { getUserWins } from "../db/repositories/wins.js";

export interface EligiblePool {
  /**
   * Whether a default activity requirement is configured (reqMessages >= 1 and
   * reqDays >= 1). The snapshot enumerates candidates from counted activity, so
   * without a default message/day bar there is nothing to compute; when false
   * `considered` is 0 and `eligibleUserIds` is empty.
   */
  hasDefaults: boolean;
  /** The defaults the snapshot applied, for display. */
  defaults: SnapshotDefaults;
  /** How many members were considered (had counted activity in the window). */
  considered: number;
  /** Ids of the eligible members, preserving input order. */
  eligibleUserIds: string[];
}

/**
 * Enumerate the candidate members for a snapshot: everyone with counted activity
 * inside `window`, each carried with the cooldown/blacklist inputs the pure gate
 * needs. Shared by the standing-pool report and the simulator so both draw the
 * same candidate set from the same query.
 */
function assembleCandidates(
  db: Database,
  guildId: string,
  window: DayWindow,
  now: string,
): SnapshotCandidate[] {
  const active = listGuildCountsInWindow(db, guildId, window.startDay, window.endDay);
  return active.map((u) => {
    const wins = getUserWins(db, guildId, u.userId);
    const latestWonAt = wins.reduce<string | null>(
      (latest, w) => (latest === null || w.wonAt > latest ? w.wonAt : latest),
      null,
    );
    const rafflesSinceLastWin =
      latestWonAt === null ? 0 : countRafflesSince(db, guildId, latestWonAt);
    return {
      userId: u.userId,
      dailyCounts: u.counts,
      wins,
      rafflesSinceLastWin,
      blacklisted: isBlacklisted(db, guildId, u.userId, now),
    };
  });
}

/**
 * Compute the guild's standing eligible pool as of `now`. Reads the guild
 * defaults, enumerates candidates from counted activity over the default
 * window, gathers each candidate's cooldown/blacklist inputs, and evaluates the
 * pure snapshot. See design.md "Listing the eligible pool" for what it can and
 * cannot see (activity-centric; no role/tenure gates).
 */
export function computeEligiblePool(
  db: Database,
  guildId: string,
  now: string,
): EligiblePool {
  const guild = getGuild(db, guildId);
  const reqMessages = guild?.default_req_messages ?? 0;
  const reqDays = guild?.default_req_days ?? 0;
  const defaults: SnapshotDefaults = {
    minAccountAgeDays: guild?.default_min_account_age_days ?? null,
    cooldownDays: guild?.default_cooldown_days ?? null,
    cooldownCount: guild?.default_cooldown_count ?? null,
    reqMessages,
    reqActiveDays: guild?.default_req_active_days ?? 0,
    reqDays,
  };

  if (reqMessages < 1 || reqDays < 1) {
    return { hasDefaults: false, defaults, considered: 0, eligibleUserIds: [] };
  }

  const window = activityWindow(now, reqDays);
  const candidates = assembleCandidates(db, guildId, window, now);
  const { considered, eligibleUserIds } = snapshotEligibleUsers(candidates, defaults, now);
  return { hasDefaults: true, defaults, considered, eligibleUserIds };
}

/**
 * The tunable entry-bar values the simulator feeds in place of the guild's
 * stored defaults. These are exactly the dials `/raffle config set` exposes that
 * the activity-centric snapshot can evaluate (docs/dashboard.md "The
 * centrepiece: an eligibility simulator").
 */
export interface SimulationSettings {
  reqMessages: number;
  /** Activity window in days (Y); values below 1 are treated as 1. */
  reqDays: number;
  reqActiveDays: number;
  minAccountAgeDays: number | null;
  cooldownDays: number | null;
  cooldownCount: number | null;
}

/** One candidate's simulated outcome, with the inputs the view needs to explain it. */
export interface SimulatedMember {
  userId: string;
  /** Messages counted in the window. */
  messages: number;
  /** Distinct active days in the window. */
  activeDays: number;
  /** Account age in whole days from the id snowflake, or null if unparseable. */
  accountAgeDays: number | null;
  eligible: boolean;
  /** The first gate the member fails, or null when eligible. */
  reason: IneligibleReason | null;
}

export interface SimulationResult {
  /** The settings applied, with `reqDays` normalised to at least 1. */
  settings: SimulationSettings;
  /** Candidates evaluated (members with counted activity in the window). */
  considered: number;
  /** How many candidates clear the bar. */
  eligible: number;
  /** Per-candidate outcomes, in the query's grouped order. */
  members: SimulatedMember[];
}

/** Account age in whole days as of `now`, or null when the id is not a snowflake. */
function accountAgeDays(snowflake: string, now: string): number | null {
  try {
    const ageMs = Date.parse(now) - accountCreatedAt(snowflake).getTime();
    if (Number.isNaN(ageMs)) return null;
    return Math.max(0, Math.floor(ageMs / MS_PER_DAY));
  } catch {
    return null;
  }
}

/**
 * Simulate the eligible pool under caller-supplied settings instead of the
 * guild's stored defaults — the engine behind the dashboard's eligibility
 * simulator. It reuses the exact pure `checkEligibility` the entry flow and the
 * standing-pool report use, so the "who/why" it reports can never drift from the
 * real gate. It shares the snapshot's blind spots (activity-only candidates, no
 * role/tenure fidelity, window ending now); see design.md "Fidelity".
 */
export function simulateEligiblePool(
  db: Database,
  guildId: string,
  settings: SimulationSettings,
  now: string,
): SimulationResult {
  const reqDays = settings.reqDays >= 1 ? settings.reqDays : 1;
  const applied: SimulationSettings = { ...settings, reqDays };
  const defaults: SnapshotDefaults = {
    minAccountAgeDays: settings.minAccountAgeDays,
    cooldownDays: settings.cooldownDays,
    cooldownCount: settings.cooldownCount,
    reqMessages: settings.reqMessages,
    reqActiveDays: settings.reqActiveDays,
    reqDays,
  };

  const window = activityWindow(now, reqDays);
  const candidates = assembleCandidates(db, guildId, window, now);

  const members: SimulatedMember[] = candidates.map((c) => {
    const result = checkEligibility(buildSnapshotInput(c, defaults, now));
    return {
      userId: c.userId,
      messages: messagesInWindow(c.dailyCounts, window),
      activeDays: activeDaysInWindow(c.dailyCounts, window),
      accountAgeDays: accountAgeDays(c.userId, now),
      eligible: result.ok,
      reason: result.ok ? null : result.reason,
    };
  });

  return {
    settings: applied,
    considered: members.length,
    eligible: members.filter((m) => m.eligible).length,
    members,
  };
}

// ---------------------------------------------------------------------------
// Per-raffle eligibility report
// ---------------------------------------------------------------------------

/** One member's standing against a specific raffle. */
export interface RaffleEligibilityMember {
  userId: string;
  /** Messages counted inside the raffle's own window. */
  messages: number;
  /** Distinct active days inside that window. */
  activeDays: number;
  /** Account age in whole days from the id snowflake, or null if unparseable. */
  accountAgeDays: number | null;
  /** Whether they hold an active entry in this raffle. */
  entered: boolean;
  eligible: boolean;
  /** Every gate they fail, in the design's check order (empty when eligible). */
  reasons: IneligibleReason[];
  /** Short of the message floor. */
  missesVolume: boolean;
  /** Short of the distinct-active-days floor. */
  missesSpread: boolean;
}

/** The raffle's effective entry bar, after guild-default fallbacks. */
export interface RaffleEligibilitySettings {
  reqMessages: number;
  reqDays: number;
  reqActiveDays: number;
  minAccountAgeDays: number | null;
  cooldownDays: number | null;
  cooldownCount: number | null;
  openToAll: boolean;
  excludePriorWinners: boolean;
  requiredRoleId: string | null;
  excludedRoleId: string | null;
}

export interface RaffleEligibilityReport {
  raffleId: number;
  raffleName: string;
  status: string;
  isTest: boolean;
  /** The instant every gate is judged as of: the raffle's start. */
  anchoredAt: string;
  /**
   * When the activity measurement was frozen (the raffle's open instant), or
   * null for a raffle still measured live — one that opened before snapshots
   * existed. The report reads whichever the gate reads, so the two agree.
   */
  frozenAt: string | null;
  /** The activity window that anchor implies, as UTC days. */
  window: DayWindow;
  settings: RaffleEligibilitySettings;
  considered: number;
  eligible: number;
  entered: number;
  members: RaffleEligibilityMember[];
}

/**
 * Who is (or was) eligible for one specific raffle, and for those who are not,
 * every gate they fail.
 *
 * Unlike `simulateEligiblePool`, which tunes hypothetical settings against a
 * window ending now, this evaluates the raffle's *own* stored settings against
 * its *own* window — anchored at its start, exactly as the entry gate does — so
 * it answers "why couldn't this member enter this raffle?". It runs the same pure
 * core the entry flow runs, via the non-short-circuiting `explainEligibility`, so
 * the who and the why cannot drift from the real gate.
 *
 * Known blind spots, which the page states rather than hides:
 *   - Candidates come from the activity table, plus anyone who actually entered,
 *     so a member who has never posted and never entered is invisible.
 *   - Role gates and server tenure cannot be evaluated without a member fetch, so
 *     they are not applied (a role-gated raffle is therefore over-inclusive here).
 *   - The blacklist reflects its *current* state; only present membership is
 *     stored, so a ban lifted since the raffle ran cannot be seen.
 * Wins and cooldowns, by contrast, are evaluated as of the raffle's start, so a
 * win recorded after this raffle never retroactively blocks a member in it.
 */
export function evaluateRaffleEligibility(
  db: Database,
  guildId: string,
  raffleId: number,
  now: string,
): RaffleEligibilityReport | null {
  const raffle = getGuildRaffle(db, guildId, raffleId);
  if (!raffle) {
    return null;
  }
  const guild = getGuild(db, guildId);
  const anchoredAt = raffle.starts_at ?? now;
  // Activity settings come straight off the raffle row, exactly as the entry gate
  // reads them — the row already carries the values resolved at creation, so a
  // guild-default fallback here would describe a bar the raffle never applied.
  const reqDays = raffle.req_days !== null && raffle.req_days >= 1 ? raffle.req_days : 1;
  const settings: RaffleEligibilitySettings = {
    reqMessages: raffle.req_messages ?? 0,
    reqDays,
    reqActiveDays: raffle.req_active_days ?? 0,
    minAccountAgeDays: guild?.default_min_account_age_days ?? null,
    cooldownDays: raffle.cooldown_days ?? guild?.default_cooldown_days ?? null,
    cooldownCount: raffle.cooldown_count ?? guild?.default_cooldown_count ?? null,
    openToAll: raffle.open_to_all === 1,
    excludePriorWinners: raffle.exclude_prior_winners === 1,
    requiredRoleId: raffle.required_role_id,
    excludedRoleId: raffle.excluded_role_id,
  };

  const window = activityWindow(anchoredAt, reqDays);
  const entrants = new Set(listEntrants(db, raffleId));

  // Read whatever the gate reads. When the raffle froze its measurement at open,
  // that is the truth for this raffle — recomputing from the daily buckets would
  // quietly disagree with it, because the start-day bucket also holds messages
  // sent after the doors opened.
  const frozenAt = raffle.activity_snapshot_at;
  const frozen = frozenAt ? new Map(
    listActivitySnapshot(db, raffleId).map((r) => [r.userId, r]),
  ) : null;
  const counts = frozen
    ? new Map<string, DailyCount[]>()
    : new Map(
        listGuildCountsInWindow(db, guildId, window.startDay, window.endDay).map((u) => [
          u.userId,
          u.counts,
        ]),
      );
  // Everyone the measurement covers, plus anyone who entered (an open-to-all
  // raffle can admit members with no counted activity at all).
  const candidateIds = [
    ...new Set([...(frozen ? frozen.keys() : counts.keys()), ...entrants]),
  ];

  const members: RaffleEligibilityMember[] = candidateIds.map((userId) => {
    // Only wins that had already happened when this raffle started can have
    // gated it; a later win must not be applied retroactively.
    const wins = getUserWins(db, guildId, userId).filter((w) => w.wonAt < anchoredAt);
    const latestWonAt = wins.reduce<string | null>(
      (latest, w) => (latest === null || w.wonAt > latest ? w.wonAt : latest),
      null,
    );
    const input: EligibilityInput = {
      status: "open",
      blacklisted: isBlacklisted(db, guildId, userId, now),
      isCreator: raffle.created_by === userId,
      openToAll: settings.openToAll,
      // No gateway here, so roles and tenure are left unset rather than guessed.
      userRoleIds: [],
      requiredRoleId: null,
      excludedRoleId: null,
      userSnowflake: userId,
      minAccountAgeDays: settings.minAccountAgeDays,
      minServerAgeDays: null,
      cooldown: { cooldownDays: settings.cooldownDays, cooldownCount: settings.cooldownCount },
      wins,
      rafflesSinceLastWin:
        latestWonAt === null ? 0 : countRafflesBetween(db, guildId, latestWonAt, anchoredAt),
      excludePriorWinners: settings.excludePriorWinners,
      hasPriorWin: wins.length > 0,
      reqMessages: settings.reqMessages,
      reqActiveDays: settings.reqActiveDays,
      reqDays,
      raffleStart: anchoredAt,
      joinedAt: null,
      dailyCounts: counts.get(userId) ?? [],
      // A member absent from an existing snapshot had no counted activity in the
      // window: a zero measurement, not a missing one.
      frozenActivity: frozen ? (frozen.get(userId) ?? { messages: 0, activeDays: 0 }) : null,
      // Entry is reported in its own column; folding it in would mask the reason
      // an entrant would otherwise have been blocked for.
      alreadyEntered: false,
      now: anchoredAt,
    };
    const explained = explainEligibility(input);
    const shortfall = activityShortfall(input);
    return {
      userId,
      messages: shortfall.messages,
      activeDays: shortfall.activeDays,
      accountAgeDays: accountAgeDays(userId, anchoredAt),
      entered: entrants.has(userId),
      eligible: explained.ok,
      reasons: explained.reasons,
      missesVolume: shortfall.missesVolume,
      missesSpread: shortfall.missesSpread,
    };
  });

  return {
    raffleId: raffle.raffle_id,
    raffleName: raffle.name ?? `Raffle #${raffle.raffle_id}`,
    status: raffle.status,
    isTest: raffle.is_test === 1,
    anchoredAt,
    frozenAt,
    window,
    settings,
    considered: members.length,
    eligible: members.filter((m) => m.eligible).length,
    entered: members.filter((m) => m.entered).length,
    members,
  };
}

/**
 * Measure every member's activity over a window, as the rows to freeze when a
 * raffle opens. Uses the same pure counters the gate uses, so a frozen
 * measurement equals what a live one would have produced at that instant.
 */
export function measureActivityForSnapshot(
  db: Database,
  guildId: string,
  window: DayWindow,
): ActivitySnapshotRow[] {
  return listGuildCountsInWindow(db, guildId, window.startDay, window.endDay).map((u) => ({
    userId: u.userId,
    messages: messagesInWindow(u.counts, window),
    activeDays: activeDaysInWindow(u.counts, window),
  }));
}

/**
 * One member's activity over a window, for re-freezing a single row after their
 * counted history changes (`/raffle reset <user> activity`).
 */
export function measureMemberActivity(
  db: Database,
  guildId: string,
  userId: string,
  window: DayWindow,
): FrozenActivity {
  const counts = getCountsInWindow(db, guildId, userId, window.startDay, window.endDay);
  return {
    messages: messagesInWindow(counts, window),
    activeDays: activeDaysInWindow(counts, window),
  };
}

/**
 * The activity window a raffle is judged on: `req_days` (falling back to the
 * guild default, then a single day) ending on the raffle's start.
 */
export function raffleActivityWindow(
  reqDays: number | null,
  startsAt: string,
): DayWindow {
  // Mirrors gatherEligibilityInput exactly: the raffle row carries its own
  // resolved bar (the wizard copies the guild defaults in at creation), and a
  // null or sub-1 value means a single day. Falling back to the guild default
  // here would measure a different window than the gate judges.
  return activityWindow(startsAt, reqDays !== null && reqDays >= 1 ? reqDays : 1);
}
