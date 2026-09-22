import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { addEntry, hasEntry } from "../../src/db/repositories/entries.js";
import {
  createDraft,
  getRaffle,
  setStatus,
  updateRaffleFields,
  type RaffleRow,
} from "../../src/db/repositories/raffles.js";
import { withdrawEntry } from "../../src/entries/withdrawal.js";

/**
 * The shared withdrawal path behind `/raffle withdraw` and
 * `/raffle-mod remove-entry`. Whose act it was is derived from the ids rather
 * than passed in, so these tests pin that derivation — it is the one place the
 * audit trail could quietly start lying about who did what.
 */

let db: Database;
const NOW = "2026-07-15T12:00:00.000Z";

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

function seedRaffle(status: "open" | "closed" = "open"): RaffleRow {
  const id = createDraft(db, "g1", "mod1", NOW);
  updateRaffleFields(db, id, { name: "R", prize: "P" });
  setStatus(db, id, status);
  return getRaffle(db, id)!;
}

function auditCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number }).n;
}

describe("withdrawEntry", () => {
  it("records a member withdrawing their own entry as a plain withdrawal", () => {
    const raffle = seedRaffle();
    addEntry(db, raffle.raffle_id, "u1", NOW);

    const result = withdrawEntry(db, { raffle, userId: "u1", actorId: "u1", now: NOW });

    expect(result).toMatchObject({ ok: true, byModerator: false });
    expect(result.ok && result.event.eventType).toBe("entry_withdrawn");
    expect(hasEntry(db, raffle.raffle_id, "u1")).toBe(false);
  });

  it("records a different actor as a moderator-assisted withdrawal", () => {
    const raffle = seedRaffle();
    addEntry(db, raffle.raffle_id, "u1", NOW);

    const result = withdrawEntry(db, { raffle, userId: "u1", actorId: "mod1", now: NOW });

    expect(result).toMatchObject({ ok: true, byModerator: true });
    expect(result.ok && result.event.eventType).toBe("entry_withdrawn_by_mod");
    expect(result.ok && result.event.actorId).toBe("mod1");
    expect(result.ok && result.event.payload).toEqual({ userId: "u1" });
  });

  it("treats a moderator withdrawing their own entry as the self-withdrawal it is", () => {
    const raffle = seedRaffle();
    addEntry(db, raffle.raffle_id, "mod1", NOW);

    const result = withdrawEntry(db, { raffle, userId: "mod1", actorId: "mod1", now: NOW });

    expect(result).toMatchObject({ ok: true, byModerator: false });
  });

  it("writes nothing when the raffle is not open", () => {
    const raffle = seedRaffle("closed");
    addEntry(db, raffle.raffle_id, "u1", NOW);

    expect(withdrawEntry(db, { raffle, userId: "u1", actorId: "mod1", now: NOW })).toEqual({
      ok: false,
      reason: "not_open",
    });
    expect(hasEntry(db, raffle.raffle_id, "u1")).toBe(true);
    expect(auditCount()).toBe(0);
  });

  it("writes nothing when the member holds no active entry", () => {
    const raffle = seedRaffle();

    expect(withdrawEntry(db, { raffle, userId: "u1", actorId: "mod1", now: NOW })).toEqual({
      ok: false,
      reason: "no_entry",
    });
    expect(auditCount()).toBe(0);
  });

  it("refuses a second withdrawal of an already-removed entry", () => {
    const raffle = seedRaffle();
    addEntry(db, raffle.raffle_id, "u1", NOW);
    withdrawEntry(db, { raffle, userId: "u1", actorId: "u1", now: NOW });

    expect(withdrawEntry(db, { raffle, userId: "u1", actorId: "mod1", now: NOW })).toEqual({
      ok: false,
      reason: "no_entry",
    });
  });
});
