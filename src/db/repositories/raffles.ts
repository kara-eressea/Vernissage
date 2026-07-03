/**
 * Raffle repository.
 *
 * CRUD for raffles plus the status-scoped lookups the scheduler and commands
 * need. Column-level detail mirrors design.md "Data model".
 */

import type { Database } from "better-sqlite3";
import type { RaffleStatus } from "../../core/types.js";

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
  window_anchor: string;
  new_member_exempt: number;
  new_member_days: number | null;
  min_account_age_days: number | null;
  cooldown_days: number | null;
  cooldown_count: number | null;
  draw_mode: string | null;
  channel_id: string | null;
  message_id: string | null;
  entrants_hash: string | null;
  draw_commitment: string | null;
  draw_secret: string | null;
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
      `INSERT INTO raffles (guild_id, status, created_by, created_at)
       VALUES (?, 'draft', ?, ?)`,
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
    | "window_anchor"
    | "new_member_exempt"
    | "new_member_days"
    | "min_account_age_days"
    | "cooldown_days"
    | "cooldown_count"
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
  "window_anchor",
  "new_member_exempt",
  "new_member_days",
  "min_account_age_days",
  "cooldown_days",
  "cooldown_count",
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
  const keys = (Object.keys(patch) as (keyof RaffleFieldPatch)[]).filter(
    (key) => patch[key] !== undefined && PATCHABLE_COLUMNS.has(key),
  );
  if (keys.length === 0) {
    return;
  }
  const assignments = keys.map((key) => `${key} = @${key}`).join(", ");
  const params: Record<string, string | number | null> = { raffle_id: raffleId };
  for (const key of keys) {
    params[key] = patch[key] ?? null;
  }
  db.prepare(`UPDATE raffles SET ${assignments} WHERE raffle_id = @raffle_id`).run(params);
}

/**
 * How many raffles in the guild have completed their draw since `sinceIso` —
 * i.e. raffles the user had the chance to enter after their last win. Counts
 * raffles whose draw is done (`drawn`/`completed`) and whose start is strictly
 * after `sinceIso`. Drives the count-based win cooldown (design.md "Win
 * cooldown").
 */
export function countRafflesSince(db: Database, guildId: string, sinceIso: string): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM raffles
       WHERE guild_id = ?
         AND status IN ('drawn', 'completed')
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
