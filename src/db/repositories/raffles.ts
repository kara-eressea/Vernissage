/**
 * Raffle repository.
 *
 * CRUD for raffles plus the status-scoped lookups the scheduler and commands
 * need. Column-level detail mirrors design.md "Data model".
 */

import type { Database } from "better-sqlite3";
import type { RaffleStatus } from "../../core/types.js";
import { applyColumnPatch } from "../patch.js";

export interface RaffleRow {
  raffle_id: number;
  guild_id: string;
  name: string | null;
  description: string | null;
  prize: string | null;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  winner_count: number;
  req_messages: number | null;
  req_days: number | null;
  req_active_days: number | null;
  window_anchor: string;
  open_to_all: number;
  exclude_prior_winners: number;
  required_role_id: string | null;
  excluded_role_id: string | null;
  cooldown_days: number | null;
  cooldown_count: number | null;
  claim_window_hours: number | null;
  is_test: number;
  draw_mode: string | null;
  channel_id: string | null;
  message_id: string | null;
  entrants_hash: string | null;
  draw_commitment: string | null;
  draw_secret: string | null;
  draw_disqualified: string | null;
  drand_round: number | null;
  created_by: string | null;
  created_at: string | null;
}

/** Create a draft raffle (the wizard's step 1). Returns the new raffle_id. */
export function createDraft(
  db: Database,
  guildId: string,
  createdBy: string,
  createdAt: string,
): number {
  const info = db
    .prepare(
      // draw_mode starts at 'auto', not NULL: the wizard's draw-mode select
      // pre-renders 'auto' when nothing is stored, and validation requires a
      // concrete mode — the stored value must match what the mod is shown.
      `INSERT INTO raffles (guild_id, status, draw_mode, created_by, created_at)
       VALUES (?, 'draft', 'auto', ?, ?)`,
    )
    .run(guildId, createdBy, createdAt);
  return Number(info.lastInsertRowid);
}

/** Fetch a raffle by id, or undefined if it does not exist. */
export function getRaffle(db: Database, raffleId: number): RaffleRow | undefined {
  return db
    .prepare(`SELECT * FROM raffles WHERE raffle_id = ?`)
    .get(raffleId) as RaffleRow | undefined;
}

/**
 * Fetch a raffle only if it exists and belongs to `guildId`; otherwise
 * undefined. The shared "resolve a raffle this server owns" guard the mod and
 * entry commands use before acting on a raffle id.
 */
export function getGuildRaffle(
  db: Database,
  guildId: string,
  raffleId: number,
): RaffleRow | undefined {
  const raffle = getRaffle(db, raffleId);
  return raffle && raffle.guild_id === guildId ? raffle : undefined;
}

/** Columns the wizard/edit flow may patch on a raffle row. */
export type RaffleFieldPatch = Partial<
  Pick<
    RaffleRow,
    | "name"
    | "description"
    | "prize"
    | "starts_at"
    | "ends_at"
    | "winner_count"
    | "req_messages"
    | "req_days"
    | "req_active_days"
    | "window_anchor"
    | "open_to_all"
    | "exclude_prior_winners"
    | "required_role_id"
    | "excluded_role_id"
    | "cooldown_days"
    | "cooldown_count"
    | "claim_window_hours"
    | "is_test"
    | "draw_mode"
    | "channel_id"
    | "message_id"
  >
>;

/** The exact set of patchable columns, used to reject anything unexpected. */
const PATCHABLE_COLUMNS = new Set<keyof RaffleFieldPatch>([
  "name",
  "description",
  "prize",
  "starts_at",
  "ends_at",
  "winner_count",
  "req_messages",
  "req_days",
  "req_active_days",
  "window_anchor",
  "open_to_all",
  "exclude_prior_winners",
  "required_role_id",
  "excluded_role_id",
  "cooldown_days",
  "cooldown_count",
  "claim_window_hours",
  "is_test",
  "draw_mode",
  "channel_id",
  "message_id",
]);

/**
 * Patch a subset of a raffle's columns, leaving the rest untouched. Only
 * whitelisted columns are written (the wizard fills the row incrementally as
 * each step is submitted). A null value in the patch clears that column.
 */
export function updateRaffleFields(
  db: Database,
  raffleId: number,
  patch: RaffleFieldPatch,
): void {
  applyColumnPatch(db, "raffles", "raffle_id", raffleId, patch, PATCHABLE_COLUMNS);
}

/**
 * How many raffles in the guild have completed their draw since `sinceIso` —
 * i.e. raffles the user had the chance to enter after their last win. Counts
 * raffles whose draw is done (`drawn`/`completed`) and whose start is strictly
 * after `sinceIso`. Test raffles are excluded so a test draw never advances a
 * real count-based cooldown (design.md "Test raffles", "Win cooldown").
 */
export function countRafflesSince(db: Database, guildId: string, sinceIso: string): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM raffles
       WHERE guild_id = ?
         AND status IN ('drawn', 'completed')
         AND is_test = 0
         AND starts_at > ?`,
    )
    .get(guildId, sinceIso) as { n: number };
  return row.n;
}

/**
 * The longest activity lookback (`req_days`) among raffles that could still be
 * entered — `scheduled` or `open`. Null when none apply or all are null. Drives
 * how far back activity rows must be kept before pruning (design.md activity
 * "prune rows older than the longest lookback window in use").
 */
export function maxReqDaysInUse(db: Database): number | null {
  const row = db
    .prepare(
      `SELECT MAX(req_days) AS n FROM raffles
       WHERE status IN ('scheduled', 'open') AND req_days IS NOT NULL`,
    )
    .get() as { n: number | null };
  return row.n;
}

/** All draft raffles for a guild, newest first — used by /raffle edit. */
export function listDrafts(db: Database, guildId: string): RaffleRow[] {
  return db
    .prepare(
      `SELECT * FROM raffles
       WHERE guild_id = ? AND status = 'draft'
       ORDER BY raffle_id DESC`,
    )
    .all(guildId) as RaffleRow[];
}

/** Update a raffle's status. */
export function setStatus(
  db: Database,
  raffleId: number,
  status: RaffleStatus,
): void {
  db.prepare(`UPDATE raffles SET status = ? WHERE raffle_id = ?`).run(
    status,
    raffleId,
  );
}

/** Store the frozen entrant hash committed at close. */
export function setEntrantsHash(
  db: Database,
  raffleId: number,
  entrantsHash: string,
): void {
  db.prepare(`UPDATE raffles SET entrants_hash = ? WHERE raffle_id = ?`).run(
    entrantsHash,
    raffleId,
  );
}

/**
 * Persist the commit-reveal pair for a raffle: the commitment published at close
 * and the secret revealed at draw. Stored together so a restart between close
 * and draw resumes with both (design.md "Provably fair draw").
 */
export function setDrawCommitment(
  db: Database,
  raffleId: number,
  commitment: string,
  secret: string,
): void {
  db.prepare(
    `UPDATE raffles SET draw_commitment = ?, draw_secret = ? WHERE raffle_id = ?`,
  ).run(commitment, secret, raffleId);
}

/**
 * Persist the set of entrants disqualified by the draw failsafe (winners who
 * left the guild or were blacklisted at draw). Frozen at draw so a later reroll
 * excludes them and reselects over the same committed entrant list. Stored as a
 * JSON array of ids; the list is read back with `disqualifiedEntrants`.
 */
export function setDrawDisqualified(
  db: Database,
  raffleId: number,
  ids: string[],
): void {
  db.prepare(`UPDATE raffles SET draw_disqualified = ? WHERE raffle_id = ?`).run(
    JSON.stringify(ids),
    raffleId,
  );
}

/** The draw-disqualified entrant ids for a raffle (empty when none/uncommitted). */
export function disqualifiedEntrants(raffle: RaffleRow): string[] {
  return raffle.draw_disqualified ? (JSON.parse(raffle.draw_disqualified) as string[]) : [];
}

/**
 * Raffles in the given statuses for a guild. Used by the scheduler to find
 * transition candidates and by /raffle list.
 */
export function listByStatus(
  db: Database,
  guildId: string,
  statuses: RaffleStatus[],
): RaffleRow[] {
  if (statuses.length === 0) {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT * FROM raffles
       WHERE guild_id = ? AND status IN (${placeholders})
       ORDER BY starts_at ASC`,
    )
    .all(guildId, ...statuses) as RaffleRow[];
}

/**
 * Raffles in the given statuses across all guilds, ordered by id. Used by the
 * scheduler, which sweeps every guild's due transitions on each tick.
 */
export function listByStatusAllGuilds(
  db: Database,
  statuses: RaffleStatus[],
): RaffleRow[] {
  if (statuses.length === 0) {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT * FROM raffles
       WHERE status IN (${placeholders})
       ORDER BY raffle_id ASC`,
    )
    .all(...statuses) as RaffleRow[];
}
