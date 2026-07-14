import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openDb } from "../../src/db/index.js";
import { incrementActivity } from "../../src/db/repositories/activity.js";
import { addBan } from "../../src/db/repositories/blacklist.js";
import { simulateEligiblePool, type SimulationSettings } from "../../src/eligibility/service.js";

const NOW = "2026-07-14T12:00:00.000Z";
const DISCORD_EPOCH = 1420070400000;

/** A user id (snowflake) whose encoded account-creation time is `iso`. */
function userAt(iso: string): string {
  return String(BigInt(Date.parse(iso) - DISCORD_EPOCH) << 22n);
}

// An ancient account (clears any age bar) and a fresh one (13 days old at NOW).
const OLD = userAt("2016-01-01T00:00:00.000Z");
const NEW = userAt("2026-07-01T00:00:00.000Z");

function settings(over: Partial<SimulationSettings> = {}): SimulationSettings {
  return {
    reqMessages: 10,
    reqDays: 14,
    reqActiveDays: 0,
    minAccountAgeDays: 0,
    cooldownDays: 0,
    cooldownCount: null,
    ...over,
  };
}

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("simulateEligiblePool", () => {
  it("splits candidates on the message floor and reports each member's counts", () => {
    incrementActivity(db, "g1", OLD, "2026-07-10", 12); // clears >=10
    incrementActivity(db, "g1", NEW, "2026-07-10", 5); // below the bar
    const result = simulateEligiblePool(db, "g1", settings(), NOW);

    expect(result.considered).toBe(2);
    expect(result.eligible).toBe(1);

    const old = result.members.find((m) => m.userId === OLD)!;
    const fresh = result.members.find((m) => m.userId === NEW)!;
    expect(old.eligible).toBe(true);
    expect(old.reason).toBeNull();
    expect(old.messages).toBe(12);
    expect(fresh.eligible).toBe(false);
    expect(fresh.reason).toBe("insufficient_activity");
    expect(fresh.messages).toBe(5);
  });

  it("evaluates the distinct-active-days floor, not just the message count", () => {
    // 12 messages, but all on a single day.
    incrementActivity(db, "g1", OLD, "2026-07-10", 12);
    const result = simulateEligiblePool(db, "g1", settings({ reqActiveDays: 3 }), NOW);

    const old = result.members.find((m) => m.userId === OLD)!;
    expect(old.messages).toBe(12);
    expect(old.activeDays).toBe(1);
    expect(old.eligible).toBe(false);
    expect(old.reason).toBe("insufficient_activity");
  });

  it("applies the account-age bar and derives the age from the snowflake", () => {
    incrementActivity(db, "g1", NEW, "2026-07-10", 20);
    const result = simulateEligiblePool(db, "g1", settings({ minAccountAgeDays: 60 }), NOW);

    const fresh = result.members.find((m) => m.userId === NEW)!;
    expect(fresh.eligible).toBe(false);
    expect(fresh.reason).toBe("account_too_new");
    // Created 2026-07-01, so ~13 days old at NOW.
    expect(fresh.accountAgeDays).toBe(13);
  });

  it("reports the blacklist as the reason", () => {
    incrementActivity(db, "g1", OLD, "2026-07-10", 20);
    addBan(db, { guildId: "g1", userId: OLD, bannedBy: "mod1", reason: "farming", bannedAt: NOW, expiresAt: null });
    const result = simulateEligiblePool(db, "g1", settings(), NOW);

    const old = result.members.find((m) => m.userId === OLD)!;
    expect(old.eligible).toBe(false);
    expect(old.reason).toBe("blacklisted");
  });

  it("normalises a zero window to a single day", () => {
    incrementActivity(db, "g1", OLD, "2026-07-14", 3);
    const result = simulateEligiblePool(db, "g1", settings({ reqMessages: 1, reqDays: 0 }), NOW);
    expect(result.settings.reqDays).toBe(1);
    expect(result.considered).toBe(1);
    expect(result.eligible).toBe(1);
  });

  it("only considers members with counted activity inside the window", () => {
    incrementActivity(db, "g1", OLD, "2026-06-01", 50); // before the 14-day window
    const result = simulateEligiblePool(db, "g1", settings(), NOW);
    expect(result.considered).toBe(0);
    expect(result.eligible).toBe(0);
  });

  it("scopes candidates to the guild", () => {
    incrementActivity(db, "g1", OLD, "2026-07-10", 20);
    incrementActivity(db, "g2", NEW, "2026-07-10", 20);
    const result = simulateEligiblePool(db, "g1", settings(), NOW);
    expect(result.members.map((m) => m.userId)).toEqual([OLD]);
  });
});
