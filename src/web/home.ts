/**
 * Home-overview view model.
 *
 * Assembles, read-only, everything the home screen shows for a guild
 * (docs/dashboard.md "The front door: login and a home overview"): the live and
 * scheduled raffles with their progress, the current eligible-pool count and the
 * default bar it applies, the recent-activity series and its week-over-week
 * trend, and any config-health warnings. Pure presentation over data the bot
 * already stores — it adds no behaviour and writes nothing.
 */

import { addDays, utcDay } from "../core/time.js";
import type { Database } from "../db/index.js";
import { dailyGuildTotals } from "../db/repositories/activity.js";
import { countActiveEntries } from "../db/repositories/entries.js";
import { getGuild } from "../db/repositories/guilds.js";
import { listByStatus } from "../db/repositories/raffles.js";
import { computeEligiblePool, type EligiblePool } from "../eligibility/service.js";
import type { SessionGuild } from "./session.js";

/** Days of guild-wide activity shown in the recent-activity spark. */
const SPARK_DAYS = 28;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A live or scheduled raffle, as the home cards show it. */
export interface LiveRaffleCard {
  id: number;
  name: string;
  /** Raw status: "scheduled" or "open". */
  status: string;
  /** Whether the raffle is open for entry right now (vs. scheduled). */
  isLive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  /** Raw draw mode ("auto"/"manual"); the view maps it to a label. */
  drawMode: string;
  entrants: number;
  /** Fraction of the run elapsed, 0–100 (0 while scheduled). */
  progressPct: number;
  /** Human note: "closes in 2 days 14h", "opens in 6 days", or "". */
  timeNote: string;
}

/** The standing eligible pool and the default bar it was computed under. */
export interface PoolSummary {
  hasDefaults: boolean;
  eligible: number;
  considered: number;
  /** One-line recap of the applied defaults, e.g. "10 msgs / 14 days · 3 active days". */
  reqSummary: string;
}

/** One point in the recent-activity spark: a UTC day and its total message count. */
export interface SparkPoint {
  day: string;
  count: number;
}

/** The recent-activity series plus its week-over-week trend. */
export interface ActivitySummary {
  /** 28 dense (zero-filled) daily points, oldest first. */
  spark: SparkPoint[];
  /** Messages counted in the most recent 7 days. */
  weekMessages: number;
  /** Signed percent change vs. the prior 7 days (0 when there is no prior data). */
  trendPct: number;
  /** Whether the trend is flat-or-up (drives arrow direction and colour). */
  trendUp: boolean;
}

/** A gentle configuration warning: a short title and an explanatory detail. */
export interface HealthWarning {
  title: string;
  detail: string;
}

export interface HomeView {
  liveRaffles: LiveRaffleCard[];
  /** How many of the cards are live (open) vs. scheduled. */
  liveCount: number;
  scheduledCount: number;
  pool: PoolSummary;
  activity: ActivitySummary;
  warnings: HealthWarning[];
}

/** Humanize a positive millisecond delta, e.g. "2 days 14h", "6 days", "3h". */
function humanizeDelta(ms: number): string {
  if (ms < MINUTE) return "under a minute";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  // Show the trailing hours only for near-term raffles, where they matter.
  if (days < 3 && hours > 0) {
    return `${days} day${days === 1 ? "" : "s"} ${hours}h`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Progress fraction (0–100) and a human time-note for one raffle. */
function raffleTiming(
  isLive: boolean,
  startsAt: string | null,
  endsAt: string | null,
  nowMs: number,
): { progressPct: number; timeNote: string } {
  const start = startsAt ? Date.parse(startsAt) : NaN;
  const end = endsAt ? Date.parse(endsAt) : NaN;

  if (isLive) {
    if (!Number.isNaN(end) && end > nowMs) {
      const progressPct =
        !Number.isNaN(start) && end > start
          ? Math.min(100, Math.max(0, Math.round(((nowMs - start) / (end - start)) * 100)))
          : 0;
      return { progressPct, timeNote: `closes in ${humanizeDelta(end - nowMs)}` };
    }
    return { progressPct: 100, timeNote: "closing…" };
  }

  if (!Number.isNaN(start) && start > nowMs) {
    return { progressPct: 0, timeNote: `opens in ${humanizeDelta(start - nowMs)}` };
  }
  return { progressPct: 0, timeNote: "" };
}

/** One-line recap of the eligibility defaults the pool was computed under. */
function describeReqSummary(pool: EligiblePool): string {
  if (!pool.hasDefaults) return "";
  const d = pool.defaults;
  const parts = [`${d.reqMessages} msgs / ${d.reqDays} days`];
  if (d.reqActiveDays > 1) parts.push(`${d.reqActiveDays} active days`);
  if (d.minAccountAgeDays && d.minAccountAgeDays > 0) parts.push(`${d.minAccountAgeDays}d+ account`);
  if (d.cooldownDays && d.cooldownDays > 0) parts.push(`${d.cooldownDays}d cooldown`);
  return parts.join(" · ");
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

/** Sum an inclusive slice of the spark counts. */
function sumCounts(spark: SparkPoint[], from: number, to: number): number {
  return spark.slice(from, to).reduce((n, p) => n + p.count, 0);
}

/** The recent-activity summary: the series plus its week-over-week trend. */
function buildActivity(spark: SparkPoint[]): ActivitySummary {
  const weekMessages = sumCounts(spark, spark.length - 7, spark.length);
  const prevWeek = sumCounts(spark, spark.length - 14, spark.length - 7);
  const trendPct = prevWeek > 0 ? Math.round(((weekMessages - prevWeek) / prevWeek) * 100) : 0;
  return { spark, weekMessages, trendPct, trendUp: trendPct >= 0 };
}

/** Passive config-health checks the bot can't easily nag about in chat. */
function configHealth(db: Database, guildId: string): HealthWarning[] {
  const guild = getGuild(db, guildId);
  const warnings: HealthWarning[] = [];
  if (!guild?.announce_channel) {
    warnings.push({
      title: "No announce channel set",
      detail: "Raffles have nowhere to post until you set an announce channel in Discord.",
    });
  }
  if (!guild?.default_req_messages || !guild?.default_req_days) {
    warnings.push({
      title: "No default activity requirement",
      detail:
        "Set req-messages and req-days in Discord so the eligible pool can be computed here.",
    });
  }
  return warnings;
}

/** A guild as the picker and the switcher dropdown show it: name + a short stat. */
export interface PickerCard {
  id: string;
  name: string;
  icon: string | null;
  /** e.g. "~48 of 213 eligible" or "activity bar not set". */
  statLabel: string;
}

/**
 * Build the picker/switcher cards for a moderator's guilds: each with a short
 * eligible-pool stat. Reuses the same pool computation as the home view, so the
 * numbers agree across screens.
 */
export function buildPickerCards(
  db: Database,
  guilds: SessionGuild[],
  now: string,
): PickerCard[] {
  return guilds.map((g) => {
    const pool = computeEligiblePool(db, g.id, now);
    const statLabel = pool.hasDefaults
      ? `~${pool.eligibleUserIds.length} of ${pool.considered} eligible`
      : "activity bar not set";
    return { id: g.id, name: g.name, icon: g.icon, statLabel };
  });
}

/** Assemble the full home view for `guildId` as of `now` (a UTC ISO string). */
export function buildHomeView(db: Database, guildId: string, now: string): HomeView {
  const nowMs = Date.parse(now);
  const rows = listByStatus(db, guildId, ["scheduled", "open"]);
  const liveRaffles: LiveRaffleCard[] = rows.map((r) => {
    const isLive = r.status === "open";
    const { progressPct, timeNote } = raffleTiming(isLive, r.starts_at, r.ends_at, nowMs);
    return {
      id: r.raffle_id,
      name: r.name ?? "(untitled raffle)",
      status: r.status,
      isLive,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      drawMode: r.draw_mode ?? "auto",
      entrants: countActiveEntries(db, r.raffle_id),
      progressPct,
      timeNote,
    };
  });

  const poolResult = computeEligiblePool(db, guildId, now);
  const spark = buildSpark(db, guildId, now);

  return {
    liveRaffles,
    liveCount: liveRaffles.filter((r) => r.isLive).length,
    scheduledCount: liveRaffles.filter((r) => !r.isLive).length,
    pool: {
      hasDefaults: poolResult.hasDefaults,
      eligible: poolResult.eligibleUserIds.length,
      considered: poolResult.considered,
      reqSummary: describeReqSummary(poolResult),
    },
    activity: buildActivity(spark),
    warnings: configHealth(db, guildId),
  };
}
