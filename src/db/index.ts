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

/**
 * Open an existing database at `path` read-only, for a second process that must
 * never write (the moderator dashboard). The bot remains the sole writer and
 * runs migrations; this connection opens O_RDONLY and does not migrate, so it
 * can never alter the schema or contend for the write lock. WAL mode lets it
 * read concurrently with the bot's writes. Requires the file to already exist —
 * the bot creates and owns it.
 */
export function openDbReadonly(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("foreign_keys = ON");
  return db;
}
