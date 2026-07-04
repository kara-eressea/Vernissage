import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import {
  addBan,
  isBlacklisted,
  listBans,
  removeBan,
} from "../../src/db/repositories/blacklist.js";
let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("blacklist", () => {
  function ban(overrides: Partial<Parameters<typeof addBan>[1]> = {}) {
    addBan(db, {
      guildId: "g1",
      userId: "u1",
      bannedBy: "mod1",
      reason: "spam",
      bannedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: null,
      ...overrides,
    });
  }

  it("treats a permanent ban as always active", () => {
    ban();
    expect(isBlacklisted(db, "g1", "u1", "2030-01-01T00:00:00.000Z")).toBe(true);
  });

  it("honors an expiry: banned before, cleared at/after", () => {
    ban({ expiresAt: "2026-07-10T00:00:00.000Z" });
    expect(isBlacklisted(db, "g1", "u1", "2026-07-05T00:00:00.000Z")).toBe(true);
    expect(isBlacklisted(db, "g1", "u1", "2026-07-10T00:00:00.000Z")).toBe(false);
    expect(isBlacklisted(db, "g1", "u1", "2026-07-11T00:00:00.000Z")).toBe(false);
  });

  it("reports no ban for an unlisted user", () => {
    expect(isBlacklisted(db, "g1", "u2", "2026-07-05T00:00:00.000Z")).toBe(false);
  });

  it("removes a ban", () => {
    ban();
    removeBan(db, "g1", "u1");
    expect(isBlacklisted(db, "g1", "u1", "2026-07-05T00:00:00.000Z")).toBe(false);
  });

  it("lists bans for a guild", () => {
    ban();
    expect(listBans(db, "g1")).toHaveLength(1);
    expect(listBans(db, "g2")).toHaveLength(0);
  });
});
