import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import {
  deleteUserActivity,
  getCountsInWindow,
  incrementActivity,
  listGuildCountsInWindow,
  pruneActivityBefore,
} from "../../src/db/repositories/activity.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("activity buckets", () => {
  it("accumulates on the same bucket via upsert", () => {
    incrementActivity(db, "g1", "u1", "2026-07-03", 2);
    incrementActivity(db, "g1", "u1", "2026-07-03", 3);
    const counts = getCountsInWindow(db, "g1", "u1", "2026-07-03", "2026-07-03");
    expect(counts).toEqual([{ day: "2026-07-03", count: 5 }]);
  });

  it("keeps separate buckets per user, guild, and day", () => {
    incrementActivity(db, "g1", "u1", "2026-07-03", 1);
    incrementActivity(db, "g1", "u2", "2026-07-03", 4);
    incrementActivity(db, "g1", "u1", "2026-07-04", 7);
    incrementActivity(db, "g2", "u1", "2026-07-03", 9);

    expect(getCountsInWindow(db, "g1", "u1", "2026-07-01", "2026-07-31")).toEqual([
      { day: "2026-07-03", count: 1 },
      { day: "2026-07-04", count: 7 },
    ]);
  });

  it("reads only days within the inclusive window", () => {
    for (const day of ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]) {
      incrementActivity(db, "g1", "u1", day, 1);
    }
    const counts = getCountsInWindow(db, "g1", "u1", "2026-07-02", "2026-07-03");
    expect(counts.map((c) => c.day)).toEqual(["2026-07-02", "2026-07-03"]);
  });

  it("prunes rows strictly before the cutoff day", () => {
    incrementActivity(db, "g1", "u1", "2026-06-01", 1);
    incrementActivity(db, "g1", "u1", "2026-06-30", 1);
    incrementActivity(db, "g1", "u1", "2026-07-01", 1);

    const removed = pruneActivityBefore(db, "2026-07-01");
    expect(removed).toBe(2);
    expect(getCountsInWindow(db, "g1", "u1", "2026-01-01", "2026-12-31")).toEqual([
      { day: "2026-07-01", count: 1 },
    ]);
  });

  it("listGuildCountsInWindow groups every active user's counts, guild- and window-scoped", () => {
    incrementActivity(db, "g1", "u1", "2026-07-03", 5);
    incrementActivity(db, "g1", "u1", "2026-07-04", 2);
    incrementActivity(db, "g1", "u2", "2026-07-04", 9);
    incrementActivity(db, "g1", "u3", "2026-07-01", 4); // before window, excluded
    incrementActivity(db, "g2", "u1", "2026-07-04", 7); // other guild, excluded

    const result = listGuildCountsInWindow(db, "g1", "2026-07-02", "2026-07-31");
    expect(result).toEqual([
      {
        userId: "u1",
        counts: [
          { day: "2026-07-03", count: 5 },
          { day: "2026-07-04", count: 2 },
        ],
      },
      { userId: "u2", counts: [{ day: "2026-07-04", count: 9 }] },
    ]);
  });

  it("listGuildCountsInWindow returns nothing for a guild with no activity in range", () => {
    incrementActivity(db, "g1", "u1", "2026-07-03", 5);
    expect(listGuildCountsInWindow(db, "g1", "2026-08-01", "2026-08-31")).toEqual([]);
  });

  it("deleteUserActivity removes one member's rows, scoped to the guild", () => {
    incrementActivity(db, "g1", "u1", "2026-07-03", 5);
    incrementActivity(db, "g1", "u1", "2026-07-04", 2);
    incrementActivity(db, "g1", "u2", "2026-07-03", 9); // other member, kept
    incrementActivity(db, "g2", "u1", "2026-07-03", 4); // other guild, kept

    const removed = deleteUserActivity(db, "g1", "u1");
    expect(removed).toBe(2);
    expect(getCountsInWindow(db, "g1", "u1", "2026-01-01", "2026-12-31")).toEqual([]);
    expect(getCountsInWindow(db, "g1", "u2", "2026-01-01", "2026-12-31")).toEqual([
      { day: "2026-07-03", count: 9 },
    ]);
    expect(getCountsInWindow(db, "g2", "u1", "2026-01-01", "2026-12-31")).toEqual([
      { day: "2026-07-03", count: 4 },
    ]);
  });
});
