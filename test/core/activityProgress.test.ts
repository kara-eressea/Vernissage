import { describe, expect, it } from "vitest";
import { activityProgress } from "../../src/core/eligibility.js";
import type { EligibilityInput } from "../../src/core/types.js";

function input(overrides: Partial<EligibilityInput>): EligibilityInput {
  return {
    status: "open",
    blacklisted: false,
    isCreator: false,
    userRoleIds: [],
    requiredRoleId: null,
    excludedRoleId: null,
    userSnowflake: "1",
    minAccountAgeDays: null,
    cooldown: { cooldownDays: null, cooldownCount: null },
    wins: [],
    rafflesSinceLastWin: 0,
    excludePriorWinners: false,
    hasPriorWin: false,
    reqMessages: 10,
    reqDays: 7,
    windowAnchor: "start",
    raffleStart: "2026-07-10T12:00:00.000Z",
    newMemberExempt: false,
    newMemberDays: null,
    joinedAt: null,
    dailyCounts: [],
    alreadyEntered: false,
    now: "2026-07-12T12:00:00.000Z",
    ...overrides,
  };
}

describe("activityProgress", () => {
  it("sums counts within the anchored window", () => {
    const p = activityProgress(
      input({
        dailyCounts: [
          { day: "2026-07-08", count: 4 },
          { day: "2026-07-10", count: 6 },
          { day: "2026-06-01", count: 99 }, // outside the window
        ],
      }),
    );
    expect(p.have).toBe(10);
    expect(p.need).toBe(10);
    expect(p.window).toEqual({ startDay: "2026-07-04", endDay: "2026-07-10" });
  });

  it("reports the new-member exemption and short-circuits", () => {
    const p = activityProgress(
      input({ newMemberExempt: true, newMemberDays: 7, joinedAt: "2026-07-11T00:00:00.000Z" }),
    );
    expect(p.exempt).toBe(true);
  });

  it("uses the entry time as the window end under the rolling anchor", () => {
    const p = activityProgress(input({ windowAnchor: "rolling", reqDays: 1 }));
    expect(p.window).toEqual({ startDay: "2026-07-12", endDay: "2026-07-12" });
  });
});
