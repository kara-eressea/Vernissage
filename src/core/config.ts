/**
 * Guild-config input validation (pure).
 *
 * Normalizes and validates the scalar settings a moderator can set via
 * `/raffle config set`. Each validator returns either the accepted value or a
 * plain-language error the Discord layer can show verbatim. No discord.js or
 * database import: this is unit-testable in isolation.
 *
 * Clearing a value back to "unset" (null) is expressed by the separate `clear`
 * option on the command, not by these validators, so every value that reaches
 * a validator is a real setting and must be a non-negative whole number.
 */

/** The set of guild-config fields that can be individually cleared to null. */
export const CLEARABLE_FIELDS = [
  "audit_channel",
  "announce_channel",
  "mod_role",
  "hourly_cap",
  "default_cooldown_days",
  "default_cooldown_count",
  "default_min_account_age_days",
] as const;

export type ClearableField = (typeof CLEARABLE_FIELDS)[number];

/** Result of validating one scalar config input. */
export type ConfigValidation =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Shared rule for every scalar setting: a non-negative whole number. `label`
 * names the field in the error message so the mod sees which input was wrong.
 */
function validateNonNegativeInt(label: string, raw: number): ConfigValidation {
  if (!Number.isInteger(raw)) {
    return { ok: false, error: `${label} must be a whole number.` };
  }
  if (raw < 0) {
    return { ok: false, error: `${label} cannot be negative (use "clear" to unset it).` };
  }
  return { ok: true, value: raw };
}

export function validateHourlyCap(raw: number): ConfigValidation {
  return validateNonNegativeInt("Hourly cap", raw);
}

export function validateCooldownDays(raw: number): ConfigValidation {
  return validateNonNegativeInt("Cooldown days", raw);
}

export function validateCooldownCount(raw: number): ConfigValidation {
  return validateNonNegativeInt("Cooldown count", raw);
}

export function validateMinAccountAge(raw: number): ConfigValidation {
  return validateNonNegativeInt("Minimum account age (days)", raw);
}
