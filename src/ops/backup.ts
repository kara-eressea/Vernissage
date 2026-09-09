/**
 * Producing a backup archive.
 *
 * Split from the CLI entry point so the whole operation is callable — and
 * testable — without argv parsing or process exits.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchive } from "./archive.js";
import { renderEnvTemplate } from "./envTemplate.js";
import {
  buildManifest,
  COMPOSE_ENTRY,
  DB_ENTRY,
  ENV_TEMPLATE_ENTRY,
  MANIFEST_ENTRY,
  serializeManifest,
  ARCHIVE_ENTRIES,
  type BackupManifest,
} from "./manifest.js";
import { appVersion, packageRoot } from "./paths.js";
import { createSnapshot } from "./snapshot.js";

export interface BackupOptions {
  /** The live database to snapshot. */
  databasePath: string;
  /** Directory the archive is written to. */
  outDir: string;
  /** Environment the old host was configured with, recorded minus its secrets. */
  env: NodeJS.ProcessEnv;
  /** Optional free-text note stored in the manifest. */
  note?: string;
  /** Injectable for deterministic tests. */
  now?: Date;
}

export interface BackupResult {
  archivePath: string;
  manifest: BackupManifest;
  /** Size of the finished archive, in bytes. */
  bytes: number;
}

/** Compact UTC stamp for archive filenames, e.g. 20260909T101500Z. */
export function archiveTimestamp(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

/**
 * Snapshot the database, gather the non-secret configuration and the compose
 * file for a new host, and pack the lot into one archive.
 */
export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();

  mkdirSync(options.outDir, { recursive: true });
  const archivePath = join(options.outDir, `vernissage-backup-${archiveTimestamp(now)}.tar.gz`);
  if (existsSync(archivePath)) {
    throw new Error(`${archivePath} already exists; refusing to overwrite it.`);
  }

  const stage = mkdtempSync(join(tmpdir(), "vernissage-backup-"));
  try {
    const snapshotPath = join(stage, DB_ENTRY);
    const stats = createSnapshot(options.databasePath, snapshotPath);

    const manifest = buildManifest({
      snapshotPath,
      stats,
      appVersion: appVersion(),
      createdAt,
      note: options.note,
    });

    writeFileSync(join(stage, MANIFEST_ENTRY), serializeManifest(manifest));
    writeFileSync(join(stage, ENV_TEMPLATE_ENTRY), renderEnvTemplate(options.env, createdAt));
    copyFileSync(composeTemplatePath(), join(stage, COMPOSE_ENTRY));

    try {
      await createArchive(stage, archivePath, ARCHIVE_ENTRIES);
    } catch (err) {
      // Don't leave a truncated archive sitting under a plausible name where it
      // could be mistaken for a good backup.
      rmSync(archivePath, { force: true });
      throw err;
    }

    return { archivePath, manifest, bytes: statSync(archivePath).size };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** The published-image compose file shipped with the app, copied into the archive. */
export function composeTemplatePath(): string {
  const path = join(packageRoot(), "deploy", "compose.published.yaml");
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}; the deploy directory did not ship with this build.`);
  }
  return path;
}
