import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { addEntry } from "../../src/db/repositories/entries.js";
import {
  getMemberName,
  getMemberNames,
  listUnnamedRaffleMemberIds,
  upsertMemberName,
  upsertMemberNames,
} from "../../src/db/repositories/members.js";
import { createDraft } from "../../src/db/repositories/raffles.js";
import { addWin } from "../../src/db/repositories/wins.js";

const NOW = "2026-07-15T12:00:00.000Z";
const LATER = "2026-07-16T12:00:00.000Z";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("member name cache", () => {
  it("upserts and reads back a single name", () => {
    upsertMemberName(db, {
      guildId: "g1",
      userId: "100",
      username: "alice",
      displayName: "Alice",
      updatedAt: NOW,
    });
    expect(getMemberName(db, "g1", "100")).toEqual({ username: "alice", displayName: "Alice" });
    expect(getMemberName(db, "g1", "999")).toBeUndefined();
  });

  it("last write wins on conflict", () => {
    upsertMemberName(db, { guildId: "g1", userId: "100", username: "alice", displayName: "Alice", updatedAt: NOW });
    upsertMemberName(db, { guildId: "g1", userId: "100", username: "alice", displayName: "Alice in Wonderland", updatedAt: LATER });
    expect(getMemberName(db, "g1", "100")?.displayName).toBe("Alice in Wonderland");
  });

  it("scopes names per guild", () => {
    upsertMemberName(db, { guildId: "g1", userId: "100", username: "alice", displayName: "Alice", updatedAt: NOW });
    expect(getMemberName(db, "g2", "100")).toBeUndefined();
  });

  it("returns a map for a set of ids, omitting the unknown ones", () => {
    upsertMemberNames(db, [
      { guildId: "g1", userId: "100", username: "alice", displayName: "Alice", updatedAt: NOW },
      { guildId: "g1", userId: "200", username: "bob", displayName: "Bob", updatedAt: NOW },
    ]);
    const map = getMemberNames(db, "g1", ["100", "200", "300"]);
    expect(map.get("100")?.displayName).toBe("Alice");
    expect(map.get("200")?.displayName).toBe("Bob");
    expect(map.has("300")).toBe(false);
  });

  it("lists entrant/winner ids that have no cached name", () => {
    const raffleId = createDraft(db, "g1", "creator", NOW);
    addEntry(db, raffleId, "100", NOW);
    addEntry(db, raffleId, "200", NOW);
    addWin(db, raffleId, "300", NOW);
    // 100 is named; 200 (entrant) and 300 (winner) are not.
    upsertMemberName(db, { guildId: "g1", userId: "100", username: "alice", displayName: "Alice", updatedAt: NOW });

    const missing = listUnnamedRaffleMemberIds(db, "g1").sort();
    expect(missing).toEqual(["200", "300"]);
  });

  it("does not list ids from another guild's raffles", () => {
    const other = createDraft(db, "g2", "creator", NOW);
    addEntry(db, other, "100", NOW);
    expect(listUnnamedRaffleMemberIds(db, "g1")).toEqual([]);
  });
});
