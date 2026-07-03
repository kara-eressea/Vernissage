/**
 * Ban-duration parsing (pure).
 *
 * Turns a friendly `[duration]` like `30m`, `24h`, `7d`, `2w` into an absolute
 * `expires_at` UTC ISO timestamp measured from `now`. An empty/omitted input is
 * a permanent ban (null). Malformed input throws a `RangeError`, mirroring the
 * style in src/core/time.ts. No date library, no discord.js/db import.
 */

const MS_PER = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
} as const;

type Unit = keyof typeof MS_PER;

/**
 * Parse a ban duration into an expiry timestamp.
 *
 * - `null`/`undefined`/empty (after trimming) → `null` (permanent ban).
 * - `<positive integer><m|h|d|w>` → `now + duration`, as UTC ISO.
 * - anything else (no unit, non-positive, negative, unknown unit, decimals) →
 *   throws `RangeError`.
 */
export function parseBanDuration(
  input: string | null | undefined,
  now: string,
): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }

  const match = /^(\d+)(m|h|d|w)$/.exec(trimmed.toLowerCase());
  if (!match) {
    throw new RangeError(
      `Invalid duration "${input}". Use a number followed by m, h, d, or w (e.g. 30m, 24h, 7d, 2w), or leave blank for permanent.`,
    );
  }
  const amount = Number(match[1]);
  if (amount <= 0) {
    throw new RangeError(`Invalid duration "${input}". The amount must be greater than zero.`);
  }
  const unit = match[2] as Unit;

  const base = Date.parse(now);
  if (Number.isNaN(base)) {
    throw new RangeError(`Invalid timestamp: ${now}`);
  }
  return new Date(base + amount * MS_PER[unit]).toISOString();
}
