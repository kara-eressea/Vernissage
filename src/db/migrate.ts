/**
 * Schema migration.
 *
 * v1 applies a single idempotent baseline and stamps the SQLite `user_version`
 * pragma. The stepwise structure leaves a clean hook for future versioned
 * migrations without reworking callers.
 */

import type { Database } from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION, WIZARD_STATE_SQL } from "./schema.js";

/**
 * Bring `db` up to the current schema version. Safe to call on every startup;
 * already-migrated databases are left unchanged.
 */
export function migrate(db: Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;

  if (current < 1) {
    db.exec(SCHEMA_SQL);
  }

  // v2: add the wizard_state table to an existing v1 database. (Fresh databases
  // already got it from SCHEMA_SQL above; the CREATE is IF NOT EXISTS anyway.)
  if (current < 2) {
    db.exec(WIZARD_STATE_SQL);
  }

  if (current !== SCHEMA_VERSION) {
    // pragma value cannot be bound as a parameter; SCHEMA_VERSION is a constant.
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}
