import { describe, expect, it } from "vitest";
import { winCooldownStatus } from "../../src/core/cooldown.js";
import type { WinRecord } from "../../src/core/types.js";

const wins: WinRecord[] = [{ raffleId: 1, wonAt: "2026-07-01T00:00:00.000Z" }];

describe("winCooldownStatus", () => {
  it("is inactive when the user has never won", () => {
    expect(
      winCooldownStatus({ cooldownDays: 7, cooldownCount: 2, wins: [], rafflesSinceLastWin: 0, now: "2026-07-10T00:00:00.000Z" }),
    ).toEqual({ active: false, endsAt: null, rafflesRemaining: null });
  });

  it("reports the time cooldown as active with an end date", () => {
    const status = winCooldownStatus({
      cooldownDays: 7,
      cooldownCount: null,
      wins,
      rafflesSinceLastWin: 0,
      now: "2026-07-05T00:00:00.000Z",
    });
    expect(status.active).toBe(true);
    expect(status.endsAt).toBe("2026-07-08T00:00:00.000Z");
  });

  it("clears the time cooldown once the window passes (exclusive boundary)", () => {
    const status = winCooldownStatus({
      cooldownDays: 7,
      cooldownCount: null,
      wins,
      rafflesSinceLastWin: 0,
      now: "2026-07-08T00:00:00.000Z",
    });
    expect(status.active).toBe(false);
  });

  it("reports the count cooldown with raffles remaining", () => {
    const status = winCooldownStatus({
      cooldownDays: null,
      cooldownCount: 3,
      wins,
      rafflesSinceLastWin: 1,
      now: "2026-08-01T00:00:00.000Z",
    });
    expect(status).toEqual({ active: true, endsAt: null, rafflesRemaining: 2 });
  });

  it("is inactive when enough raffles have passed", () => {
    const status = winCooldownStatus({
      cooldownDays: null,
      cooldownCount: 3,
      wins,
      rafflesSinceLastWin: 3,
      now: "2026-08-01T00:00:00.000Z",
    });
    expect(status).toEqual({ active: false, endsAt: null, rafflesRemaining: 0 });
  });
});
