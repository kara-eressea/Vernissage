import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { incrementActivity } from "../../src/db/repositories/activity.js";
import { setGuildConfig } from "../../src/db/repositories/guilds.js";
import { simulateEligiblePool, type SimulationResult } from "../../src/eligibility/service.js";
import {
  buildDesignerPool,
  buildDesignerView,
  settingsFromDefaults,
} from "../../src/web/designer.js";

const GUILD = "g1";
// The 14-day window ends on NOW's day, so activity on/after 2026-07-01 counts.
const NOW = "2026-07-14T12:00:00.000Z";
const DAY = "2026-07-10";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

/** A guild config with a full set of eligibility defaults. */
function seedDefaults(): void {
  setGuildConfig(
    db,
    GUILD,
    {
      default_req_messages: 10,
      default_req_days: 14,
      default_req_active_days: 0,
      default_min_account_age_days: 30,
      default_cooldown_days: 60,
      announce_channel: "chan",
      timezone: "Europe/Copenhagen",
    },
    NOW,
  );
}

describe("buildDesignerView", () => {
  it("seeds the composer from the guild's saved defaults", () => {
    seedDefaults();
    const view = buildDesignerView(db, GUILD, "Vinyl Collective", "Alex", NOW);

    expect(view.serverName).toBe("Vinyl Collective");
    expect(view.moderator).toBe("Alex");
    expect(view.timezone).toBe("Europe/Copenhagen");
    expect(view.hasAnnounceChannel).toBe(true);
    expect(view.defaults).toEqual({
      reqMessages: 10,
      reqDays: 14,
      reqActiveDays: 0,
      minAccountAgeDays: 30,
      cooldownDays: 60,
      cooldownCount: null,
    });
    // Draw section starts on the wizard's own defaults.
    expect(view.initialWinnerCount).toBe(1);
    expect(view.initialDrawMode).toBe("auto");
    expect(view.initialClaimHours).toBeNull();
  });

  it("falls back to sensible starters and flags a missing announce channel", () => {
    const view = buildDesignerView(db, GUILD, "Fresh Server", "Sam", NOW);
    expect(view.timezone).toBe("UTC");
    expect(view.hasAnnounceChannel).toBe(false);
    expect(view.defaults.reqMessages).toBe(10);
    expect(view.defaults.reqDays).toBe(14);
  });

  it("computes the initial pool under the server defaults", () => {
    seedDefaults();
    // Numeric snowflake ids so the min-account-age gate can parse them.
    incrementActivity(db, GUILD, "100", DAY, 20); // clears 10
    incrementActivity(db, GUILD, "200", DAY, 3); // below the bar
    const view = buildDesignerView(db, GUILD, "S", "M", NOW);

    expect(view.pool.hasCandidates).toBe(true);
    expect(view.pool.considered).toBe(2);
    expect(view.pool.eligible).toBe(1);
    expect(view.pool.pct).toBe(50);
    expect(view.pool.reqMessages).toBe(10);
  });
});

describe("buildDesignerPool", () => {
  /** Run the real engine so the pool reflects the actual gate, not a mock. */
  function poolFor(reqMessages: number, reqDays = 14): SimulationResult {
    return simulateEligiblePool(
      db,
      GUILD,
      {
        reqMessages,
        reqDays,
        reqActiveDays: 0,
        minAccountAgeDays: 0,
        cooldownDays: 0,
        cooldownCount: null,
      },
      NOW,
    );
  }

  it("bins members by message count with the threshold placed on the axis", () => {
    incrementActivity(db, GUILD, "u1", DAY, 2); // bin 0 (0–4)
    incrementActivity(db, GUILD, "u2", DAY, 7); // bin 1 (5–9)
    incrementActivity(db, GUILD, "u3", DAY, 12); // bin 2 (10–14)
    incrementActivity(db, GUILD, "u4", DAY, 55); // clamped into the last bin (45+)
    const pool = buildDesignerPool(poolFor(10));

    expect(pool.bins).toHaveLength(10);
    // X=10 sits a fifth of the way across a 0–50 axis.
    expect(pool.thresholdPct).toBeCloseTo(20, 5);
    // Bins at or above 10 messages clear the bar; below it do not.
    expect(pool.bins[0]!.clears).toBe(false);
    expect(pool.bins[1]!.clears).toBe(false);
    expect(pool.bins[2]!.clears).toBe(true);
    // The 55-message member lands in the final bin.
    expect(pool.bins[9]!.heightPct).toBeGreaterThan(0);
  });

  it("aggregates exclusion reasons, splitting message vs. active-day misses", () => {
    // Below the message floor.
    incrementActivity(db, GUILD, "few", DAY, 4);
    // Clears the message floor but not the distinct-active-days floor.
    incrementActivity(db, GUILD, "spread", "2026-07-09", 20);
    const result = simulateEligiblePool(
      db,
      GUILD,
      {
        reqMessages: 10,
        reqDays: 14,
        reqActiveDays: 3, // "spread" has one active day → fails on days
        minAccountAgeDays: 0,
        cooldownDays: 0,
        cooldownCount: null,
      },
      NOW,
    );
    const pool = buildDesignerPool(result);

    const byLabel = new Map(pool.reasons.map((r) => [r.label, r.count]));
    expect(byLabel.get("too few messages")).toBe(1);
    expect(byLabel.get("too few active days")).toBe(1);
  });

  it("reports no reasons when everyone active clears the bar", () => {
    incrementActivity(db, GUILD, "u1", DAY, 30);
    incrementActivity(db, GUILD, "u2", DAY, 40);
    const pool = buildDesignerPool(poolFor(5));
    expect(pool.eligible).toBe(2);
    expect(pool.reasons).toEqual([]);
  });

  it("handles a guild with no counted activity", () => {
    const pool = buildDesignerPool(poolFor(10));
    expect(pool.hasCandidates).toBe(false);
    expect(pool.considered).toBe(0);
    expect(pool.pct).toBe(0);
    expect(pool.reasons).toEqual([]);
  });
});

describe("settingsFromDefaults", () => {
  it("maps designer defaults onto simulation settings", () => {
    expect(
      settingsFromDefaults({
        reqMessages: 8,
        reqDays: 21,
        reqActiveDays: 2,
        minAccountAgeDays: 45,
        cooldownDays: 90,
        cooldownCount: 3,
      }),
    ).toEqual({
      reqMessages: 8,
      reqDays: 21,
      reqActiveDays: 2,
      minAccountAgeDays: 45,
      cooldownDays: 90,
      cooldownCount: 3,
    });
  });
});
