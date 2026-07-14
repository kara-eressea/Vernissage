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

import {
  snapshotEligibleUsers,
  type SnapshotCandidate,
  type SnapshotDefaults,
} from "../core/eligibilitySnapshot.js";
import { activityWindow } from "../core/time.js";
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
  const active = listGuildCountsInWindow(db, guildId, window.startDay, window.endDay);

  const candidates: SnapshotCandidate[] = active.map((u) => {
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

  const { considered, eligibleUserIds } = snapshotEligibleUsers(candidates, defaults, now);
  return { hasDefaults: true, defaults, considered, eligibleUserIds };
}
