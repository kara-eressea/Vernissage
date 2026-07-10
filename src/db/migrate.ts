/**
 * Schema migration.
 *
 * A fresh database is created from the flattened baseline (see schema.ts),
 * which already reflects the current version. An existing database created at an
 * older version is upgraded by the incremental steps below — one per version
 * bump — so only pre-baseline databases run the ALTERs and a freshly-created one
 * never re-applies a column it already has.
 */

import type { Database } from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

/**
 * Bring `db` up to the current schema version. Safe to call on every startup;
 * an already-created database is left unchanged.
 */
export function migrate(db: Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;

  if (current < 1) {
    // Fresh database: the baseline already has every current column.
    db.exec(SCHEMA_SQL);
  } else {
    // Existing database: apply only the steps it is missing. Each step upgrades
    // one version; add the next as `if (current < 16) { ... }`.
    if (current < 8) {
      db.exec(`ALTER TABLE raffles ADD COLUMN draw_disqualified TEXT`);
    }
    if (current < 9) {
      // Redundant with the entries (raffle_id, user_id) primary key.
      db.exec(`DROP INDEX IF EXISTS idx_entries_raffle`);
    }
    if (current < 10) {
      // Optional entry gates (default off/unset).
      db.exec(
        `ALTER TABLE raffles ADD COLUMN exclude_prior_winners INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE raffles ADD COLUMN required_role_id TEXT;
         ALTER TABLE raffles ADD COLUMN excluded_role_id TEXT`,
      );
    }
    if (current < 11) {
      // Winner claim window (default off/unset).
      db.exec(
        `ALTER TABLE raffles ADD COLUMN claim_window_hours INTEGER;
         ALTER TABLE wins ADD COLUMN claim_deadline TEXT;
         ALTER TABLE wins ADD COLUMN claimed_at TEXT`,
      );
    }
    if (current < 12) {
      // Test-raffle flag (default off): eligibility-neutral, no real prize.
      db.exec(`ALTER TABLE raffles ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0`);
    }
    if (current < 13) {
      // `/raffle reset` waiver flag on wins (default off).
      db.exec(`ALTER TABLE wins ADD COLUMN cooldown_waived INTEGER NOT NULL DEFAULT 0`);
    }
    if (current < 14) {
      // The wizard renders a null draw_mode as 'auto' but validation rejected
      // null; drafts now start at 'auto', so backfill the rows that predate it.
      db.exec(`UPDATE raffles SET draw_mode = 'auto' WHERE draw_mode IS NULL`);
    }
    if (current < 15) {
      // Activity now measures distinct active days as well as raw volume, and a
      // server-wide tenure floor plus a per-raffle "open to everyone" escape
      // hatch replace the old per-raffle account-age override / new-member
      // exemption (whose columns are left in place, unused). Defaults null/off.
      db.exec(
        `ALTER TABLE guilds ADD COLUMN default_min_server_age_days INTEGER;
         ALTER TABLE guilds ADD COLUMN default_req_active_days INTEGER;
         ALTER TABLE raffles ADD COLUMN req_active_days INTEGER;
         ALTER TABLE raffles ADD COLUMN open_to_all INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }

  if (current !== SCHEMA_VERSION) {
    // pragma value cannot be bound as a parameter; SCHEMA_VERSION is a constant.
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}
