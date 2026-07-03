/**
 * Discord account age derived from the user id snowflake.
 *
 * A Discord snowflake encodes its creation time in the high bits: the top 42
 * bits are milliseconds since the Discord epoch. This lets us check minimum
 * account age with no extra storage (see design.md entry flow).
 */

/** Discord epoch: 2015-01-01T00:00:00.000Z in Unix milliseconds. */
export const DISCORD_EPOCH = 1420070400000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The account creation time encoded in a snowflake, as a Date (UTC).
 */
export function accountCreatedAt(snowflake: string): Date {
  const id = BigInt(snowflake);
  const ms = Number(id >> 22n) + DISCORD_EPOCH;
  return new Date(ms);
}

/**
 * Whether the account is at least `minDays` old as of `now`.
 *
 * A null/0 requirement always passes. The boundary is inclusive: an account
 * exactly `minDays` old qualifies.
 */
export function meetsMinAccountAge(
  snowflake: string,
  minDays: number | null,
  now: string | Date,
): boolean {
  if (minDays === null || minDays <= 0) {
    return true;
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const ageMs = nowMs - accountCreatedAt(snowflake).getTime();
  return ageMs >= minDays * MS_PER_DAY;
}
