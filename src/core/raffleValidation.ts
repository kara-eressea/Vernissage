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
  window_anchor: string | null;
  new_member_exempt: number | null;
  new_member_days: number | null;
  min_account_age_days: number | null;
  cooldown_days: number | null;
  cooldown_count: number | null;
  draw_mode: string | null;
}

/** Guild defaults consulted by "Use defaults" and the summary. */
export interface GuildDefaults {
  default_cooldown_days: number | null;
  default_cooldown_count: number | null;
  default_min_account_age_days: number | null;
}

export const WINDOW_ANCHORS = ["start", "rolling"] as const;
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
  if (start < now) {
    return err("The start time is in the past.");
  }
  if (end <= start) {
    return err("The end time must be after the start time.");
  }
  return ok;
}

/** Step 3: activity requirement, account age, and new-member exemption. */
export function validateEligibility(
  fields: Pick<
    RaffleDraftFields,
    | "req_messages"
    | "req_days"
    | "window_anchor"
    | "min_account_age_days"
    | "new_member_exempt"
    | "new_member_days"
  >,
): Validation {
  if (fields.req_messages === null || fields.req_messages < 1) {
    return err("The message requirement must be at least 1.");
  }
  if (fields.req_days === null || fields.req_days < 1) {
    return err("The activity window must be at least 1 day.");
  }
  if (fields.window_anchor !== null && !(WINDOW_ANCHORS as readonly string[]).includes(fields.window_anchor)) {
    return err("The window anchor must be 'start' or 'rolling'.");
  }
  if (fields.min_account_age_days !== null && fields.min_account_age_days < 0) {
    return err("The minimum account age cannot be negative.");
  }
  if (fields.new_member_exempt === 1 && (fields.new_member_days === null || fields.new_member_days < 1)) {
    return err("The new-member exemption needs a join window of at least 1 day.");
  }
  return ok;
}

/** Step 4: winner count and draw mode. */
export function validateDraw(
  fields: Pick<RaffleDraftFields, "winner_count" | "draw_mode">,
): Validation {
  if (fields.winner_count === null || fields.winner_count < 1) {
    return err("There must be at least 1 winner.");
  }
  if (fields.draw_mode === null || !(DRAW_MODES as readonly string[]).includes(fields.draw_mode)) {
    return err("The draw mode must be 'auto' or 'manual'.");
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
export type ResolvedRaffleSettings = RaffleDraftFields;

/**
 * Fill unset (null) raffle fields from the guild defaults, keeping explicit
 * per-raffle overrides. Only the defaultable fields (cooldowns, min account age)
 * fall back; everything else is copied through unchanged.
 */
export function resolveRaffleSettings(
  fields: RaffleDraftFields,
  defaults: GuildDefaults,
): ResolvedRaffleSettings {
  return {
    ...fields,
    cooldown_days: fields.cooldown_days ?? defaults.default_cooldown_days,
    cooldown_count: fields.cooldown_count ?? defaults.default_cooldown_count,
    min_account_age_days: fields.min_account_age_days ?? defaults.default_min_account_age_days,
  };
}

/** Statuses a raffle can be cancelled from — any pre-drawn state (design.md). */
export const CANCELLABLE_STATUSES = ["draft", "scheduled", "open", "closed"] as const;

/** Whether a raffle in `status` may be cancelled. */
export function isCancellable(status: string): boolean {
  return (CANCELLABLE_STATUSES as readonly string[]).includes(status);
}

/** How `/raffle edit` should treat a raffle, based on its status. */
export type EditMode = "wizard" | "extend-end" | "rejected";

/**
 * Draft/scheduled raffles reopen the full wizard; open raffles allow only an
 * end-time extension; anything drawn or later cannot be edited (design.md edit
 * constraint).
 */
export function editModeForStatus(status: string): EditMode {
  if (status === "draft" || status === "scheduled") {
    return "wizard";
  }
  if (status === "open") {
    return "extend-end";
  }
  return "rejected";
}

/**
 * Open raffles may only have their end time extended (design.md edit
 * constraint). Accepts a strictly-later end, rejects equal or earlier.
 */
export function validateOpenRaffleEdit(oldEndsAt: string | null, newEndsAt: string): Validation {
  const next = Date.parse(newEndsAt);
  if (Number.isNaN(next)) {
    return err("The new end time is invalid.");
  }
  if (oldEndsAt === null) {
    return err("This raffle has no end time to extend.");
  }
  const prev = Date.parse(oldEndsAt);
  if (next <= prev) {
    return err("An open raffle's end time can only be extended, not shortened.");
  }
  return ok;
}
