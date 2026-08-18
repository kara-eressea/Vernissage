import { describe, expect, it } from "vitest";
import {
  activityShortfall,
  checkEligibility,
  explainEligibility,
} from "../../src/core/eligibility.js";
import type { EligibilityInput } from "../../src/core/types.js";

/** An account old enough to clear any age gate in these tests. */
function oldAccount(): string {
  // Discord epoch + ~5 years, as a snowflake.
  return String((BigInt(Date.parse("2021-01-01T00:00:00Z") - 1420070400000) << 22n) | 1n);
}

/** A brand-new account, for the age gate. */
function newAccount(): string {
  return String((BigInt(Date.parse("2026-07-13T00:00:00Z") - 1420070400000) << 22n) | 1n);
}

function baseInput(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    status: "open",
    blacklisted: false,
    isCreator: false,
    openToAll: false,
    userRoleIds: [],
    requiredRoleId: null,
    excludedRoleId: null,
    userSnowflake: oldAccount(),
    minAccountAgeDays: null,
    minServerAgeDays: null,
    cooldown: { cooldownDays: null, cooldownCount: null },
    wins: [],
    rafflesSinceLastWin: 0,
    excludePriorWinners: false,
    hasPriorWin: false,
    reqMessages: 10,
    reqActiveDays: 0,
    reqDays: 14,
    raffleStart: "2026-07-14T12:00:00.000Z",
    joinedAt: null,
    dailyCounts: [{ day: "2026-07-10", count: 10 }],
    alreadyEntered: false,
    now: "2026-07-14T13:00:00.000Z",
    ...overrides,
  };
}

describe("explainEligibility", () => {
  it("reports no reasons for an eligible member", () => {
    expect(explainEligibility(baseInput())).toEqual({ ok: true, reasons: [] });
  });

  it("reports every failing gate, not just the first", () => {
    // Fails activity AND is in a win cooldown — the case the entry flow hides.
    const input = baseInput({
      dailyCounts: [{ day: "2026-07-10", count: 1 }],
      cooldown: { cooldownDays: 30, cooldownCount: null },
      wins: [{ raffleId: 1, wonAt: "2026-07-01T00:00:00.000Z" }],
    });

    const explained = explainEligibility(input);

    expect(explained.ok).toBe(false);
    expect(explained.reasons).toEqual(["in_cooldown", "insufficient_activity"]);
    // The short-circuiting check only ever surfaces the first of them.
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "in_cooldown" });
  });

  it("keeps the design's check order", () => {
    const explained = explainEligibility(
      baseInput({
        blacklisted: true,
        minAccountAgeDays: 3650,
        userSnowflake: newAccount(),
        dailyCounts: [],
        requiredRoleId: "r1",
      }),
    );
    expect(explained.reasons).toEqual([
      "blacklisted",
      "missing_required_role",
      "account_too_new",
      "insufficient_activity",
    ]);
  });

  it("agrees with checkEligibility on the headline reason", () => {
    // Each case fails a different gate; the first explained reason must always
    // match what the entry flow would tell the member.
    const cases: Array<Partial<EligibilityInput>> = [
      { blacklisted: true },
      { isCreator: true },
      { requiredRoleId: "r1" },
      { excludedRoleId: "r2", userRoleIds: ["r2"] },
      { minAccountAgeDays: 3650, userSnowflake: newAccount() },
      { minServerAgeDays: 5, joinedAt: "2026-07-13T00:00:00.000Z" },
      { cooldown: { cooldownDays: 30, cooldownCount: null }, wins: [{ raffleId: 1, wonAt: "2026-07-01T00:00:00.000Z" }] },
      { excludePriorWinners: true, hasPriorWin: true },
      { dailyCounts: [] },
      { alreadyEntered: true },
    ];
    for (const overrides of cases) {
      const input = baseInput(overrides);
      const result = checkEligibility(input);
      const explained = explainEligibility(input);
      expect(result.ok).toBe(false);
      expect(explained.reasons[0]).toBe(result.ok ? undefined : result.reason);
    }
  });

  it("reports no waived gate for an open-to-everyone raffle", () => {
    // Every gate below the creator check is waived, so none of them are failures
    // — but the blacklist still is.
    const explained = explainEligibility(
      baseInput({ openToAll: true, dailyCounts: [], blacklisted: true }),
    );
    expect(explained.reasons).toEqual(["blacklisted"]);
  });

  it("keeps evaluating a raffle that is not open, unlike the entry check", () => {
    // A moderator looking at a drawn raffle still wants to see who qualified.
    const input = baseInput({ status: "drawn", dailyCounts: [] });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "not_open" });
    expect(explainEligibility(input).reasons).toEqual(["not_open", "insufficient_activity"]);
  });
});

describe("activityShortfall", () => {
  it("separates a volume miss from a spread miss", () => {
    const spreadOnly = activityShortfall(
      baseInput({
        reqMessages: 10,
        reqActiveDays: 5,
        dailyCounts: [{ day: "2026-07-10", count: 40 }],
      }),
    );
    expect(spreadOnly).toEqual({
      messages: 40,
      activeDays: 1,
      missesVolume: false,
      missesSpread: true,
    });

    const volumeOnly = activityShortfall(
      baseInput({
        reqMessages: 10,
        reqActiveDays: 2,
        dailyCounts: [
          { day: "2026-07-10", count: 1 },
          { day: "2026-07-11", count: 1 },
        ],
      }),
    );
    expect(volumeOnly.missesVolume).toBe(true);
    expect(volumeOnly.missesSpread).toBe(false);
  });

  it("counts only days inside the window", () => {
    const shortfall = activityShortfall(
      baseInput({
        reqDays: 14, // window is 2026-07-01..2026-07-14
        dailyCounts: [
          { day: "2026-06-30", count: 99 },
          { day: "2026-07-02", count: 3 },
        ],
      }),
    );
    expect(shortfall.messages).toBe(3);
    expect(shortfall.activeDays).toBe(1);
  });

  it("reports no shortfall when no activity gate applies", () => {
    const shortfall = activityShortfall(baseInput({ reqMessages: 0, reqActiveDays: 0 }));
    expect(shortfall.missesVolume).toBe(false);
    expect(shortfall.missesSpread).toBe(false);
  });
});
