/**
 * Home-overview view model.
 *
 * Assembles, read-only, everything the home screen shows for a guild
 * (docs/dashboard.md "The front door: login and a home overview"): the live and
 * scheduled raffles, the current eligible-pool count, a dense recent-activity
 * series for the spark, and any config-health warnings. Pure presentation over
 * data the bot already stores — it adds no behaviour and writes nothing.
 */

import { addDays, utcDay } from "../core/time.js";
import type { Database } from "../db/index.js";
import { dailyGuildTotals } from "../db/repositories/activity.js";
import { countActiveEntries } from "../db/repositories/entries.js";
import { getGuild } from "../db/repositories/guilds.js";
import { listByStatus } from "../db/repositories/raffles.js";
import { computeEligiblePool } from "../eligibility/service.js";

/** Days of guild-wide activity shown in the recent-activity spark. */
const SPARK_DAYS = 28;

/** A live or scheduled raffle, as the home cards show it. */
export interface LiveRaffleCard {
  id: number;
  name: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  drawMode: string | null;
  entrants: number;
}

/** One point in the recent-activity spark: a UTC day and its total message count. */
export interface SparkPoint {
  day: string;
  count: number;
}

/** A gentle, dismissible-looking configuration warning. */
export interface HealthWarning {
  message: string;
}

export interface HomeView {
  liveRaffles: LiveRaffleCard[];
  pool: {
    hasDefaults: boolean;
    eligible: number;
    considered: number;
  };
  spark: SparkPoint[];
  warnings: HealthWarning[];
}

/** Build a dense day-by-day series (zero-filled) from the sparse stored totals. */
function buildSpark(db: Database, guildId: string, now: string): SparkPoint[] {
  const endDay = utcDay(now);
  const startDay = addDays(endDay, -(SPARK_DAYS - 1));
  const totals = new Map(
    dailyGuildTotals(db, guildId, startDay, endDay).map((r) => [r.day, r.count]),
  );
  const series: SparkPoint[] = [];
  for (let day = startDay; day <= endDay; day = addDays(day, 1)) {
    series.push({ day, count: totals.get(day) ?? 0 });
  }
  return series;
}

/** Passive config-health checks the bot can't easily nag about in chat. */
function configHealth(db: Database, guildId: string): HealthWarning[] {
  const guild = getGuild(db, guildId);
  const warnings: HealthWarning[] = [];
  if (!guild?.announce_channel) {
    warnings.push({ message: "No announce channel set — raffles have nowhere to post." });
  }
  if (!guild?.default_req_messages || !guild?.default_req_days) {
    warnings.push({
      message:
        "No default activity requirement set — set req-messages and req-days so the eligible pool can be computed.",
    });
  }
  return warnings;
}

/** Assemble the full home view for `guildId` as of `now` (a UTC ISO string). */
export function buildHomeView(db: Database, guildId: string, now: string): HomeView {
  const liveRaffles: LiveRaffleCard[] = listByStatus(db, guildId, ["scheduled", "open"]).map(
    (r) => ({
      id: r.raffle_id,
      name: r.name ?? "(untitled raffle)",
      status: r.status,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      drawMode: r.draw_mode,
      entrants: countActiveEntries(db, r.raffle_id),
    }),
  );

  const poolResult = computeEligiblePool(db, guildId, now);

  return {
    liveRaffles,
    pool: {
      hasDefaults: poolResult.hasDefaults,
      eligible: poolResult.eligibleUserIds.length,
      considered: poolResult.considered,
    },
    spark: buildSpark(db, guildId, now),
    warnings: configHealth(db, guildId),
  };
}
