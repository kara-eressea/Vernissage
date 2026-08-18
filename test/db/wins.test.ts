import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { createDraft, updateRaffleFields } from "../../src/db/repositories/raffles.js";
import {
  activeWinnerIds,
  addExternalWin,
  addWin,
  getActiveWinForUser,
  getUserWins,
  getWin,
  listExternalWins,
  listExpiredUnclaimedWins,
  listWinsForRaffle,
  markRerolled,
  waiveUserWins,
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

  it("excludes wins from test raffles so a test win never gates re-entry", () => {
    const real = raffleIn("g1");
    const test = raffleIn("g1");
    updateRaffleFields(db, test, { is_test: 1 });
    addWin(db, real, "u1", "2026-07-01T00:00:00.000Z");
    addWin(db, test, "u1", "2026-07-02T00:00:00.000Z");

    // Only the real win counts toward the cooldown / prior-winner history.
    expect(getUserWins(db, "g1", "u1")).toEqual([
      { raffleId: real, wonAt: "2026-07-01T00:00:00.000Z" },
    ]);
  });

  it("waiveUserWins lifts a user's wins from the gating history, scoped to the guild", () => {
    const r1 = raffleIn("g1");
    const r2 = raffleIn("g1");
    const other = raffleIn("g2");
    addWin(db, r1, "u1", "2026-07-01T00:00:00.000Z");
    addWin(db, r2, "u1", "2026-07-02T00:00:00.000Z");
    addWin(db, r1, "u2", "2026-07-01T00:00:00.000Z"); // another member, untouched
    addWin(db, other, "u1", "2026-07-03T00:00:00.000Z"); // same user, other guild

    const waived = waiveUserWins(db, "g1", "u1");
    expect(waived).toBe(2);
    // u1 no longer has gating wins in g1...
    expect(getUserWins(db, "g1", "u1")).toEqual([]);
    // ...but the other member and the other guild are unaffected.
    expect(getUserWins(db, "g1", "u2").map((w) => w.raffleId)).toEqual([r1]);
    expect(getUserWins(db, "g2", "u1").map((w) => w.raffleId)).toEqual([other]);
  });

  it("waiveUserWins is idempotent and reports how many it cleared", () => {
    const r = raffleIn("g1");
    addWin(db, r, "u1", "2026-07-01T00:00:00.000Z");
    expect(waiveUserWins(db, "g1", "u1")).toBe(1);
    // A second call finds nothing still gating.
    expect(waiveUserWins(db, "g1", "u1")).toBe(0);
    // No wins at all is a clean zero.
    expect(waiveUserWins(db, "g1", "nobody")).toBe(0);
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

describe("imported wins", () => {
  const WON = "2026-06-15T00:00:00.000Z";

  function importWin(guild = "g1", user = "u1", note: string | null = "Summer art contest"): number {
    return addExternalWin(db, { guildId: guild, userId: user, wonAt: WON, note });
  }

  it("gates the cooldown even though it has no raffle", () => {
    importWin();
    // The old query joined through raffles, which would have dropped this row
    // entirely — recorded, but gating nothing.
    expect(getUserWins(db, "g1", "u1")).toEqual([{ raffleId: null, wonAt: WON }]);
  });

  it("stays inside its own guild", () => {
    importWin("g1");
    expect(getUserWins(db, "g2", "u1")).toEqual([]);
  });

  it("is not mistaken for a test-raffle win by the is_test filter", () => {
    // `r.is_test = 0` is NULL for a raffle-less win, so an unguarded filter would
    // silently exclude every import.
    importWin();
    expect(getUserWins(db, "g1", "u1")).toHaveLength(1);
  });

  it("is waived by the reset path, which is its only undo", () => {
    importWin();
    expect(waiveUserWins(db, "g1", "u1")).toBe(1);
    expect(getUserWins(db, "g1", "u1")).toEqual([]);
  });

  it("never appears in any raffle-keyed query", () => {
    const r = raffleIn("g1");
    addWin(db, r, "u2", "2026-07-01T00:00:00.000Z");
    importWin("g1", "u1");

    // No raffle to belong to, so the draw, reroll, claim and verifier reads,
    // which all key on raffle_id, can never pick it up.
    expect(listWinsForRaffle(db, r).map((w) => w.user_id)).toEqual(["u2"]);
    expect(activeWinnerIds(db, r)).toEqual(["u2"]);
    expect(getActiveWinForUser(db, r, "u1")).toBeUndefined();
    expect(listExpiredUnclaimedWins(db, "2027-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("records the source and the note, and lists them newest first", () => {
    addExternalWin(db, { guildId: "g1", userId: "u1", wonAt: WON, note: "Art contest" });
    addExternalWin(db, {
      guildId: "g1",
      userId: "u2",
      wonAt: "2026-07-20T00:00:00.000Z",
      note: null,
    });
    const r = raffleIn("g1");
    addWin(db, r, "u3", "2026-07-01T00:00:00.000Z");

    const listed = listExternalWins(db, "g1");

    // Drawn wins are excluded: those are already visible as raffles.
    expect(listed.map((w) => w.user_id)).toEqual(["u2", "u1"]);
    expect(listed[1]).toMatchObject({ source: "external", note: "Art contest", raffle_id: null });
  });

  it("gives a drawn win the guild of its raffle without the caller passing one", () => {
    const r = raffleIn("g7");
    const id = addWin(db, r, "u1", "2026-07-01T00:00:00.000Z");
    expect(getWin(db, id)).toMatchObject({ guild_id: "g7", source: "raffle", note: null });
  });
});
