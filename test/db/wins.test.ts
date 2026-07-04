import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { createDraft } from "../../src/db/repositories/raffles.js";
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

/** Create a raffle in a guild (getUserWins joins through the raffle for its guild). */
function raffleIn(guild: string): number {
  return createDraft(db, guild, "creator", "2026-07-01T00:00:00.000Z");
}

describe("wins repository", () => {
  it("records a win and reads it back for the cooldown check", () => {
    const r = raffleIn("g1");
    const id = addWin(db, r, "u1", "2026-07-01T00:00:00.000Z");
    expect(id).toBeGreaterThan(0);
    expect(getUserWins(db, "g1", "u1")).toEqual([
      { raffleId: r, wonAt: "2026-07-01T00:00:00.000Z" },
    ]);
    expect(getWin(db, id)?.user_id).toBe("u1");
  });

  it("scopes wins to the guild the raffle ran in", () => {
    const r1 = raffleIn("g1");
    const r2 = raffleIn("g2");
    addWin(db, r1, "u1", "2026-07-01T00:00:00.000Z");
    addWin(db, r2, "u1", "2026-07-02T00:00:00.000Z");

    // The same user id can win in two servers; each guild sees only its own win,
    // so a win in one server never gates entry in another.
    expect(getUserWins(db, "g1", "u1").map((w) => w.raffleId)).toEqual([r1]);
    expect(getUserWins(db, "g2", "u1").map((w) => w.raffleId)).toEqual([r2]);
  });

  it("excludes rerolled wins from getUserWins but keeps them in the raffle list", () => {
    const r = raffleIn("g1");
    const a = addWin(db, r, "u1", "2026-07-01T00:00:00.000Z");
    addWin(db, r, "u2", "2026-07-01T00:01:00.000Z");
    markRerolled(db, a);

    // A disqualified win no longer gates the user's re-entry.
    expect(getUserWins(db, "g1", "u1")).toEqual([]);
    // But the full raffle history keeps it, in win order.
    expect(listWinsForRaffle(db, r).map((w) => [w.user_id, w.rerolled])).toEqual([
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
