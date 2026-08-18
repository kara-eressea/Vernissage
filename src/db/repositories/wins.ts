/**
 * Wins repository.
 *
 * Records who won which raffle and when, feeding the win-cooldown check. A win
 * marked `rerolled` was later disqualified and replaced (design.md reroll).
 *
 * Since v20 a win does not need a raffle. `source` is `'raffle'` for a draw this
 * bot ran and `'external'` for one a moderator imported with `/raffle record-win`
 * — a prize won before the bot existed, or outside it. Both gate the win cooldown
 * and the prior-winner bar identically; only the raffle-keyed reads below
 * (claims, rerolls, the verifier) skip an external win, which is correct — it has
 * no raffle to be claimed from or rerolled within.
 *
 * That is also why guild scoping now reads `wins.guild_id` rather than joining
 * through `raffles`: an external win has no raffle to join to.
 */

import type { Database } from "better-sqlite3";
import type { WinRecord } from "../../core/types.js";

export interface WinRow {
  win_id: number;
  /** Null for an imported win, which has no raffle of its own. */
  raffle_id: number | null;
  /** The guild the win counts in. Null only in a database not yet migrated. */
  guild_id: string | null;
  /** 'raffle' (drawn here) or 'external' (imported by a moderator). */
  source: string;
  /** Free-text note on an imported win; null for a drawn one. */
  note: string | null;
  user_id: string;
  won_at: string | null;
  rerolled: number;
  claim_deadline: string | null;
  claimed_at: string | null;
  cooldown_waived: number;
}

/**
 * Record a win. Returns the generated win_id. `claimDeadline` is set when the
 * raffle has a claim window (the winner must claim before it); pass null when no
 * claim is required (design.md "Winner claim window").
 */
export function addWin(
  db: Database,
  raffleId: number,
  userId: string,
  wonAt: string,
  claimDeadline: string | null = null,
): number {
  const info = db
    .prepare(
      // guild_id is denormalised from the raffle here rather than passed in, so
      // it can never disagree with the raffle the win came from.
      `INSERT INTO wins (raffle_id, guild_id, source, user_id, won_at, claim_deadline)
       VALUES (?, (SELECT guild_id FROM raffles WHERE raffle_id = ?), 'raffle', ?, ?, ?)`,
    )
    .run(raffleId, raffleId, userId, wonAt, claimDeadline);
  return Number(info.lastInsertRowid);
}

/**
 * Mark a winner's prize as claimed, but only if the win is still live and
 * unclaimed. Returns whether it was recorded (false if already claimed, already
 * rerolled, or the id is unknown) — the atomic guard against a double-claim race.
 */
export function claimWin(db: Database, winId: number, claimedAt: string): boolean {
  const info = db
    .prepare(
      `UPDATE wins SET claimed_at = ?
       WHERE win_id = ? AND claimed_at IS NULL AND rerolled = 0`,
    )
    .run(claimedAt, winId);
  return info.changes > 0;
}

/**
 * A user's current (non-rerolled) win in a raffle, claimed or not, or undefined.
 * The claim path reads this to tell "not a winner" from "already claimed".
 */
export function getActiveWinForUser(
  db: Database,
  raffleId: number,
  userId: string,
): WinRow | undefined {
  return db
    .prepare(
      `SELECT * FROM wins
       WHERE raffle_id = ? AND user_id = ? AND rerolled = 0
       ORDER BY win_id ASC LIMIT 1`,
    )
    .get(raffleId, userId) as WinRow | undefined;
}

/**
 * Wins whose claim deadline has passed with no claim recorded, across all
 * guilds, on raffles still `drawn`. These are the slots the scheduler sweep
 * rerolls to the next eligible entrant (design.md "Winner claim window").
 */
export function listExpiredUnclaimedWins(
  db: Database,
  nowIso: string,
): Array<WinRow & { raffle_id: number }> {
  return db
    .prepare(
      `SELECT w.* FROM wins w
       JOIN raffles r ON r.raffle_id = w.raffle_id
       WHERE r.status = 'drawn'
         AND w.rerolled = 0
         AND w.claimed_at IS NULL
         AND w.claim_deadline IS NOT NULL
         AND w.claim_deadline <= ?
       ORDER BY w.win_id ASC`,
    )
    // The join to raffles guarantees a raffle_id, which the nullable column type
    // cannot express on its own — the reroll path needs it non-null.
    .all(nowIso) as Array<WinRow & { raffle_id: number }>;
}

/** Mark a win as rerolled (the winner was disqualified). */
export function markRerolled(db: Database, winId: number): void {
  db.prepare(`UPDATE wins SET rerolled = 1 WHERE win_id = ?`).run(winId);
}

/** Fetch a single win row by id, or undefined if it does not exist. */
export function getWin(db: Database, winId: number): WinRow | undefined {
  return db.prepare(`SELECT * FROM wins WHERE win_id = ?`).get(winId) as
    | WinRow
    | undefined;
}

/** All win rows for a raffle (including rerolled), oldest first. */
export function listWinsForRaffle(db: Database, raffleId: number): WinRow[] {
  return db
    .prepare(`SELECT * FROM wins WHERE raffle_id = ? ORDER BY win_id ASC`)
    .all(raffleId) as WinRow[];
}

/**
 * The current (non-rerolled) winner ids for a raffle, oldest first. These are
 * the survivors a reroll re-selection must preserve; the newly-selected ids not
 * already here are the replacements.
 */
export function activeWinnerIds(db: Database, raffleId: number): string[] {
  const rows = db
    .prepare(
      `SELECT user_id FROM wins WHERE raffle_id = ? AND rerolled = 0 ORDER BY win_id ASC`,
    )
    .all(raffleId) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}

/**
 * A user's non-rerolled wins in a guild, as core WinRecords for the cooldown
 * check. Rerolled wins are excluded — a disqualified win should not gate
 * re-entry. Test-raffle wins are excluded too, so a test win never gates a
 * member's future entries or bars them as a prior winner (design.md "Test
 * raffles"; the prior-winner check reads this same list). Wins waived by
 * `/raffle reset` are excluded as well, so a mod can clear a member's cooldown
 * and prior-winner bar (design.md "Resetting eligibility"). Imported wins are
 * included — that is the whole point of recording one. Scoped on `wins.guild_id`
 * (since v20; it used to join through the raffle, which an imported win does not
 * have), so a win in one server never gates entry in another — the count-based
 * mode is likewise scoped, via countRafflesSince.
 */
export function getUserWins(db: Database, guildId: string, userId: string): WinRecord[] {
  const rows = db
    .prepare(
      // LEFT JOIN, not JOIN: an imported win has no raffle row, and an inner join
      // would silently drop it — the win would be recorded and gate nothing.
      // COALESCE for the same reason: `r.is_test = 0` is NULL (never true) for a
      // raffle-less win, so the test-raffle filter has to treat "no raffle" as
      // "not a test".
      `SELECT w.raffle_id, w.won_at FROM wins w
       LEFT JOIN raffles r ON r.raffle_id = w.raffle_id
       WHERE w.user_id = ? AND w.guild_id = ? AND w.rerolled = 0 AND w.won_at IS NOT NULL
         AND COALESCE(r.is_test, 0) = 0 AND w.cooldown_waived = 0
       ORDER BY w.won_at ASC`,
    )
    .all(userId, guildId) as Array<{ raffle_id: number | null; won_at: string }>;
  // raffleId is only used to identify the win; an imported one has none.
  return rows.map((r) => ({ raffleId: r.raffle_id, wonAt: r.won_at }));
}

/**
 * Waive a member's still-gating wins in a guild (the `/raffle reset` cooldown
 * scope): mark every non-rerolled, not-yet-waived win they hold in this guild as
 * `cooldown_waived`, so it drops out of getUserWins and stops gating re-entry.
 * Returns how many wins were waived. Idempotent — a second call waives nothing.
 * The win rows are preserved (winner/claim history intact), only their gating
 * effect is lifted (design.md "Resetting eligibility").
 */
export function waiveUserWins(db: Database, guildId: string, userId: string): number {
  const info = db
    .prepare(
      // Scoped on wins.guild_id, not on a raffle subquery: an imported win has no
      // raffle, so the old form could never undo one — and this is the undo path.
      `UPDATE wins SET cooldown_waived = 1
       WHERE user_id = ? AND guild_id = ? AND rerolled = 0 AND cooldown_waived = 0`,
    )
    .run(userId, guildId);
  return info.changes;
}

/** One imported win, as `/raffle record-win` records it. */
export interface ExternalWinInput {
  guildId: string;
  userId: string;
  /** When they won, UTC ISO. Must be a real historical date — the time-based
   *  cooldown is measured from it. */
  wonAt: string;
  /** What they won it in, free text, or null. */
  note: string | null;
}

/**
 * Record a win that did not happen in a raffle this bot ran — a prize from
 * before it was installed, or from an event run elsewhere — so it gates the
 * winner's cooldown and prior-winner bar like any other (design.md "Imported
 * wins"). Returns the new win_id.
 *
 * No raffle, so no claim window and no reroll: `claim_deadline` stays null and
 * the raffle-keyed queries never match it.
 */
export function addExternalWin(db: Database, input: ExternalWinInput): number {
  const info = db
    .prepare(
      `INSERT INTO wins (raffle_id, guild_id, source, note, user_id, won_at)
       VALUES (NULL, ?, 'external', ?, ?, ?)`,
    )
    .run(input.guildId, input.note, input.userId, input.wonAt);
  return Number(info.lastInsertRowid);
}

/**
 * Every imported win in a guild, newest first, for the dashboard's history page.
 * Drawn wins are excluded — those are already visible as raffles.
 */
export function listExternalWins(db: Database, guildId: string): WinRow[] {
  return db
    .prepare(
      `SELECT * FROM wins
        WHERE guild_id = ? AND source = 'external'
        ORDER BY COALESCE(won_at, '') DESC, win_id DESC`,
    )
    .all(guildId) as WinRow[];
}
