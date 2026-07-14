/**
 * Raffle field validation and defaults resolution (pure).
 *
 * The wizard collects raffle settings step by step; these validators enforce the
 * design's rules (design.md "Raffle creation wizard", "Entry flow", edit
 * constraints) and produce friendly errors the Discord layer shows verbatim.
 * `resolveRaffleSettings` implements "Use defaults" by filling unset raffle
 * fields from the guild config row. No discord.js/database import.
 */

export type Validation = { ok: true } | { ok: false; error: string };

const ok: Validation = { ok: true };
const err = (error: string): Validation => ({ ok: false, error });

/** The subset of raffle columns the wizard fills; all nullable until set. */
export interface RaffleDraftFields {
  name: string | null;
  description: string | null;
  prize: string | null;
  starts_at: string | null;
  ends_at: string | null;
  winner_count: number | null;
  req_messages: number | null;
  req_days: number | null;
  req_active_days: number | null;
  /** 1 = anyone not blacklisted may enter (every other gate waived). */
  open_to_all: number | null;
  exclude_prior_winners: number | null;
  required_role_id: string | null;
  excluded_role_id: string | null;
  cooldown_days: number | null;
  cooldown_count: number | null;
  claim_window_hours: number | null;
  /** 1 = test raffle (badged prize-free, eligibility-neutral); 0/null = normal. */
  is_test: number | null;
  draw_mode: string | null;
}

/** Guild defaults consulted by "Use defaults" and the summary. */
export interface GuildDefaults {
  default_cooldown_days: number | null;
  default_cooldown_count: number | null;
  /** Server-wide account-age and tenure floors (no per-raffle override). */
  default_min_account_age_days: number | null;
  default_min_server_age_days: number | null;
}

export const DRAW_MODES = ["auto", "manual"] as const;

/** Step 1: a raffle needs at least a name and a prize. */
export function validateBasics(fields: Pick<RaffleDraftFields, "name" | "prize">): Validation {
  if (!fields.name || fields.name.trim() === "") {
    return err("Please give the raffle a name.");
  }
  if (!fields.prize || fields.prize.trim() === "") {
    return err("Please describe the prize.");
  }
  return ok;
}

/** Step 2: valid, future-dated window with end strictly after start. */
/**
 * How far in the past a start time may lie and still validate. A mod who types
 * "now" (or a near-future time) on the schedule step re-validates at confirm,
 * minutes later — without a grace window that start would already be "in the
 * past". Kept short so a genuinely mistyped date still errors.
 */
export const START_GRACE_MS = 15 * 60_000;

export function validateSchedule(
  startsAt: string | null,
  endsAt: string | null,
  nowUtc: string,
): Validation {
  if (!startsAt || !endsAt) {
    return err("Both a start and an end time are required.");
  }
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  const now = Date.parse(nowUtc);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return err("The schedule has an invalid time.");
  }
  if (start < now - START_GRACE_MS) {
    return err("The start time is in the past.");
  }
  if (end <= start) {
    return err("The end time must be after the start time.");
  }
  return ok;
}

/** Step 3: the activity requirement (X messages across K days) or open-to-all. */
export function validateEligibility(
  fields: Pick<
    RaffleDraftFields,
    | "req_messages"
    | "req_days"
    | "req_active_days"
    | "open_to_all"
    | "required_role_id"
    | "excluded_role_id"
  >,
): Validation {
  // Open to everyone waives the activity requirement entirely; the only rule is
  // that it can't be combined with a role gate (they'd contradict each other).
  if (fields.open_to_all === 1) {
    if (fields.required_role_id !== null || fields.excluded_role_id !== null) {
      return err(
        "An open-to-everyone raffle can't also require or exclude a role. Clear the role gate, or turn off open-to-everyone.",
      );
    }
    return ok;
  }
  if (fields.req_messages === null || fields.req_messages < 1) {
    return err("The message requirement must be at least 1.");
  }
  if (fields.req_days === null || fields.req_days < 1) {
    return err("The activity window must be at least 1 day.");
  }
  if (fields.req_active_days !== null && fields.req_active_days < 0) {
    return err("The active-days requirement cannot be negative.");
  }
  if (fields.req_active_days !== null && fields.req_active_days > fields.req_days) {
    return err("The active-days requirement can't be more than the activity window.");
  }
  return ok;
}

/** Step 4: winner count, draw mode, and optional claim window. */
export function validateDraw(
  fields: Pick<RaffleDraftFields, "winner_count" | "draw_mode"> & {
    claim_window_hours?: number | null;
  },
): Validation {
  if (fields.winner_count === null || fields.winner_count < 1) {
    return err("There must be at least 1 winner.");
  }
  if (fields.draw_mode === null || !(DRAW_MODES as readonly string[]).includes(fields.draw_mode)) {
    return err("The draw mode must be 'auto' or 'manual'.");
  }
  if (fields.claim_window_hours != null && fields.claim_window_hours < 1) {
    return err("The claim window must be at least 1 hour (leave blank to disable).");
  }
  return ok;
}

/** Full pre-confirm check: every step must pass before a raffle is scheduled. */
export function validateDraft(fields: RaffleDraftFields, nowUtc: string): Validation {
  const checks = [
    validateBasics(fields),
    validateSchedule(fields.starts_at, fields.ends_at, nowUtc),
    validateEligibility(fields),
    validateDraw(fields),
  ];
  return checks.find((c) => !c.ok) ?? ok;
}

/**
 * The eligibility/draw settings after "Use defaults" merges guild config. Same
 * shape as a draft; the defaultable fields are just guaranteed to be resolved
 * (per-raffle value or guild default) rather than left null by the wizard.
 */
export type ResolvedRaffleSettings = RaffleDraftFields & {
  /**
   * Effective server-wide floors, injected from the guild defaults for the
   * summary. These are not per-raffle fields — they apply to every raffle in
   * the guild — so they are resolved here rather than stored on the row.
   */
  min_account_age_days: number | null;
  min_server_age_days: number | null;
};

/**
 * Fill unset (null) per-raffle fields from the guild defaults and inject the
 * server-wide account-age / tenure floors for the summary. Only cooldown falls
 * back per-raffle; account age and tenure come straight from the guild defaults.
 */
export function resolveRaffleSettings(
  fields: RaffleDraftFields,
  defaults: GuildDefaults,
): ResolvedRaffleSettings {
  return {
    ...fields,
    cooldown_days: fields.cooldown_days ?? defaults.default_cooldown_days,
    cooldown_count: fields.cooldown_count ?? defaults.default_cooldown_count,
    min_account_age_days: defaults.default_min_account_age_days,
    min_server_age_days: defaults.default_min_server_age_days,
  };
}

/** Statuses a raffle can be cancelled from — any pre-drawn state (design.md). */
export const CANCELLABLE_STATUSES = ["draft", "scheduled", "open", "closed"] as const;

/** Whether a raffle in `status` may be cancelled. */
export function isCancellable(status: string): boolean {
  return (CANCELLABLE_STATUSES as readonly string[]).includes(status);
}

/** How `/raffle edit` should treat a raffle, based on its status. */
export type EditMode = "wizard" | "edit-end" | "rejected";

/**
 * Draft/scheduled raffles reopen the full wizard; open raffles allow only an
 * end-time correction; anything drawn or later cannot be edited (design.md edit
 * constraint).
 */
export function editModeForStatus(status: string): EditMode {
  if (status === "draft" || status === "scheduled") {
    return "wizard";
  }
  if (status === "open") {
    return "edit-end";
  }
  return "rejected";
}

/**
 * While a raffle is open its end time may be corrected — moved earlier or later
 * to fix a scheduling mistake — but never before the raffle's start (a raffle
 * cannot end before it began). Setting an end at or before "now" simply lets the
 * scheduler close it on its next tick; entries already placed are kept
 * (design.md edit constraint).
 */
export function validateOpenRaffleEdit(startsAt: string | null, newEndsAt: string): Validation {
  const next = Date.parse(newEndsAt);
  if (Number.isNaN(next)) {
    return err("The new end time is invalid.");
  }
  if (startsAt === null) {
    return err("This raffle has no start time.");
  }
  if (next <= Date.parse(startsAt)) {
    return err("The end time must be after the raffle started.");
  }
  return ok;
}
