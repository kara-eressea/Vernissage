import { describe, expect, it } from "vitest";
import { isInWinCooldown } from "../../src/core/cooldown.js";
import type { WinRecord } from "../../src/core/types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const wonAt = "2026-07-01T00:00:00.000Z";
const wins: WinRecord[] = [{ raffleId: 1, wonAt }];

function daysAfterWin(days: number): string {
  return new Date(Date.parse(wonAt) + days * MS_PER_DAY).toISOString();
}

describe("isInWinCooldown", () => {
  it("is never in cooldown with no wins", () => {
    expect(
      isInWinCooldown({
        cooldownDays: 30,
        cooldownCount: 3,
        wins: [],
        rafflesSinceLastWin: 0,
        now: daysAfterWin(0),
      }),
    ).toBe(false);
  });

  describe("time-based", () => {
    const base = { cooldownDays: 7, cooldownCount: null, wins };

    it("blocks within the cooldown window", () => {
      expect(
        isInWinCooldown({ ...base, rafflesSinceLastWin: 99, now: daysAfterWin(3) }),
      ).toBe(true);
    });

    it("clears at exactly Z days (exclusive boundary)", () => {
      expect(
        isInWinCooldown({ ...base, rafflesSinceLastWin: 0, now: daysAfterWin(7) }),
      ).toBe(false);
    });

    it("clears after the window", () => {
      expect(
        isInWinCooldown({ ...base, rafflesSinceLastWin: 0, now: daysAfterWin(10) }),
      ).toBe(false);
    });
  });

  describe("count-based", () => {
    const base = { cooldownDays: null, cooldownCount: 3, wins };

    it("blocks until N raffles have been skipped", () => {
      expect(
        isInWinCooldown({ ...base, rafflesSinceLastWin: 2, now: daysAfterWin(999) }),
      ).toBe(true);
    });

    it("clears at exactly N skipped raffles", () => {
      expect(
        isInWinCooldown({ ...base, rafflesSinceLastWin: 3, now: daysAfterWin(0) }),
      ).toBe(false);
    });
  });

  describe("both modes", () => {
    const base = { cooldownDays: 7, cooldownCount: 3, wins };

    it("stays in cooldown while either constraint is unmet", () => {
      // Time satisfied, count not.
      expect(
        isInWinCooldown({ ...base, rafflesSinceLastWin: 1, now: daysAfterWin(10) }),
      ).toBe(true);
      // Count satisfied, time not.
      expect(
        isInWinCooldown({ ...base, rafflesSinceLastWin: 5, now: daysAfterWin(2) }),
      ).toBe(true);
    });

    it("clears only when both constraints are satisfied", () => {
      expect(
        isInWinCooldown({ ...base, rafflesSinceLastWin: 3, now: daysAfterWin(7) }),
      ).toBe(false);
    });
  });

  it("uses the most recent win when there are several", () => {
    const multi: WinRecord[] = [
      { raffleId: 1, wonAt: "2026-01-01T00:00:00.000Z" },
      { raffleId: 2, wonAt },
    ];
    expect(
      isInWinCooldown({
        cooldownDays: 7,
        cooldownCount: null,
        wins: multi,
        rafflesSinceLastWin: 0,
        now: daysAfterWin(3),
      }),
    ).toBe(true);
  });
});
