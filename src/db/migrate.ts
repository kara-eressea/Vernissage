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
    // one version; add the next as `if (current < 9) { ... }`.
    if (current < 8) {
      db.exec(`ALTER TABLE raffles ADD COLUMN draw_disqualified TEXT`);
    }
  }

  if (current !== SCHEMA_VERSION) {
    // pragma value cannot be bound as a parameter; SCHEMA_VERSION is a constant.
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}
