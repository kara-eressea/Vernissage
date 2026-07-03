import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import {
  listChannelRules,
  removeChannelRule,
  setChannelRule,
} from "../../src/db/repositories/countedChannels.js";
import { getGuild, getHourlyCap, upsertGuild } from "../../src/db/repositories/guilds.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("guild config", () => {
  it("returns undefined / null for an unconfigured guild", () => {
    expect(getGuild(db, "g1")).toBeUndefined();
    expect(getHourlyCap(db, "g1")).toBeNull();
  });

  it("creates a guild row and reads it back", () => {
    upsertGuild(db, "g1", { hourly_cap: 20, created_at: "2026-07-01T00:00:00.000Z" });
    expect(getGuild(db, "g1")?.hourly_cap).toBe(20);
    expect(getHourlyCap(db, "g1")).toBe(20);
  });

  it("updates provided fields without clobbering others", () => {
    upsertGuild(db, "g1", { hourly_cap: 20, created_at: "2026-07-01T00:00:00.000Z" });
    upsertGuild(db, "g1", { mod_role: "role1", created_at: "2026-07-02T00:00:00.000Z" });
    const row = getGuild(db, "g1")!;
    expect(row.hourly_cap).toBe(20); // preserved
    expect(row.mod_role).toBe("role1"); // updated
  });
});

describe("counted channels", () => {
  it("stores, lists, updates, and removes channel rules", () => {
    setChannelRule(db, "g1", "c1", "include");
    setChannelRule(db, "g1", "c2", "exclude");
    expect(listChannelRules(db, "g1")).toEqual([
      { channelId: "c1", mode: "include" },
      { channelId: "c2", mode: "exclude" },
    ]);

    setChannelRule(db, "g1", "c1", "exclude"); // update mode
    expect(listChannelRules(db, "g1").find((r) => r.channelId === "c1")?.mode).toBe(
      "exclude",
    );

    removeChannelRule(db, "g1", "c1");
    expect(listChannelRules(db, "g1")).toEqual([{ channelId: "c2", mode: "exclude" }]);
  });

  it("scopes rules per guild", () => {
    setChannelRule(db, "g1", "c1", "include");
    expect(listChannelRules(db, "g2")).toEqual([]);
  });
});
