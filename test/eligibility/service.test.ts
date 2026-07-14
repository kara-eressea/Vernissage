import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { incrementActivity } from "../../src/db/repositories/activity.js";
import { setGuildConfig } from "../../src/db/repositories/guilds.js";
import { computeEligiblePool } from "../../src/eligibility/service.js";

const NOW = "2026-07-14T12:00:00.000Z";
let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("computeEligiblePool", () => {
  it("reports hasDefaults=false when no activity requirement is configured", () => {
    incrementActivity(db, "g1", "uA", "2026-07-10", 20);
    const pool = computeEligiblePool(db, "g1", NOW);
    expect(pool.hasDefaults).toBe(false);
    expect(pool.considered).toBe(0);
    expect(pool.eligibleUserIds).toEqual([]);
  });

  it("counts only candidates that clear the default activity bar", () => {
    // Window is the 14 days ending 2026-07-14, i.e. from 2026-07-01.
    incrementActivity(db, "g1", "uA", "2026-07-10", 10); // meets >=10
    incrementActivity(db, "g1", "uB", "2026-07-10", 5); // below the bar
    setGuildConfig(
      db,
      "g1",
      { default_req_messages: 10, default_req_days: 14, default_req_active_days: 0 },
      NOW,
    );

    const pool = computeEligiblePool(db, "g1", NOW);
    expect(pool.hasDefaults).toBe(true);
    expect(pool.considered).toBe(2);
    expect(pool.eligibleUserIds).toEqual(["uA"]);
  });

  it("ignores activity outside the default window", () => {
    incrementActivity(db, "g1", "uA", "2026-06-01", 50); // before the 14-day window
    setGuildConfig(
      db,
      "g1",
      { default_req_messages: 10, default_req_days: 14, default_req_active_days: 0 },
      NOW,
    );
    const pool = computeEligiblePool(db, "g1", NOW);
    // No candidate has counted activity in-window, so none is even considered.
    expect(pool.considered).toBe(0);
    expect(pool.eligibleUserIds).toEqual([]);
  });

  it("scopes candidates to the guild", () => {
    incrementActivity(db, "g1", "uA", "2026-07-10", 10);
    incrementActivity(db, "g2", "uB", "2026-07-10", 10);
    setGuildConfig(
      db,
      "g1",
      { default_req_messages: 10, default_req_days: 14, default_req_active_days: 0 },
      NOW,
    );
    const pool = computeEligiblePool(db, "g1", NOW);
    expect(pool.eligibleUserIds).toEqual(["uA"]);
  });
});
