/**
 * Schema migration.
 *
 * v1 applies a single idempotent baseline and stamps the SQLite `user_version`
 * pragma. The stepwise structure leaves a clean hook for future versioned
 * migrations without reworking callers.
 */

import type { Database } from "better-sqlite3";
import {
  SCHEMA_SQL,
  SCHEMA_VERSION,
  V3_COLUMNS,
  V4_COLUMNS,
  V5_INDEXES_SQL,
  V6_COLUMNS,
  V7_COLUMNS,
  WIZARD_STATE_SQL,
} from "./schema.js";

/** Add a column only if it does not already exist (idempotent, unlike ALTER). */
function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  decl: string,
): void {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

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

  // v3: announce-channel columns. Fresh databases already have them from
  // SCHEMA_SQL; addColumnIfMissing makes the ALTER safe to run either way.
  if (current < 3) {
    for (const { table, column, decl } of V3_COLUMNS) {
      addColumnIfMissing(db, table, column, decl);
    }
  }

  // v4: per-guild blacklist generic-message toggle.
  if (current < 4) {
    for (const { table, column, decl } of V4_COLUMNS) {
      addColumnIfMissing(db, table, column, decl);
    }
  }

  // v5: index hygiene (drop the redundant activity index, add the audit-by-raffle
  // index). Both statements are idempotent, so this is safe on any prior version.
  if (current < 5) {
    db.exec(V5_INDEXES_SQL);
  }

  // v6: commit-reveal persistence columns on raffles.
  if (current < 6) {
    for (const { table, column, decl } of V6_COLUMNS) {
      addColumnIfMissing(db, table, column, decl);
    }
  }

  // v7: guild activity-requirement defaults + guild timezone.
  if (current < 7) {
    for (const { table, column, decl } of V7_COLUMNS) {
      addColumnIfMissing(db, table, column, decl);
    }
  }

  if (current !== SCHEMA_VERSION) {
    // pragma value cannot be bound as a parameter; SCHEMA_VERSION is a constant.
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}
