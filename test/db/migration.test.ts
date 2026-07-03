import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { migrate } from "../../src/db/migrate.js";

function columnNames(db: BetterSqlite3.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

describe("schema v3 migration", () => {
  it("a fresh database is at v3 with the announce-channel columns", () => {
    const db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(3);
    expect(columnNames(db, "guilds")).toContain("announce_channel");
    expect(columnNames(db, "raffles")).toContain("channel_id");
    db.close();
  });

  it("upgrades an older database, adding columns without losing data", () => {
    // A minimal pre-v3 database: the tables lack the new columns.
    const db = new BetterSqlite3(":memory:");
    db.exec(`CREATE TABLE guilds (guild_id TEXT PRIMARY KEY, audit_channel TEXT);`);
    db.exec(`CREATE TABLE raffles (raffle_id INTEGER PRIMARY KEY, guild_id TEXT, status TEXT);`);
    db.prepare(`INSERT INTO guilds (guild_id) VALUES ('g1')`).run();
    db.prepare(`INSERT INTO raffles (raffle_id, guild_id, status) VALUES (1, 'g1', 'open')`).run();
    db.pragma("user_version = 2");

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(3);
    expect(columnNames(db, "guilds")).toContain("announce_channel");
    expect(columnNames(db, "raffles")).toContain("channel_id");
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
    expect(db.pragma("user_version", { simple: true })).toBe(3);
    db.close();
  });
});
