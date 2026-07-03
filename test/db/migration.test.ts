import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { migrate } from "../../src/db/migrate.js";
import { SCHEMA_VERSION } from "../../src/db/schema.js";

function columnNames(db: BetterSqlite3.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

function indexNames(db: BetterSqlite3.Database, table: string): string[] {
  return (db.pragma(`index_list(${table})`) as Array<{ name: string }>).map((i) => i.name);
}

describe("schema migration", () => {
  it("a fresh database is at the current version with the announce-channel and blacklist columns", () => {
    const db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(columnNames(db, "guilds")).toContain("announce_channel");
    expect(columnNames(db, "raffles")).toContain("channel_id");
    expect(columnNames(db, "guilds")).toContain("blacklist_generic_message");
    // v6 commit-reveal columns.
    expect(columnNames(db, "raffles")).toContain("draw_commitment");
    expect(columnNames(db, "raffles")).toContain("draw_secret");
    // v7 guild defaults + timezone.
    expect(columnNames(db, "guilds")).toContain("default_req_messages");
    expect(columnNames(db, "guilds")).toContain("default_req_days");
    expect(columnNames(db, "guilds")).toContain("timezone");
    db.close();
  });

  it("a fresh database has the v5 index layout (redundant activity index dropped, audit-by-raffle index present)", () => {
    const db = openDb(":memory:");
    expect(indexNames(db, "activity")).not.toContain("idx_activity_guild_user_day");
    expect(indexNames(db, "activity")).toContain("idx_activity_day");
    expect(indexNames(db, "audit_log")).toContain("idx_audit_raffle");
    db.close();
  });

  it("upgrades an older database, adding columns without losing data", () => {
    // A minimal pre-v3 database. A real v2 DB was built by the v1 baseline, so
    // it carries all v1 tables and the (then-present) redundant activity index.
    const db = new BetterSqlite3(":memory:");
    db.exec(`CREATE TABLE guilds (guild_id TEXT PRIMARY KEY, audit_channel TEXT);`);
    db.exec(`CREATE TABLE raffles (raffle_id INTEGER PRIMARY KEY, guild_id TEXT, status TEXT);`);
    db.exec(`CREATE TABLE activity (guild_id TEXT, user_id TEXT, day TEXT, count INTEGER,
      PRIMARY KEY (guild_id, user_id, day));`);
    db.exec(`CREATE INDEX idx_activity_guild_user_day ON activity (guild_id, user_id, day);`);
    db.exec(`CREATE TABLE audit_log (event_id INTEGER PRIMARY KEY, raffle_id INTEGER);`);
    db.prepare(`INSERT INTO guilds (guild_id) VALUES ('g1')`).run();
    db.prepare(`INSERT INTO raffles (raffle_id, guild_id, status) VALUES (1, 'g1', 'open')`).run();
    db.pragma("user_version = 2");

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(columnNames(db, "guilds")).toContain("announce_channel");
    expect(columnNames(db, "raffles")).toContain("channel_id");
    expect(columnNames(db, "guilds")).toContain("blacklist_generic_message");
    expect(columnNames(db, "raffles")).toContain("draw_commitment");
    expect(columnNames(db, "raffles")).toContain("draw_secret");
    expect(columnNames(db, "guilds")).toContain("default_req_messages");
    expect(columnNames(db, "guilds")).toContain("timezone");
    // v5 index hygiene applied to the existing database.
    expect(indexNames(db, "activity")).not.toContain("idx_activity_guild_user_day");
    expect(indexNames(db, "audit_log")).toContain("idx_audit_raffle");
    // Existing rows survive; the new columns default to null.
    expect(db.prepare(`SELECT announce_channel FROM guilds WHERE guild_id='g1'`).get()).toEqual({
      announce_channel: null,
    });
    expect(db.prepare(`SELECT status FROM raffles WHERE raffle_id=1`).get()).toEqual({
      status: "open",
    });
    db.close();
  });

  it("is idempotent — running migrate again does not error", () => {
    const db = openDb(":memory:");
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });
});
