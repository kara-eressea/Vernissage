/**
 * Restoring a backup archive over the database.
 *
 * Everything here is a guard. A restore replaces the only copy of state the bot
 * has — including the draw secrets that make past raffles verifiable — so it
 * checks the archive is intact and compatible, and preserves whatever it is
 * about to replace, before writing anything.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { openDb, openDbReadonly } from "../db/index.js";
import { SCHEMA_VERSION } from "../db/schema.js";
import { extractArchive } from "./archive.js";
import {
  DB_ENTRY,
  MANIFEST_ENTRY,
  parseManifest,
  sha256File,
  type BackupManifest,
} from "./manifest.js";
import { compareForRestore, type RestoreImpact } from "./impact.js";
import { readStats, verifySnapshot, type DatabaseStats } from "./snapshot.js";

/**
 * Journal sidecars that belong to a database file and must travel with it. The
 * rollback journal matters as much as the WAL pair here: VACUUM INTO writes a
 * rollback-mode file, so a stale `-journal` left at the destination would be
 * treated as a hot journal against the freshly restored database and rolled
 * back into it on the next open.
 */
const SIDECARS = ["-wal", "-shm", "-journal"] as const;

/** Thrown when an archive cannot safely be restored. */
export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

export interface RestoreOptions {
  archivePath: string;
  /** Where the restored database is written. */
  databasePath: string;
  /** Required to replace an existing database. */
  force: boolean;
  /**
   * Required to go ahead when the restore would make the bot re-run a draw it
   * has already announced. Off by default: that is the one consequence a
   * restore cannot take back.
   */
  rewritePublishedDraws?: boolean;
  /** Injectable for deterministic tests. */
  now?: Date;
}

export interface RestoreResult {
  manifest: BackupManifest;
  /** Schema version of the archived database, before migrations ran. */
  schemaVersionBefore: number;
  /** Schema version after opening it with the current code. */
  schemaVersionAfter: number;
  /** Where the previous database was moved, when one was replaced. */
  movedAsideTo?: string;
  /** Contents of the restored database. */
  stats: DatabaseStats;
  /** Non-blocking consequences of the replacement, for the operator to read. */
  warnings: string[];
}

export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  const now = options.now ?? new Date();

  if (!existsSync(options.archivePath)) {
    throw new RestoreError(`No archive at ${options.archivePath}.`);
  }

  const work = mkdtempSync(join(tmpdir(), "vernissage-restore-"));
  try {
    await extractArchive(options.archivePath, work);

    // Only ever read the entries we put there ourselves, by name — never a
    // listing of whatever the archive happens to contain.
    const manifestPath = join(work, MANIFEST_ENTRY);
    if (!existsSync(manifestPath)) {
      throw new RestoreError(
        `${options.archivePath} has no ${MANIFEST_ENTRY}; it is not a Tombola backup.`,
      );
    }
    const manifest = parseManifest(readFileSync(manifestPath, "utf8"));

    const archivedDb = join(work, DB_ENTRY);
    if (!existsSync(archivedDb)) {
      throw new RestoreError(`${options.archivePath} has no ${DB_ENTRY}; the archive is damaged.`);
    }

    const actualBytes = statSync(archivedDb).size;
    if (actualBytes !== manifest.database.bytes) {
      throw new RestoreError(
        `The archived database is ${actualBytes} bytes but the manifest says ` +
          `${manifest.database.bytes}. The archive is damaged or incomplete.`,
      );
    }
    const actualHash = sha256File(archivedDb);
    if (actualHash !== manifest.database.sha256) {
      throw new RestoreError(
        `The archived database does not match its checksum (expected ` +
          `${manifest.database.sha256}, got ${actualHash}). The archive is damaged or has been altered.`,
      );
    }

    // Read the version out of the database itself. The checksum covers only
    // vernissage.db, so the manifest's copy is unverified metadata — and it is
    // the version gate below that decides whether writing this file is safe.
    const archived = verifySnapshot(archivedDb);

    if (archived.schemaVersion !== manifest.schemaVersion) {
      throw new RestoreError(
        `The archived database is at schema version ${archived.schemaVersion} but the manifest ` +
          `says ${manifest.schemaVersion}. The archive is damaged or has been altered.`,
      );
    }

    // Migrations only ever run forward, and migrate() rewrites user_version
    // unconditionally — so an archive from a newer build would be quietly
    // downgraded rather than rejected. Catch that here instead.
    if (archived.schemaVersion > SCHEMA_VERSION) {
      throw new RestoreError(
        `This archive was made at schema version ${archived.schemaVersion}, but this build only ` +
          `understands ${SCHEMA_VERSION}. Restore it with that version of the bot or newer; ` +
          `restoring it here would corrupt the data.`,
      );
    }

    // Compare against whatever is being replaced before touching it, so the
    // decision is made on the live raffle state rather than on the archive
    // alone.
    const impact = assessImpact(options.databasePath, archivedDb);
    if (impact.blocking.length > 0 && options.rewritePublishedDraws !== true) {
      throw new RestoreError(
        `This restore would rewrite a draw that has already been announced:\n` +
          impact.blocking.map((line) => `  - ${line}`).join("\n") +
          `\n\nThe published commitment and the announced winners would no longer agree, and ` +
          `anyone verifying that draw would find it no longer checks out. Use a backup taken ` +
          `after the raffle was drawn, or pass --rewrite-published-draws if you genuinely mean ` +
          `to redo it.`,
      );
    }

    const movedAsideTo = prepareDestination(options.databasePath, options.force, now);

    copyFileSync(archivedDb, options.databasePath);

    // Open once with the real code path: this runs any pending migrations and
    // proves the restored file is usable before we report success.
    let stats: DatabaseStats;
    try {
      const db = openDb(options.databasePath);
      try {
        stats = readStats(db);
      } finally {
        db.close();
      }
    } catch (err) {
      // The destination has already been replaced at this point, so the failure
      // message has to carry the way back — otherwise the operator is left with
      // an unusable database and no idea the previous one was kept.
      throw new RestoreError(
        `The restored database could not be opened: ${(err as Error).message}. ` +
          `${options.databasePath} now holds the restored file` +
          (movedAsideTo
            ? `, and the database it replaced is at ${movedAsideTo} — move that back to undo this.`
            : `, and there was no previous database to fall back to.`),
      );
    }

    return {
      manifest,
      schemaVersionBefore: archived.schemaVersion,
      schemaVersionAfter: stats.schemaVersion,
      ...(movedAsideTo ? { movedAsideTo } : {}),
      stats,
      warnings: impact.advisory,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * What replacing the database at `databasePath` would cost. Returns nothing to
 * report when there is no database there yet (a new host), or when the existing
 * file cannot be read as one — in that case there is nothing to preserve and
 * the restore is unambiguously an improvement.
 */
function assessImpact(databasePath: string, archivedDb: string): RestoreImpact {
  if (!existsSync(databasePath) || statSync(databasePath).size === 0) {
    return { blocking: [], advisory: [] };
  }

  let live: Database.Database | undefined;
  let archived: Database.Database | undefined;
  try {
    live = openDbReadonly(databasePath);
    archived = new Database(archivedDb, { readonly: true, fileMustExist: true });
    return compareForRestore(live, archived);
  } catch {
    // A database too old or too damaged to compare should not stop a restore
    // whose whole purpose may be to replace it. Opening both inside the guard
    // keeps that true however either one fails.
    return { blocking: [], advisory: [] };
  } finally {
    archived?.close();
    live?.close();
  }
}

/**
 * Clear the way for the restored file. An existing database is moved aside
 * rather than deleted, together with its WAL sidecars so the preserved copy is
 * complete. Any sidecar left behind is removed either way: an old `-wal` beside
 * a new database file is a corruption waiting to happen.
 */
function prepareDestination(databasePath: string, force: boolean, now: Date): string | undefined {
  mkdirSync(dirname(databasePath), { recursive: true });

  const exists = existsSync(databasePath) && statSync(databasePath).size > 0;
  if (exists && !force) {
    throw new RestoreError(
      `${databasePath} already holds a database. Stop the bot and re-run with --force to ` +
        `replace it; the current file will be kept alongside as a .pre-restore copy.`,
    );
  }

  let movedAsideTo: string | undefined;
  if (exists) {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    movedAsideTo = `${databasePath}.pre-restore-${stamp}`;
    renameSync(databasePath, movedAsideTo);
    for (const suffix of SIDECARS) {
      if (existsSync(databasePath + suffix)) {
        renameSync(databasePath + suffix, movedAsideTo + suffix);
      }
    }
  } else {
    rmSync(databasePath, { force: true });
  }

  for (const suffix of SIDECARS) {
    rmSync(databasePath + suffix, { force: true });
  }

  return movedAsideTo;
}
