import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { migrate } from "../../src/db/migrate.js";
import { SCHEMA_VERSION } from "../../src/db/schema.js";
import { addExternalWin, getUserWins } from "../../src/db/repositories/wins.js";

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

/** Strip the post-v9 columns (v10 entry gates, v11 claim window, v12 test flag,
 * v13 reset waiver) to simulate an older database that predates them. */
function dropPostV9Columns(db: BetterSqlite3.Database): void {
  db.exec(
    `ALTER TABLE raffles DROP COLUMN exclude_prior_winners;
     ALTER TABLE raffles DROP COLUMN required_role_id;
     ALTER TABLE raffles DROP COLUMN excluded_role_id;
     ALTER TABLE raffles DROP COLUMN claim_window_hours;
     ALTER TABLE raffles DROP COLUMN is_test;
     ALTER TABLE wins DROP COLUMN claim_deadline;
     ALTER TABLE wins DROP COLUMN claimed_at;
     ALTER TABLE wins DROP COLUMN cooldown_waived`,
  );
}

/** Strip the v19 column (the frozen activity measurement's capture marker) to
 * simulate a database that predates per-raffle activity snapshots. */
function dropV19Columns(db: BetterSqlite3.Database): void {
  db.exec(
    `ALTER TABLE raffles DROP COLUMN activity_snapshot_at;
     DROP TABLE IF EXISTS raffle_activity_snapshot`,
  );
}

/**
 * Rebuild `wins` in its pre-v20 shape (raffle_id NOT NULL, no guild_id/source/
 * note) to simulate a database from before a win could stand without a raffle.
 */
function restoreV19Wins(db: BetterSqlite3.Database): void {
  db.exec(
    `DROP INDEX IF EXISTS idx_wins_guild_user;
     CREATE TABLE wins_old (
       win_id     INTEGER PRIMARY KEY AUTOINCREMENT,
       raffle_id  INTEGER NOT NULL,
       user_id    TEXT NOT NULL,
       won_at     TEXT,
       rerolled   INTEGER NOT NULL DEFAULT 0,
       claim_deadline TEXT,
       claimed_at     TEXT,
       cooldown_waived INTEGER NOT NULL DEFAULT 0
     );
     INSERT INTO wins_old (win_id, raffle_id, user_id, won_at, rerolled,
                           claim_deadline, claimed_at, cooldown_waived)
       SELECT win_id, raffle_id, user_id, won_at, rerolled,
              claim_deadline, claimed_at, cooldown_waived FROM wins;
     DROP TABLE wins;
     ALTER TABLE wins_old RENAME TO wins;
     CREATE INDEX IF NOT EXISTS idx_wins_user ON wins (user_id);
     CREATE INDEX IF NOT EXISTS idx_wins_raffle ON wins (raffle_id)`,
  );
}

/** Strip the v15 columns (distinct-active-days floor, server-tenure default,
 * open-to-all escape hatch) to simulate a pre-v15 database. */
function dropV15Columns(db: BetterSqlite3.Database): void {
  db.exec(
    `ALTER TABLE guilds DROP COLUMN default_min_server_age_days;
     ALTER TABLE guilds DROP COLUMN default_req_active_days;
     ALTER TABLE raffles DROP COLUMN req_active_days;
     ALTER TABLE raffles DROP COLUMN open_to_all`,
  );
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
    // Recreate the index a pre-v9 database would still carry, and drop the v10
    // gate columns it would not yet have.
    db.exec(`CREATE INDEX idx_entries_raffle ON entries (raffle_id)`);
    dropPostV9Columns(db);
    dropV15Columns(db);
    dropV19Columns(db);
    db.pragma("user_version = 8");

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(indexNames(db, "entries")).not.toContain("idx_entries_raffle");
    // The v10 step re-adds the gate columns.
    expect(columnNames(db, "raffles")).toContain("exclude_prior_winners");
    // The v15 step re-adds the activity/tenure/open-to-all columns.
    expect(columnNames(db, "raffles")).toContain("open_to_all");
    expect(columnNames(db, "guilds")).toContain("default_min_server_age_days");
    db.close();
  });

  it("upgrades a pre-v8 database by adding raffles.draw_disqualified", () => {
    const db = openDb(":memory:");
    // Simulate a v7 database created before these columns existed.
    db.exec(`ALTER TABLE raffles DROP COLUMN draw_disqualified`);
    dropPostV9Columns(db);
    dropV15Columns(db);
    dropV19Columns(db);
    db.prepare(`INSERT INTO raffles (guild_id, status) VALUES ('g1', 'closed')`).run();
    db.pragma("user_version = 7");

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(columnNames(db, "raffles")).toContain("draw_disqualified");
    expect(columnNames(db, "raffles")).toContain("required_role_id");
    // The later steps re-add the v12 test flag and the v13 reset waiver, each
    // backfilling the preserved row to its off default.
    expect(columnNames(db, "raffles")).toContain("is_test");
    expect(columnNames(db, "wins")).toContain("cooldown_waived");
    expect(db.prepare(`SELECT guild_id, is_test FROM raffles`).get()).toEqual({
      guild_id: "g1",
      is_test: 0,
    });
    db.close();
  });

  it("backfills a null draw_mode to 'auto' when upgrading past v13", () => {
    const db = openDb(":memory:");
    // A pre-v14 draft carried draw_mode NULL even though the wizard rendered it
    // as 'auto' — validation then rejected the untouched select (see raffles.ts
    // createDraft). Simulate one and migrate.
    dropV15Columns(db);
    dropV19Columns(db);
    db.prepare(`INSERT INTO raffles (guild_id, status, draw_mode) VALUES ('g1', 'draft', NULL)`).run();
    db.prepare(`INSERT INTO raffles (guild_id, status, draw_mode) VALUES ('g1', 'draft', 'manual')`).run();
    db.pragma("user_version = 13");

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const modes = db.prepare(`SELECT draw_mode FROM raffles ORDER BY raffle_id`).all();
    expect(modes).toEqual([{ draw_mode: "auto" }, { draw_mode: "manual" }]);
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

describe("v20: a win no longer needs a raffle", () => {
  it("rebuilds wins, backfills guild_id, and keeps existing wins gating", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO raffles (raffle_id, guild_id, status) VALUES (41, 'g1', 'drawn')`,
    ).run();
    db.prepare(
      `INSERT INTO wins (win_id, raffle_id, guild_id, source, user_id, won_at, cooldown_waived)
       VALUES (7, 41, 'g1', 'raffle', 'u1', '2026-07-01T00:00:00.000Z', 0)`,
    ).run();
    restoreV19Wins(db);
    db.pragma("user_version = 19");

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(columnNames(db, "wins")).toEqual(
      expect.arrayContaining(["guild_id", "source", "note"]),
    );
    // The win survives with its id — the draw and claim paths hold win_ids — and
    // its guild is backfilled from the raffle it came from.
    const row = db.prepare(`SELECT * FROM wins WHERE win_id = 7`).get() as {
      raffle_id: number;
      guild_id: string;
      source: string;
      note: string | null;
      user_id: string;
    };
    expect(row).toMatchObject({ raffle_id: 41, guild_id: "g1", source: "raffle", note: null });
    // Which means the cooldown it was gating still gates.
    expect(getUserWins(db, "g1", "u1")).toEqual([
      { raffleId: 41, wonAt: "2026-07-01T00:00:00.000Z" },
    ]);
    db.close();
  });

  it("accepts a raffle-less win only after the upgrade", () => {
    const db = openDb(":memory:");
    restoreV19Wins(db);
    // The old shape declares raffle_id NOT NULL, so an import cannot be stored.
    expect(() =>
      addExternalWin(db, { guildId: "g1", userId: "u1", wonAt: "2026-06-01T00:00:00.000Z", note: null }),
    ).toThrow();

    db.pragma("user_version = 19");
    migrate(db);

    expect(() =>
      addExternalWin(db, { guildId: "g1", userId: "u1", wonAt: "2026-06-01T00:00:00.000Z", note: null }),
    ).not.toThrow();
    expect(getUserWins(db, "g1", "u1")).toHaveLength(1);
    db.close();
  });

  it("re-creates the wins indexes the rebuild dropped", () => {
    const db = openDb(":memory:");
    restoreV19Wins(db);
    db.pragma("user_version = 19");

    migrate(db);

    expect(indexNames(db, "wins")).toEqual(
      expect.arrayContaining(["idx_wins_user", "idx_wins_raffle", "idx_wins_guild_user"]),
    );
    db.close();
  });
});
