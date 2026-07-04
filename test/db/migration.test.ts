import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { migrate } from "../../src/db/migrate.js";
import { SCHEMA_VERSION } from "../../src/db/schema.js";

// A unique on-disk path so the reopen test exercises real persistence.
const dbPath = join(tmpdir(), `vernissage-migration-test-${process.pid}.db`);

afterEach(() => {
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

function columnNames(db: BetterSqlite3.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

function indexNames(db: BetterSqlite3.Database, table: string): string[] {
  return (db.pragma(`index_list(${table})`) as Array<{ name: string }>).map((i) => i.name);
}

describe("schema", () => {
  it("a fresh database has the full current schema at the current version", () => {
    const db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);

    // Columns that accumulated across the (now flattened) schema history.
    expect(columnNames(db, "guilds")).toEqual(
      expect.arrayContaining([
        "announce_channel",
        "blacklist_generic_message",
        "default_req_messages",
        "default_req_days",
        "timezone",
      ]),
    );
    expect(columnNames(db, "raffles")).toEqual(
      expect.arrayContaining(["channel_id", "draw_commitment", "draw_secret"]),
    );
    // The wizard_state table (once its own migration) is part of the baseline.
    expect(columnNames(db, "wizard_state")).toContain("step");

    db.close();
  });

  it("has the intended index layout", () => {
    const db = openDb(":memory:");
    // activity: only the pruning-by-day index; the PK covers the window lookup.
    expect(indexNames(db, "activity")).toContain("idx_activity_day");
    expect(indexNames(db, "activity")).not.toContain("idx_activity_guild_user_day");
    // audit_log: seek by raffle_id only; no unused guild-leading index.
    expect(indexNames(db, "audit_log")).toContain("idx_audit_raffle");
    expect(indexNames(db, "audit_log")).not.toContain("idx_audit_guild_raffle");
    // wins: read by raffle_id (draw/reroll) and by user_id (cooldown).
    expect(indexNames(db, "wins")).toContain("idx_wins_raffle");
    expect(indexNames(db, "wins")).toContain("idx_wins_user");
    // entries: no raffle_id index; the (raffle_id, user_id) PK already covers it.
    expect(indexNames(db, "entries")).not.toContain("idx_entries_raffle");
    db.close();
  });

  it("upgrades a pre-v9 database by dropping the redundant idx_entries_raffle", () => {
    const db = openDb(":memory:");
    // Recreate the index a pre-v9 database would still carry.
    db.exec(`CREATE INDEX idx_entries_raffle ON entries (raffle_id)`);
    db.pragma("user_version = 8");

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(indexNames(db, "entries")).not.toContain("idx_entries_raffle");
    db.close();
  });

  it("upgrades a pre-v8 database by adding raffles.draw_disqualified", () => {
    const db = openDb(":memory:");
    // Simulate a v7 database created before the column existed.
    db.exec(`ALTER TABLE raffles DROP COLUMN draw_disqualified`);
    db.prepare(`INSERT INTO raffles (guild_id, status) VALUES ('g1', 'closed')`).run();
    db.pragma("user_version = 7");

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(columnNames(db, "raffles")).toContain("draw_disqualified");
    // The upgrade preserves existing rows.
    expect(db.prepare(`SELECT guild_id FROM raffles`).get()).toEqual({ guild_id: "g1" });
    db.close();
  });

  it("is idempotent — running migrate again does not error or change the version", () => {
    const db = openDb(":memory:");
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("leaves an existing database and its data intact when reopened", () => {
    // Reopening runs migrate again; the baseline gate must skip re-applying the
    // schema and no data may be lost.
    const db1 = openDb(dbPath);
    db1.prepare(`INSERT INTO guilds (guild_id, created_at) VALUES ('g1', 't')`).run();
    db1.close();

    const db2 = openDb(dbPath);
    expect(db2.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(db2.prepare(`SELECT guild_id FROM guilds`).get()).toEqual({ guild_id: "g1" });
    db2.close();
  });
});
