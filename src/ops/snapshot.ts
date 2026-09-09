/**
 * Taking a consistent snapshot of the live database.
 *
 * The bot runs the database in WAL mode, so copying `vernissage.db` on its own
 * can miss transactions still sitting in the `-wal` sidecar. `VACUUM INTO` reads
 * the database through SQLite instead of the filesystem, so it sees every
 * committed transaction (and no uncommitted one) and writes a single,
 * defragmented file with no sidecars of its own — exactly what belongs in an
 * archive. It is read-only with respect to the source, so the bot can keep
 * running and writing throughout.
 */

import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { openDbReadonly } from "../db/index.js";

/** What a snapshot turned out to contain, for the manifest and the summary. */
export interface DatabaseStats {
  /** SQLite's `user_version` — the schema version migrate.ts maintains. */
  schemaVersion: number;
  /** Row count per table, in schema order. */
  rowCounts: Record<string, number>;
  /** Guild ids that appear in the data, so a restore can be sanity-checked. */
  guildIds: string[];
}

/** Thrown when a snapshot cannot be taken or does not verify. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/**
 * Write a consistent copy of the database at `sourcePath` to `destPath`, then
 * reopen and verify it. The destination must not already exist (SQLite refuses
 * to vacuum into an existing file). Returns what the snapshot contains.
 */
export function createSnapshot(sourcePath: string, destPath: string): DatabaseStats {
  if (!existsSync(sourcePath)) {
    throw new SnapshotError(
      `No database at ${sourcePath}. Set DATABASE_PATH to the database you want to back up.`,
    );
  }
  if (existsSync(destPath)) {
    throw new SnapshotError(`Snapshot destination ${destPath} already exists.`);
  }

  // Read-only: this connection structurally cannot write to or migrate the live
  // database, so a backup can never disturb the running bot.
  const source = openDbReadonly(sourcePath);
  try {
    source.prepare("VACUUM INTO ?").run(destPath);
  } catch (err) {
    throw new SnapshotError(`Could not snapshot ${sourcePath}: ${(err as Error).message}`);
  } finally {
    source.close();
  }

  return verifySnapshot(destPath);
}

/**
 * Open a database file read-only and check it over: integrity first, then the
 * facts worth recording. Used on a fresh snapshot and again on the extracted
 * file during a restore, so a corrupted archive is caught before it can replace
 * anything.
 */
export function verifySnapshot(path: string): DatabaseStats {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new SnapshotError(`Snapshot ${path} is missing or empty.`);
  }

  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true }) as string;
    if (integrity !== "ok") {
      throw new SnapshotError(`Snapshot ${path} failed its integrity check: ${integrity}`);
    }
    return readStats(db);
  } finally {
    db.close();
  }
}

/** Schema version, per-table row counts, and the guild ids present. */
export function readStats(db: Database.Database): DatabaseStats {
  const schemaVersion = db.pragma("user_version", { simple: true }) as number;

  // Read the table list from the database itself rather than from schema.ts, so
  // this keeps reporting every table as the schema grows.
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as { name: string }[];

  const rowCounts: Record<string, number> = {};
  for (const { name } of tables) {
    // Table names come from sqlite_master, not from user input; quote them all
    // the same way regardless.
    const row = db.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as {
      n: number;
    };
    rowCounts[name] = row.n;
  }

  const guildIds = tables.some((t) => t.name === "guilds")
    ? (db.prepare(`SELECT guild_id FROM guilds ORDER BY guild_id`).all() as {
        guild_id: string;
      }[]).map((r) => r.guild_id)
    : [];

  return { schemaVersion, rowCounts, guildIds };
}
