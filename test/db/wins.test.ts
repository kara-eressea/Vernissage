import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import {
  activeWinnerIds,
  addWin,
  getUserWins,
  getWin,
  listWinsForRaffle,
  markRerolled,
} from "../../src/db/repositories/wins.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("wins repository", () => {
  it("records a win and reads it back for the cooldown check", () => {
    const id = addWin(db, 1, "u1", "2026-07-01T00:00:00.000Z");
    expect(id).toBeGreaterThan(0);
    expect(getUserWins(db, "u1")).toEqual([
      { raffleId: 1, wonAt: "2026-07-01T00:00:00.000Z" },
    ]);
    expect(getWin(db, id)?.user_id).toBe("u1");
  });

  it("excludes rerolled wins from getUserWins but keeps them in the raffle list", () => {
    const a = addWin(db, 1, "u1", "2026-07-01T00:00:00.000Z");
    addWin(db, 1, "u2", "2026-07-01T00:01:00.000Z");
    markRerolled(db, a);

    // A disqualified win no longer gates the user's re-entry.
    expect(getUserWins(db, "u1")).toEqual([]);
    // But the full raffle history keeps it, in win order.
    expect(listWinsForRaffle(db, 1).map((w) => [w.user_id, w.rerolled])).toEqual([
      ["u1", 1],
      ["u2", 0],
    ]);
  });

  it("activeWinnerIds returns only non-rerolled winners, oldest first", () => {
    const a = addWin(db, 5, "u1", "2026-07-01T00:00:00.000Z");
    addWin(db, 5, "u2", "2026-07-01T00:01:00.000Z");
    addWin(db, 5, "u3", "2026-07-01T00:02:00.000Z");
    markRerolled(db, a);
    expect(activeWinnerIds(db, 5)).toEqual(["u2", "u3"]);
  });

  it("scopes reads to the raffle", () => {
    addWin(db, 1, "u1", "2026-07-01T00:00:00.000Z");
    addWin(db, 2, "u2", "2026-07-01T00:00:00.000Z");
    expect(listWinsForRaffle(db, 1).map((w) => w.user_id)).toEqual(["u1"]);
    expect(activeWinnerIds(db, 2)).toEqual(["u2"]);
  });
});
