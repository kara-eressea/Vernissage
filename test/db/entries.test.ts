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
