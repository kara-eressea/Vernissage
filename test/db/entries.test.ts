import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import {
  addEntry,
  hasEntry,
  listEntrants,
  removeEntry,
} from "../../src/db/repositories/entries.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("entries", () => {
  it("records and detects an active entry", () => {
    addEntry(db, 1, "u1", "2026-07-03T00:00:00.000Z");
    expect(hasEntry(db, 1, "u1")).toBe(true);
    expect(hasEntry(db, 1, "u2")).toBe(false);
  });

  it("enforces one entry per user per raffle", () => {
    addEntry(db, 1, "u1", "2026-07-03T00:00:00.000Z");
    expect(() => addEntry(db, 1, "u1", "2026-07-03T01:00:00.000Z")).toThrow();
  });

  it("reinstates a removed entry on re-entry, clearing the removal fields", () => {
    addEntry(db, 1, "u1", "2026-07-03T00:00:00.000Z");
    removeEntry(db, 1, "u1", "2026-07-04T00:00:00.000Z", "withdrawn");
    expect(hasEntry(db, 1, "u1")).toBe(false);

    addEntry(db, 1, "u1", "2026-07-05T00:00:00.000Z");

    expect(hasEntry(db, 1, "u1")).toBe(true);
    const row = db
      .prepare(`SELECT entered_at, removed_at, removed_reason FROM entries WHERE raffle_id = 1 AND user_id = 'u1'`)
      .get() as { entered_at: string; removed_at: string | null; removed_reason: string | null };
    expect(row).toEqual({
      entered_at: "2026-07-05T00:00:00.000Z",
      removed_at: null,
      removed_reason: null,
    });
  });

  it("allows the same user to enter different raffles", () => {
    addEntry(db, 1, "u1", "2026-07-03T00:00:00.000Z");
    addEntry(db, 2, "u1", "2026-07-03T00:00:00.000Z");
    expect(hasEntry(db, 1, "u1")).toBe(true);
    expect(hasEntry(db, 2, "u1")).toBe(true);
  });

  it("soft-removes an entry so it no longer counts as active", () => {
    addEntry(db, 1, "u1", "2026-07-03T00:00:00.000Z");
    removeEntry(db, 1, "u1", "2026-07-04T00:00:00.000Z", "blacklisted");
    expect(hasEntry(db, 1, "u1")).toBe(false);
  });

  it("lists active entrants sorted ascending, excluding removed ones", () => {
    addEntry(db, 1, "u3", "2026-07-03T00:00:00.000Z");
    addEntry(db, 1, "u1", "2026-07-03T00:00:00.000Z");
    addEntry(db, 1, "u2", "2026-07-03T00:00:00.000Z");
    removeEntry(db, 1, "u2", "2026-07-04T00:00:00.000Z");
    expect(listEntrants(db, 1)).toEqual(["u1", "u3"]);
  });
});
