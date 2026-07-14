import { describe, expect, it } from "vitest";
import { DISCORD_EPOCH } from "../../src/core/accountAge.js";
import {
  buildSnapshotInput,
  snapshotEligibleUsers,
  type SnapshotCandidate,
  type SnapshotDefaults,
} from "../../src/core/eligibilitySnapshot.js";

const NOW = "2026-07-14T12:00:00.000Z";

/** A snowflake for an account created on `iso`, for account-age cases. */
function snowflakeFor(iso: string): string {
  const created = Date.parse(iso);
  return ((BigInt(created) - BigInt(DISCORD_EPOCH)) << 22n).toString();
}

/** An old-enough account so age never gates unless a test sets it up to. */
function oldAccount(): string {
  return snowflakeFor("2020-01-01T00:00:00.000Z");
}

const DEFAULTS: SnapshotDefaults = {
  minAccountAgeDays: null,
  cooldownDays: null,
  cooldownCount: null,
  reqMessages: 10,
  reqActiveDays: 0,
  reqDays: 14,
};

/** A candidate that clears every default; individual tests override fields. */
function candidate(overrides: Partial<SnapshotCandidate> = {}): SnapshotCandidate {
  return {
    userId: oldAccount(),
    dailyCounts: [{ day: "2026-07-10", count: 10 }],
    wins: [],
    rafflesSinceLastWin: 0,
    blacklisted: false,
    ...overrides,
  };
}

describe("buildSnapshotInput", () => {
  it("neutralizes the per-raffle gates and anchors the window at now", () => {
    const input = buildSnapshotInput(candidate(), DEFAULTS, NOW);
    expect(input.status).toBe("open");
    expect(input.raffleStart).toBe(NOW);
    expect(input.requiredRoleId).toBeNull();
    expect(input.excludedRoleId).toBeNull();
    expect(input.excludePriorWinners).toBe(false);
    expect(input.openToAll).toBe(false);
    expect(input.minServerAgeDays).toBeNull();
    expect(input.alreadyEntered).toBe(false);
    expect(input.reqMessages).toBe(10);
    expect(input.reqDays).toBe(14);
  });
});

describe("snapshotEligibleUsers", () => {
  it("keeps members who clear the default bars, in input order", () => {
    const a = candidate({ userId: snowflakeFor("2019-01-01T00:00:00.000Z") });
    const b = candidate({ userId: snowflakeFor("2021-06-01T00:00:00.000Z") });
    const result = snapshotEligibleUsers([a, b], DEFAULTS, NOW);
    expect(result.considered).toBe(2);
    expect(result.eligibleUserIds).toEqual([a.userId, b.userId]);
  });

  it("drops a member below the default activity requirement", () => {
    const short = candidate({ dailyCounts: [{ day: "2026-07-10", count: 3 }] });
    const result = snapshotEligibleUsers([short], DEFAULTS, NOW);
    expect(result).toEqual({ considered: 1, eligibleUserIds: [] });
  });

  it("only counts activity inside the window ending now", () => {
    // 20 messages, but 20 days before NOW — outside the 14-day window ending now.
    const stale = candidate({ dailyCounts: [{ day: "2026-06-24", count: 20 }] });
    expect(snapshotEligibleUsers([stale], DEFAULTS, NOW).eligibleUserIds).toEqual([]);
  });

  it("drops a blacklisted member", () => {
    const banned = candidate({ blacklisted: true });
    expect(snapshotEligibleUsers([banned], DEFAULTS, NOW).eligibleUserIds).toEqual([]);
  });

  it("applies the default minimum account age via the snowflake", () => {
    const young = candidate({ userId: snowflakeFor("2026-07-13T00:00:00.000Z") });
    const defaults = { ...DEFAULTS, minAccountAgeDays: 30 };
    expect(snapshotEligibleUsers([young], defaults, NOW).eligibleUserIds).toEqual([]);
  });

  it("applies the default day-based win cooldown", () => {
    const recentWinner = candidate({
      wins: [{ raffleId: 1, wonAt: "2026-07-13T00:00:00.000Z" }],
    });
    const defaults = { ...DEFAULTS, cooldownDays: 7 };
    expect(snapshotEligibleUsers([recentWinner], defaults, NOW).eligibleUserIds).toEqual([]);
  });

  it("does not gate on wins when no cooldown default is set", () => {
    const winner = candidate({
      wins: [{ raffleId: 1, wonAt: "2026-07-13T00:00:00.000Z" }],
    });
    expect(snapshotEligibleUsers([winner], DEFAULTS, NOW).eligibleUserIds).toEqual([
      winner.userId,
    ]);
  });

  it("applies the default distinct-active-days floor", () => {
    // Clears the message total in one burst, but the default requires 3 days.
    const burst = candidate({ dailyCounts: [{ day: "2026-07-10", count: 30 }] });
    const spread = candidate({
      userId: snowflakeFor("2018-01-01T00:00:00.000Z"),
      dailyCounts: [
        { day: "2026-07-08", count: 4 },
        { day: "2026-07-09", count: 3 },
        { day: "2026-07-10", count: 3 },
      ],
    });
    const defaults = { ...DEFAULTS, reqActiveDays: 3 };
    const result = snapshotEligibleUsers([burst, spread], defaults, NOW);
    expect(result.eligibleUserIds).toEqual([spread.userId]);
  });
});
