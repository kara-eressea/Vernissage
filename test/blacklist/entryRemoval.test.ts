import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { removeEntriesForBan } from "../../src/blacklist/entryRemoval.js";
import { addBan, isBlacklisted } from "../../src/db/repositories/blacklist.js";
import { addEntry, hasEntry } from "../../src/db/repositories/entries.js";
import {
  createDraft,
  setStatus,
  type RaffleRow,
} from "../../src/db/repositories/raffles.js";
import type { RaffleStatus } from "../../src/core/types.js";

let db: Database;
const NOW = "2026-07-15T12:00:00.000Z";

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

function seedRaffle(guildId: string, status: RaffleStatus): number {
  const id = createDraft(db, guildId, "mod", NOW);
  setStatus(db, id, status);
  return id;
}

function entryRow(raffleId: number, userId: string): RaffleRow | undefined {
  return db
    .prepare(`SELECT removed_at, removed_reason FROM entries WHERE raffle_id = ? AND user_id = ?`)
    .get(raffleId, userId) as RaffleRow | undefined;
}

function auditCount(raffleId: number): number {
  return (
    db
      .prepare(`SELECT count(*) AS n FROM audit_log WHERE raffle_id = ? AND event_type = 'entry_removed'`)
      .get(raffleId) as { n: number }
  ).n;
}

describe("removeEntriesForBan", () => {
  it("soft-removes an active entry in an open raffle and audits it", () => {
    const raffleId = seedRaffle("g1", "open");
    addEntry(db, raffleId, "u1", NOW);

    const affected = removeEntriesForBan(db, "g1", "u1", NOW, "mod");

    expect(affected).toEqual([raffleId]);
    const row = entryRow(raffleId, "u1") as unknown as {
      removed_at: string;
      removed_reason: string;
    };
    expect(row.removed_at).toBe(NOW);
    expect(row.removed_reason).toBe("blacklisted");
    expect(hasEntry(db, raffleId, "u1")).toBe(false);
    expect(auditCount(raffleId)).toBe(1);
  });

  it("does not touch entries in non-open raffles", () => {
    const closed = seedRaffle("g1", "closed");
    const drawn = seedRaffle("g1", "drawn");
    addEntry(db, closed, "u1", NOW);
    addEntry(db, drawn, "u1", NOW);

    expect(removeEntriesForBan(db, "g1", "u1", NOW, "mod")).toEqual([]);
    expect(hasEntry(db, closed, "u1")).toBe(true);
    expect(auditCount(closed)).toBe(0);
  });

  it("scopes to the guild and does nothing for a user with no active entry", () => {
    const otherGuild = seedRaffle("g2", "open");
    addEntry(db, otherGuild, "u1", NOW);
    expect(removeEntriesForBan(db, "g1", "u1", NOW, "mod")).toEqual([]);
    expect(hasEntry(db, otherGuild, "u1")).toBe(true);
  });

  it("regression: a blacklist expiry never restores a removed entry", () => {
    const raffleId = seedRaffle("g1", "open");
    addEntry(db, raffleId, "u1", NOW);
    addBan(db, {
      guildId: "g1",
      userId: "u1",
      bannedBy: "mod",
      reason: null,
      bannedAt: NOW,
      expiresAt: "2026-07-16T12:00:00.000Z",
    });
    removeEntriesForBan(db, "g1", "u1", NOW, "mod");

    // Advance past the expiry: the ban lifts, but the removed entry stays removed
    // (design.md: "expiry lifts the ban but does not restore removed entries").
    const later = "2026-07-20T00:00:00.000Z";
    expect(isBlacklisted(db, "g1", "u1", later)).toBe(false);
    const row = entryRow(raffleId, "u1") as unknown as { removed_at: string };
    expect(row.removed_at).toBe(NOW);
  });
});
