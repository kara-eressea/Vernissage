import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { SCHEMA_VERSION } from "../../src/db/schema.js";
import { incrementActivity } from "../../src/db/repositories/activity.js";
import { addBan } from "../../src/db/repositories/blacklist.js";
import { addEntry } from "../../src/db/repositories/entries.js";
import { setGuildConfig } from "../../src/db/repositories/guilds.js";
import {
  createDraft,
  setDrawCommitment,
  setDrawDisqualified,
  setEntrantsHash,
  setStatus,
  updateRaffleFields,
} from "../../src/db/repositories/raffles.js";
import { addWin } from "../../src/db/repositories/wins.js";
import { createArchive, extractArchive } from "../../src/ops/archive.js";
import { runBackup } from "../../src/ops/backup.js";
import {
  ARCHIVE_ENTRIES,
  COMPOSE_ENTRY,
  DB_ENTRY,
  ENV_TEMPLATE_ENTRY,
  MANIFEST_ENTRY,
} from "../../src/ops/manifest.js";
import { runRestore } from "../../src/ops/restore.js";

const GUILD = "111111111111111111";
const SECRET = "a".repeat(64);
const COMMITMENT = "b".repeat(64);
const ENTRANTS_HASH = "c".repeat(64);

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "vernissage-ops-test-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A database with a row in every table that matters, at a real path. */
function seedDatabase(path: string): void {
  const db = openDb(path);
  try {
    setGuildConfig(
      db,
      GUILD,
      { audit_channel: "222", mod_role: "333", hourly_cap: 20, timezone: "Europe/Copenhagen" },
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO counted_channels (guild_id, channel_id, mode) VALUES (?, ?, ?)`,
    ).run(GUILD, "444", "include");

    incrementActivity(db, GUILD, "user-a", "2026-01-02", 12);
    incrementActivity(db, GUILD, "user-b", "2026-01-03", 7);

    const raffleId = createDraft(db, GUILD, "mod-1", "2026-01-01T10:00:00.000Z");
    updateRaffleFields(db, raffleId, { name: "Winter draw", prize: "A record", winner_count: 2 });
    setStatus(db, raffleId, "drawn");
    setEntrantsHash(db, raffleId, ENTRANTS_HASH);
    setDrawCommitment(db, raffleId, COMMITMENT, SECRET);
    setDrawDisqualified(db, raffleId, ["user-c"]);

    addEntry(db, raffleId, "user-a", "2026-01-04T10:00:00.000Z");
    addEntry(db, raffleId, "user-b", "2026-01-04T11:00:00.000Z");
    addWin(db, raffleId, "user-a", "2026-01-05T10:00:00.000Z", "2026-01-07T10:00:00.000Z");

    addBan(db, {
      guildId: GUILD,
      userId: "user-z",
      bannedBy: "mod-1",
      reason: "spam",
      bannedAt: "2026-01-06T10:00:00.000Z",
      expiresAt: null,
    });

    db.prepare(
      `INSERT INTO audit_log (guild_id, raffle_id, event_type, actor_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(GUILD, raffleId, "raffle_drawn", "mod-1", '{"winners":1}', "2026-01-05T10:00:00.000Z");

    db.prepare(
      `INSERT INTO members (guild_id, user_id, username, display_name, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(GUILD, "user-a", "user_a", "User A", "2026-01-05T10:00:00.000Z");
  } finally {
    db.close();
  }
}

/**
 * Turn a current database into what a version-18 one looked like, by undoing
 * what v19 added, so a restore has real migration work to do. Mirrors the
 * dropPostV9Columns helper in test/db/migration.test.ts, and like it, needs a
 * new line whenever migrate.ts gains a step.
 */
function ageToV18(path: string): void {
  const db = new Database(path);
  try {
    db.exec("DROP TABLE IF EXISTS raffle_activity_snapshot");
    db.exec("ALTER TABLE raffles DROP COLUMN activity_snapshot_at");
    db.pragma("user_version = 18");
  } finally {
    db.close();
  }
}

/** Every row of every table, for comparing a restore against its source. */
function dumpAll(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((t) => t.name);

    const out: Record<string, unknown[]> = {};
    for (const table of tables) {
      out[table] = db.prepare(`SELECT * FROM "${table}"`).all();
    }
    return out;
  } finally {
    db.close();
  }
}

/** Rebuild an archive after mutating its extracted contents, to forge a bad one. */
async function repack(archivePath: string, mutate: (dir: string) => void): Promise<string> {
  const stage = join(work, `repack-${Math.random().toString(36).slice(2)}`);
  const out = join(work, `forged-${Math.random().toString(36).slice(2)}.tar.gz`);
  mkdirSync(stage, { recursive: true });
  await extractArchive(archivePath, stage);
  mutate(stage);
  await createArchive(stage, out, ARCHIVE_ENTRIES);
  return out;
}

describe("backup and restore", () => {
  it("round-trips every table, the schema version, and the draw proof", async () => {
    const source = join(work, "source.db");
    seedDatabase(source);
    const before = dumpAll(source);

    const { archivePath, manifest } = await runBackup({
      databasePath: source,
      outDir: join(work, "archives"),
      env: {},
    });

    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.guildIds).toEqual([GUILD]);
    expect(manifest.rowCounts.raffles).toBe(1);
    expect(manifest.rowCounts.entries).toBe(2);

    const dest = join(work, "restored", "vernissage.db");
    const result = await runRestore({ archivePath, databasePath: dest, force: false });

    expect(result.schemaVersionAfter).toBe(SCHEMA_VERSION);
    expect(dumpAll(dest)).toEqual(before);

    // The commit-reveal values are what make past draws verifiable; they must
    // survive a host move untouched.
    const restored = new Database(dest, { readonly: true });
    const raffle = restored.prepare(`SELECT * FROM raffles`).get() as Record<string, unknown>;
    restored.close();
    expect(raffle.draw_secret).toBe(SECRET);
    expect(raffle.draw_commitment).toBe(COMMITMENT);
    expect(raffle.entrants_hash).toBe(ENTRANTS_HASH);
    expect(raffle.draw_disqualified).toBe('["user-c"]');
  });

  it("captures committed data still in the WAL and skips uncommitted data", async () => {
    const source = join(work, "hot.db");
    seedDatabase(source);

    // A live writer, exactly as the running bot would be: WAL not checkpointed.
    const live = openDb(source);
    incrementActivity(live, GUILD, "committed-user", "2026-02-01", 5);
    expect(statSync(`${source}-wal`).size).toBeGreaterThan(0);

    // A second connection holding an open, uncommitted transaction.
    const other = new Database(source);
    other.pragma("busy_timeout = 2000");
    other.exec("BEGIN IMMEDIATE");
    incrementActivity(other, GUILD, "uncommitted-user", "2026-02-02", 9);

    const { archivePath } = await runBackup({
      databasePath: source,
      outDir: join(work, "archives"),
      env: {},
    });

    other.exec("ROLLBACK");
    other.close();
    live.close();

    const dest = join(work, "hot-restored.db");
    await runRestore({ archivePath, databasePath: dest, force: false });

    const db = new Database(dest, { readonly: true });
    const users = (db.prepare(`SELECT user_id FROM activity ORDER BY user_id`).all() as {
      user_id: string;
    }[]).map((r) => r.user_id);
    db.close();

    expect(users).toContain("committed-user");
    expect(users).not.toContain("uncommitted-user");
  });

  it("never writes secrets into the archive", async () => {
    const source = join(work, "secrets.db");
    seedDatabase(source);

    const env = {
      DISCORD_TOKEN: "TOKEN-SHOULD-NOT-APPEAR",
      DISCORD_CLIENT_SECRET: "CLIENTSECRET-SHOULD-NOT-APPEAR",
      DASHBOARD_SESSION_SECRET: "SESSIONSECRET-SHOULD-NOT-APPEAR",
      DESIGNER_HANDOFF_SECRET: "HANDOFFSECRET-SHOULD-NOT-APPEAR",
      DISCORD_APP_ID: "999888777",
      GUILD_IDS: GUILD,
      DASHBOARD_BASE_URL: "https://tombola.example.com",
    };

    const { archivePath } = await runBackup({
      databasePath: source,
      outDir: join(work, "archives"),
      env,
    });

    const extracted = join(work, "extracted");
    mkdirSync(extracted, { recursive: true });
    await extractArchive(archivePath, extracted);

    expect(readdirSync(extracted).sort()).toEqual(
      [COMPOSE_ENTRY, DB_ENTRY, ENV_TEMPLATE_ENTRY, MANIFEST_ENTRY].sort(),
    );

    const template = readFileSync(join(extracted, ENV_TEMPLATE_ENTRY), "utf8");
    for (const secret of [
      "TOKEN-SHOULD-NOT-APPEAR",
      "CLIENTSECRET-SHOULD-NOT-APPEAR",
      "SESSIONSECRET-SHOULD-NOT-APPEAR",
      "HANDOFFSECRET-SHOULD-NOT-APPEAR",
    ]) {
      expect(template).not.toContain(secret);
    }

    // The non-secret settings are carried, so the new host can be reconstructed.
    expect(template).toContain("DISCORD_APP_ID=999888777");
    expect(template).toContain(`GUILD_IDS=${GUILD}`);
    expect(template).toContain("DASHBOARD_BASE_URL=https://tombola.example.com");
    // Secret keys that were set are present but blank, so they are noticed.
    expect(template).toMatch(/^DISCORD_TOKEN=$/m);
    expect(template).toMatch(/^DASHBOARD_SESSION_SECRET=$/m);
  });

  it("refuses a tampered archive and leaves the destination untouched", async () => {
    const source = join(work, "tamper.db");
    seedDatabase(source);
    const { archivePath } = await runBackup({
      databasePath: source,
      outDir: join(work, "archives"),
      env: {},
    });

    const forged = await repack(archivePath, (dir) => {
      const dbFile = join(dir, DB_ENTRY);
      const bytes = readFileSync(dbFile);
      // Flip a byte well inside the data, leaving the length unchanged.
      bytes[bytes.length - 32] = bytes[bytes.length - 32]! ^ 0xff;
      writeFileSync(dbFile, bytes);
    });

    const dest = join(work, "untouched.db");
    seedDatabase(dest);
    const before = dumpAll(dest);

    await expect(
      runRestore({ archivePath: forged, databasePath: dest, force: true }),
    ).rejects.toThrow(/checksum/i);

    expect(dumpAll(dest)).toEqual(before);
    expect(readdirSync(work).some((f) => f.includes("pre-restore"))).toBe(false);
  });

  it("refuses an archive from a newer schema version", async () => {
    const source = join(work, "newer.db");
    seedDatabase(source);
    const ahead = new Database(source);
    ahead.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    ahead.close();

    const { archivePath } = await runBackup({
      databasePath: source,
      outDir: join(work, "archives"),
      env: {},
    });

    const dest = join(work, "newer-dest.db");
    await expect(
      runRestore({ archivePath, databasePath: dest, force: false }),
    ).rejects.toThrow(/only understands/i);
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses when the manifest disagrees with the archived database", async () => {
    const source = join(work, "mismatch.db");
    seedDatabase(source);
    const { archivePath } = await runBackup({
      databasePath: source,
      outDir: join(work, "archives"),
      env: {},
    });

    // Only vernissage.db is checksummed, so a doctored manifest must not be
    // able to talk the version gate into accepting the file.
    const forged = await repack(archivePath, (dir) => {
      const manifestPath = join(dir, MANIFEST_ENTRY);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.schemaVersion = 2;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    });

    const dest = join(work, "mismatch-dest.db");
    await expect(
      runRestore({ archivePath: forged, databasePath: dest, force: false }),
    ).rejects.toThrow(/manifest says/i);
    expect(existsSync(dest)).toBe(false);
  });

  it("will not replace an existing database without --force, and keeps it when forced", async () => {
    const source = join(work, "src2.db");
    seedDatabase(source);
    const { archivePath } = await runBackup({
      databasePath: source,
      outDir: join(work, "archives"),
      env: {},
    });

    // A different database already at the destination.
    const destDir = join(work, "dest");
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, "vernissage.db");
    const existing = openDb(dest);
    setGuildConfig(existing, "999999999999999999", { hourly_cap: 5 }, "2026-03-01T00:00:00.000Z");
    existing.close();
    const existingDump = dumpAll(dest);

    await expect(
      runRestore({ archivePath, databasePath: dest, force: false }),
    ).rejects.toThrow(/--force/);
    expect(dumpAll(dest)).toEqual(existingDump);

    const result = await runRestore({ archivePath, databasePath: dest, force: true });

    expect(result.movedAsideTo).toBeDefined();
    expect(dumpAll(dest)).toEqual(dumpAll(source));
    // The replaced database is preserved, not deleted.
    expect(dumpAll(result.movedAsideTo!)).toEqual(existingDump);
  });

  it("migrates an older archive forward when it is opened", async () => {
    const source = join(work, "old.db");
    seedDatabase(source);
    ageToV18(source);

    const { archivePath, manifest } = await runBackup({
      databasePath: source,
      outDir: join(work, "archives"),
      env: {},
    });
    expect(manifest.schemaVersion).toBe(18);

    const dest = join(work, "old-restored.db");
    const result = await runRestore({ archivePath, databasePath: dest, force: false });

    expect(result.schemaVersionBefore).toBe(18);
    expect(result.schemaVersionAfter).toBe(SCHEMA_VERSION);

    // The v20 step rebuilds the wins table; the archived rows must survive it.
    const restored = new Database(dest, { readonly: true });
    const wins = restored.prepare(`SELECT user_id FROM wins`).all() as { user_id: string }[];
    restored.close();
    expect(wins.map((w) => w.user_id)).toEqual(["user-a"]);
  });

  it("rejects an archive that is not a Tombola backup", async () => {
    const stage = join(work, "not-a-backup");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "holiday-photo.jpg"), "not a database");
    const bogus = join(work, "bogus.tar.gz");
    await createArchive(stage, bogus, ["holiday-photo.jpg"]);

    const dest = join(work, "bogus-dest.db");
    await expect(
      runRestore({ archivePath: bogus, databasePath: dest, force: false }),
    ).rejects.toThrow(/not a Tombola backup/);
    expect(existsSync(dest)).toBe(false);
  });

  it("clears a stale WAL sidecar at the destination", async () => {
    const source = join(work, "src3.db");
    seedDatabase(source);
    const { archivePath } = await runBackup({
      databasePath: source,
      outDir: join(work, "archives"),
      env: {},
    });

    const dest = join(work, "stale.db");
    // Leftover sidecars with no database beside them. The rollback journal is
    // the dangerous one here: VACUUM INTO writes a rollback-mode file, so a
    // stale -journal would be replayed into the restored database on open.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      writeFileSync(`${dest}${suffix}`, Buffer.alloc(4096, 1));
    }

    await runRestore({ archivePath, databasePath: dest, force: false });

    for (const suffix of ["-wal", "-shm", "-journal"]) {
      expect(existsSync(`${dest}${suffix}`)).toBe(false);
    }
    expect(dumpAll(dest)).toEqual(dumpAll(source));
  });

  it("packs bare entry names, so the documented extract-by-name works", async () => {
    const source = join(work, "names.db");
    seedDatabase(source);
    const { archivePath } = await runBackup({
      databasePath: source,
      outDir: join(work, "archives"),
      env: {},
    });

    // No "./" prefixes and no directory entry: the README tells operators to
    // pull the compose file out with `tar -xzf <archive> compose.yaml`, and a
    // directory entry would stamp the staging dir's 0700 mode onto whatever
    // directory they unpack into.
    const listed = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.length > 0);
    expect(listed.sort()).toEqual([...ARCHIVE_ENTRIES].sort());

    const into = join(work, "extract-by-name");
    mkdirSync(into, { recursive: true });
    const modeBefore = statSync(into).mode & 0o777;
    execFileSync("tar", ["-xzf", archivePath, "-C", into, COMPOSE_ENTRY]);
    expect(existsSync(join(into, COMPOSE_ENTRY))).toBe(true);
    // The extraction directory keeps the mode it had, rather than inheriting
    // the staging directory's 0700 from a "./" entry.
    expect(statSync(into).mode & 0o777).toBe(modeBefore);
  });

});
