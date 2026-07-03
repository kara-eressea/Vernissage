import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import {
  listChannelRules,
  removeChannelRule,
  setChannelRule,
} from "../../src/db/repositories/countedChannels.js";
import {
  getGuild,
  getHourlyCap,
  setGuildConfig,
  upsertGuild,
} from "../../src/db/repositories/guilds.js";

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

describe("setGuildConfig", () => {
  it("creates the row on first write and stamps created_at once", () => {
    setGuildConfig(db, "g1", { hourly_cap: 20 }, "2026-07-01T00:00:00.000Z");
    expect(getGuild(db, "g1")?.created_at).toBe("2026-07-01T00:00:00.000Z");

    setGuildConfig(db, "g1", { mod_role: "role1" }, "2026-07-02T00:00:00.000Z");
    // created_at is set on insert only, never overwritten by later writes.
    expect(getGuild(db, "g1")?.created_at).toBe("2026-07-01T00:00:00.000Z");
  });

  it("clears a field to null without clobbering others", () => {
    setGuildConfig(
      db,
      "g1",
      { hourly_cap: 20, mod_role: "role1" },
      "2026-07-01T00:00:00.000Z",
    );
    setGuildConfig(db, "g1", { hourly_cap: null }, "2026-07-02T00:00:00.000Z");

    expect(getHourlyCap(db, "g1")).toBeNull(); // cleared
    expect(getGuild(db, "g1")?.mod_role).toBe("role1"); // preserved
  });

  it("leaves fields omitted from the patch untouched", () => {
    setGuildConfig(db, "g1", { hourly_cap: 20 }, "2026-07-01T00:00:00.000Z");
    setGuildConfig(db, "g1", {}, "2026-07-02T00:00:00.000Z"); // no-op patch
    expect(getHourlyCap(db, "g1")).toBe(20);
  });

  it("can write and later clear every scalar field", () => {
    setGuildConfig(
      db,
      "g1",
      {
        audit_channel: "chan1",
        mod_role: "role1",
        hourly_cap: 5,
        default_cooldown_days: 7,
        default_cooldown_count: 2,
        default_min_account_age_days: 30,
      },
      "2026-07-01T00:00:00.000Z",
    );
    setGuildConfig(
      db,
      "g1",
      {
        audit_channel: null,
        mod_role: null,
        hourly_cap: null,
        default_cooldown_days: null,
        default_cooldown_count: null,
        default_min_account_age_days: null,
      },
      "2026-07-02T00:00:00.000Z",
    );
    const row = getGuild(db, "g1")!;
    expect(row.audit_channel).toBeNull();
    expect(row.mod_role).toBeNull();
    expect(row.hourly_cap).toBeNull();
    expect(row.default_cooldown_days).toBeNull();
    expect(row.default_cooldown_count).toBeNull();
    expect(row.default_min_account_age_days).toBeNull();
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
