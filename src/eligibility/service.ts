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
import { checkEligibility } from "../core/eligibility.js";
import {
  buildSnapshotInput,
  snapshotEligibleUsers,
  type SnapshotCandidate,
  type SnapshotDefaults,
} from "../core/eligibilitySnapshot.js";
import { activityWindow, MS_PER_DAY } from "../core/time.js";
import type { DayWindow, IneligibleReason } from "../core/types.js";
import type { Database } from "../db/index.js";
import { listGuildCountsInWindow } from "../db/repositories/activity.js";
import { isBlacklisted } from "../db/repositories/blacklist.js";
import { getGuild } from "../db/repositories/guilds.js";
import { countRafflesSince } from "../db/repositories/raffles.js";
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
