/**
 * Schema migration.
 *
 * v1 applies a single idempotent baseline and stamps the SQLite `user_version`
 * pragma. The stepwise structure leaves a clean hook for future versioned
 * migrations without reworking callers.
 */

import type { Database } from "better-sqlite3";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

/**
 * Bring `db` up to the current schema version. Safe to call on every startup;
 * already-migrated databases are left unchanged.
 */
export function migrate(db: Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;

  if (current < 1) {
    db.exec(SCHEMA_SQL);
  }

  if (current !== SCHEMA_VERSION) {
    // pragma value cannot be bound as a parameter; SCHEMA_VERSION is a constant.
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}
