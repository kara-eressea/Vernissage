/**
 * The archive manifest: what a backup contains and what it takes to restore it.
 *
 * It exists so a restore can refuse to do the wrong thing — a truncated
 * download, a tampered file, or an archive from a newer version of the bot than
 * the image being restored onto.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { DatabaseStats } from "./snapshot.js";

/** Bumped only if the archive layout changes incompatibly. */
export const ARCHIVE_FORMAT_VERSION = 1;

/** Fixed entry names inside the archive. Restore reads only these. */
export const DB_ENTRY = "vernissage.db";
export const MANIFEST_ENTRY = "manifest.json";
export const ENV_TEMPLATE_ENTRY = "env.template";
export const COMPOSE_ENTRY = "compose.yaml";

/** Everything an archive holds, in the order it is packed. */
export const ARCHIVE_ENTRIES = [
  DB_ENTRY,
  MANIFEST_ENTRY,
  ENV_TEMPLATE_ENTRY,
  COMPOSE_ENTRY,
] as const;

export interface BackupManifest {
  format: number;
  /** UTC ISO, matching the convention used for every stored timestamp. */
  createdAt: string;
  /** From package.json. Informational; compatibility is decided by schemaVersion. */
  appVersion: string;
  /** SQLite user_version of the snapshot. */
  schemaVersion: number;
  database: {
    file: string;
    bytes: number;
    sha256: string;
  };
  guildIds: string[];
  rowCounts: Record<string, number>;
  /** Optional free-text note from `--note`. */
  note?: string;
}

/** Thrown when a manifest is missing, malformed, or describes an unusable archive. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * SHA-256 of a file, as lowercase hex. Read in chunks rather than into a single
 * buffer: a busy guild's database can be large, this runs twice per round trip
 * inside a memory-capped container, and a whole-file read fails outright above
 * Node's maximum buffer length.
 */
export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Build the manifest describing a snapshot that has already been written. */
export function buildManifest(options: {
  snapshotPath: string;
  stats: DatabaseStats;
  appVersion: string;
  createdAt: string;
  note?: string;
}): BackupManifest {
  return {
    format: ARCHIVE_FORMAT_VERSION,
    createdAt: options.createdAt,
    appVersion: options.appVersion,
    schemaVersion: options.stats.schemaVersion,
    database: {
      file: DB_ENTRY,
      bytes: statSync(options.snapshotPath).size,
      sha256: sha256File(options.snapshotPath),
    },
    guildIds: options.stats.guildIds,
    rowCounts: options.stats.rowCounts,
    ...(options.note ? { note: options.note } : {}),
  };
}

export function serializeManifest(manifest: BackupManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Parse and validate a manifest. Rejects anything that would make a restore
 * unsafe rather than trusting the file to be well-formed.
 */
export function parseManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManifestError(`${MANIFEST_ENTRY} is not valid JSON. The archive is damaged.`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ManifestError(`${MANIFEST_ENTRY} is not an object. The archive is damaged.`);
  }

  const m = parsed as Record<string, unknown>;

  if (typeof m.format !== "number") {
    throw new ManifestError(`${MANIFEST_ENTRY} has no format version. The archive is damaged.`);
  }
  if (m.format > ARCHIVE_FORMAT_VERSION) {
    throw new ManifestError(
      `This archive uses backup format ${m.format}, but this version only understands ` +
        `${ARCHIVE_FORMAT_VERSION}. Restore it with a newer version of the bot.`,
    );
  }
  if (typeof m.schemaVersion !== "number") {
    throw new ManifestError(`${MANIFEST_ENTRY} has no schema version. The archive is damaged.`);
  }

  const db = m.database as Record<string, unknown> | undefined;
  if (
    typeof db !== "object" ||
    db === null ||
    typeof db.sha256 !== "string" ||
    typeof db.bytes !== "number"
  ) {
    throw new ManifestError(
      `${MANIFEST_ENTRY} does not describe the database file. The archive is damaged.`,
    );
  }

  return {
    format: m.format,
    createdAt: typeof m.createdAt === "string" ? m.createdAt : "unknown",
    appVersion: typeof m.appVersion === "string" ? m.appVersion : "unknown",
    schemaVersion: m.schemaVersion,
    database: {
      file: typeof db.file === "string" ? db.file : DB_ENTRY,
      bytes: db.bytes,
      sha256: db.sha256,
    },
    guildIds: Array.isArray(m.guildIds) ? (m.guildIds as string[]) : [],
    rowCounts:
      typeof m.rowCounts === "object" && m.rowCounts !== null
        ? (m.rowCounts as Record<string, number>)
        : {},
    ...(typeof m.note === "string" ? { note: m.note } : {}),
  };
}
