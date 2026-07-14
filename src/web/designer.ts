/**
 * Raffle-designer view model.
 *
 * The designer is a visual composer for a whole raffle (docs/dashboard.md "The
 * Raffle Designer"): basics, schedule, eligibility, and draw settings on one
 * screen, with a live Discord-embed preview and a live eligible-pool preview.
 * Phase A (this file) is read-only — it seeds the composer from the guild's
 * defaults and computes the pool preview through the shared eligibility core, so
 * the "who would be eligible" number can never drift from the real gate. The
 * Discord hand-off (staging an inert spec redeemed with `/raffle from-design`)
 * lands in a later change; nothing here writes.
 *
 * `buildDesignerPool` is the one non-trivial piece: it turns a `SimulationResult`
 * (from `simulateEligiblePool`) into the fixed-width histogram and exclusion-reason
 * chips the pool panel renders. It is pure so the initial server render and the
 * live `/app/designer/pool` JSON endpoint produce identical shapes.
 */

import type { IneligibleReason } from "../core/types.js";
import type { Database } from "../db/index.js";
import { getGuild } from "../db/repositories/guilds.js";
import {
  simulateEligiblePool,
  type SimulationResult,
  type SimulationSettings,
} from "../eligibility/service.js";

/** The message-count histogram: 10 fixed bins of 5 messages (last is 45+). */
const BIN_COUNT = 10;
const BIN_SIZE = 5;
/** Axis span the threshold line is positioned against (0–50 msgs). */
const POOL_AXIS_MAX = 50;

// ---------------------------------------------------------------------------
// Pool preview (shared by the initial render and the live JSON endpoint)
// ---------------------------------------------------------------------------

/** One histogram bar: its height (0–100%) and whether the whole bin clears X. */
export interface DesignerPoolBin {
  heightPct: number;
  clears: boolean;
}

/** One exclusion-reason chip: a plain-language label and how many it caught. */
export interface DesignerPoolReason {
  label: string;
  count: number;
}

/** Everything the pool panel needs to draw itself, all derived from the core. */
export interface DesignerPool {
  eligible: number;
  considered: number;
  /** Eligible as a whole-percent of considered (0 when nobody was considered). */
  pct: number;
  /** Whether any member had counted activity in the window. */
  hasCandidates: boolean;
  bins: DesignerPoolBin[];
  /** Left offset of the X threshold line, 0–100. */
  thresholdPct: number;
  reqMessages: number;
  reasons: DesignerPoolReason[];
}

/** Plain-language labels for the exclusion reasons the snapshot can produce. */
const REASON_LABELS = {
  messages: "too few messages",
  activeDays: "too few active days",
  accountAge: "account too new",
  cooldown: "in cooldown",
  blacklisted: "blacklisted",
} as const;

type ReasonKey = keyof typeof REASON_LABELS;

/**
 * Turn a computed `SimulationResult` into the pool-panel view: a fixed-width
 * message histogram with the X line placed on it, and the aggregated reasons the
 * excluded members fall out. Pure — no DB, no eligibility logic of its own; it
 * only counts what the core already decided (docs/dashboard.md "The pool preview
 * reuses the simulator engine").
 */
export function buildDesignerPool(result: SimulationResult): DesignerPool {
  const reqMessages = result.settings.reqMessages;

  const counts = new Array<number>(BIN_COUNT).fill(0);
  const reasonCounts: Record<ReasonKey, number> = {
    messages: 0,
    activeDays: 0,
    accountAge: 0,
    cooldown: 0,
    blacklisted: 0,
  };

  for (const m of result.members) {
    counts[Math.min(BIN_COUNT - 1, Math.floor(m.messages / BIN_SIZE))]! += 1;
    if (m.eligible) continue;
    const key = reasonKey(m.reason, m.messages, reqMessages);
    if (key) reasonCounts[key] += 1;
  }

  const tallest = Math.max(1, ...counts);
  const bins: DesignerPoolBin[] = counts.map((count, i) => ({
    heightPct: Math.round((count / tallest) * 100),
    // A bin clears the bar when its whole range sits at or above X.
    clears: i * BIN_SIZE >= reqMessages,
  }));

  const reasons: DesignerPoolReason[] = (Object.keys(REASON_LABELS) as ReasonKey[])
    .filter((k) => reasonCounts[k] > 0)
    .map((k) => ({ label: REASON_LABELS[k], count: reasonCounts[k] }))
    .sort((a, b) => b.count - a.count);

  return {
    eligible: result.eligible,
    considered: result.considered,
    pct: result.considered > 0 ? Math.round((result.eligible / result.considered) * 100) : 0,
    hasCandidates: result.considered > 0,
    bins,
    thresholdPct: Math.max(0, Math.min(100, (reqMessages / POOL_AXIS_MAX) * 100)),
    reqMessages,
    reasons,
  };
}

/**
 * Which reason bucket an excluded member falls into. The snapshot reports both a
 * message shortfall and a day-spread shortfall as `insufficient_activity`, so
 * split them the same way the simulator table does: below the message floor is a
 * message miss, otherwise it's the day spread.
 */
function reasonKey(
  reason: IneligibleReason | null,
  messages: number,
  reqMessages: number,
): ReasonKey | null {
  switch (reason) {
    case "insufficient_activity":
      return messages < reqMessages ? "messages" : "activeDays";
    case "account_too_new":
      return "accountAge";
    case "in_cooldown":
      return "cooldown";
    case "blacklisted":
      return "blacklisted";
    default:
      // Per-raffle reasons the activity snapshot can't produce — leave uncounted.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Composer seed
// ---------------------------------------------------------------------------

/**
 * The guild's saved eligibility defaults, seeding the composer's "Server
 * defaults" mode. `minAccountAgeDays` is server-wide (no per-raffle override), so
 * it is shown read-only and still fed into the pool math.
 */
export interface DesignerDefaults {
  reqMessages: number;
  reqDays: number;
  reqActiveDays: number;
  minAccountAgeDays: number;
  cooldownDays: number;
  cooldownCount: number | null;
}

/** Everything the designer page renders for a fresh composer in this guild. */
export interface DesignerView {
  serverName: string;
  /** The moderator's display name, for the "Hosted by" line in the preview. */
  moderator: string;
  /** IANA timezone the schedule is shown in (guild config, or "UTC"). */
  timezone: string;
  /** Whether an announce channel is configured (a raffle needs somewhere to post). */
  hasAnnounceChannel: boolean;
  defaults: DesignerDefaults;
  /** The initial pool preview, computed under the server defaults. */
  pool: DesignerPool;
  /** Draw-section seed values. */
  initialWinnerCount: number;
  initialDrawMode: string;
  initialClaimHours: number | null;
}

/** Read a guild's eligibility defaults, falling back to sensible starting values. */
function readDefaults(db: Database, guildId: string): DesignerDefaults {
  const g = getGuild(db, guildId);
  return {
    reqMessages: g?.default_req_messages ?? 10,
    reqDays: g?.default_req_days ?? 14,
    reqActiveDays: g?.default_req_active_days ?? 0,
    minAccountAgeDays: g?.default_min_account_age_days ?? 0,
    cooldownDays: g?.default_cooldown_days ?? 0,
    cooldownCount: g?.default_cooldown_count ?? null,
  };
}

/** The `SimulationSettings` a `DesignerDefaults` maps to (for the pool preview). */
export function settingsFromDefaults(d: DesignerDefaults): SimulationSettings {
  return {
    reqMessages: d.reqMessages,
    reqDays: d.reqDays,
    reqActiveDays: d.reqActiveDays,
    minAccountAgeDays: d.minAccountAgeDays,
    cooldownDays: d.cooldownDays,
    cooldownCount: d.cooldownCount,
  };
}

/**
 * Assemble the designer view for `guildId` as of `now`: the guild's saved
 * defaults, the pool preview those defaults produce, and the draw-section seed.
 * The composer starts on "Server defaults" so the first pool the mod sees is the
 * one their standing bar would produce.
 */
export function buildDesignerView(
  db: Database,
  guildId: string,
  serverName: string,
  moderator: string,
  now: string,
): DesignerView {
  const g = getGuild(db, guildId);
  const defaults = readDefaults(db, guildId);
  const pool = buildDesignerPool(
    simulateEligiblePool(db, guildId, settingsFromDefaults(defaults), now),
  );
  return {
    serverName,
    moderator,
    timezone: g?.timezone?.trim() || "UTC",
    hasAnnounceChannel: !!g?.announce_channel,
    defaults,
    pool,
    initialWinnerCount: 1,
    initialDrawMode: "auto",
    initialClaimHours: null,
  };
}
