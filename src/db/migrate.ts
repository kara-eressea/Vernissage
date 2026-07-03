/**
 * Schema migration.
 *
 * The schema is a single flattened baseline (see schema.ts): applying SCHEMA_SQL
 * creates the full current schema, and every statement is idempotent, so this is
 * safe to run on every startup. The stepwise shape is kept so a future change
 * can add an `if (current < 8) { ... }` step without reworking callers.
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
    db.exec(SCHEMA_SQL);
  }

  // Future schema changes add their steps here, e.g. `if (current < 8) { ... }`.

  if (current !== SCHEMA_VERSION) {
    // pragma value cannot be bound as a parameter; SCHEMA_VERSION is a constant.
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}
