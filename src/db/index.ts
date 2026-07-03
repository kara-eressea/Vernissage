/**
 * Database connection helper.
 *
 * Opens a better-sqlite3 database configured for the bot's usage pattern
 * (single persistent process, foreign keys on, WAL for concurrent reads) and
 * applies the schema. Pass ":memory:" for tests.
 */

import Database from "better-sqlite3";
import { migrate } from "./migrate.js";

export type { Database } from "better-sqlite3";

/**
 * Open (or create) a database at `path`, configure pragmas, and migrate it to
 * the current schema version. Returns the ready-to-use connection.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
