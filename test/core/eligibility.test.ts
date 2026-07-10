import { describe, expect, it } from "vitest";
import { DISCORD_EPOCH } from "../../src/core/accountAge.js";
import {
  checkEligibility,
  meetsActivityRequirement,
} from "../../src/core/eligibility.js";
import type { EligibilityInput } from "../../src/core/types.js";

/** A snowflake for an account created well before any test's `now`. */
function oldAccount(): string {
  const created = Date.parse("2020-01-01T00:00:00.000Z");
  return ((BigInt(created) - BigInt(DISCORD_EPOCH)) << 22n).toString();
}

/** A passing baseline; individual tests override single fields. */
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
    windowAnchor: "start",
    raffleStart: "2026-07-14T12:00:00.000Z",
    joinedAt: null,
    dailyCounts: [{ day: "2026-07-10", count: 10 }],
    alreadyEntered: false,
    now: "2026-07-14T13:00:00.000Z",
    ...overrides,
  };
}

describe("checkEligibility - happy path", () => {
  it("accepts a fully eligible entrant", () => {
    expect(checkEligibility(baseInput())).toEqual({ ok: true });
  });
});

describe("checkEligibility - check order and failures", () => {
  it("rejects when the raffle is not open", () => {
    expect(checkEligibility(baseInput({ status: "closed" }))).toEqual({
      ok: false,
      reason: "not_open",
    });
  });

  it("rejects a blacklisted user before other checks", () => {
    // Also fails activity, but blacklist is checked first.
    const input = baseInput({ blacklisted: true, dailyCounts: [] });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "blacklisted" });
  });

  it("rejects an account below the minimum age", () => {
    const created = Date.parse("2026-07-13T00:00:00.000Z");
    const youngSnowflake = ((BigInt(created) - BigInt(DISCORD_EPOCH)) << 22n).toString();
    const input = baseInput({ userSnowflake: youngSnowflake, minAccountAgeDays: 30 });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "account_too_new" });
  });

  it("rejects a user still in a win cooldown", () => {
    const input = baseInput({
      cooldown: { cooldownDays: 30, cooldownCount: null },
      wins: [{ raffleId: 1, wonAt: "2026-07-10T00:00:00.000Z" }],
    });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "in_cooldown" });
  });

  it("rejects insufficient activity", () => {
    const input = baseInput({ dailyCounts: [{ day: "2026-07-10", count: 9 }] });
    expect(checkEligibility(input)).toEqual({
      ok: false,
      reason: "insufficient_activity",
    });
  });

  it("rejects a duplicate entry last", () => {
    expect(checkEligibility(baseInput({ alreadyEntered: true }))).toEqual({
      ok: false,
      reason: "already_entered",
    });
  });
});

describe("checkEligibility - creator self-exclusion", () => {
  it("rejects the raffle's creator, after blacklist but before role/age checks", () => {
    // Also fails activity; is_creator is reported because it is checked earlier.
    const input = baseInput({ isCreator: true, dailyCounts: [] });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "is_creator" });
  });

  it("a blacklisted creator still reports blacklist first", () => {
    const input = baseInput({ isCreator: true, blacklisted: true });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "blacklisted" });
  });
});

describe("checkEligibility - role gates", () => {
  it("rejects a member missing the required role", () => {
    const input = baseInput({ requiredRoleId: "role-a", userRoleIds: ["role-b"] });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "missing_required_role" });
  });

  it("accepts a member holding the required role", () => {
    const input = baseInput({ requiredRoleId: "role-a", userRoleIds: ["role-a", "role-b"] });
    expect(checkEligibility(input)).toEqual({ ok: true });
  });

  it("rejects a member holding an excluded role", () => {
    const input = baseInput({ excludedRoleId: "staff", userRoleIds: ["staff"] });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "has_excluded_role" });
  });

  it("accepts a member without the excluded role", () => {
    const input = baseInput({ excludedRoleId: "staff", userRoleIds: ["member"] });
    expect(checkEligibility(input)).toEqual({ ok: true });
  });

  it("required role is checked before excluded role", () => {
    // Holds the excluded role but lacks the required one: missing-required wins,
    // matching the documented order.
    const input = baseInput({
      requiredRoleId: "subscriber",
      excludedRoleId: "staff",
      userRoleIds: ["staff"],
    });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "missing_required_role" });
  });

  it("no role gates when both role ids are null", () => {
    expect(checkEligibility(baseInput({ userRoleIds: [] }))).toEqual({ ok: true });
  });
});

describe("checkEligibility - prior-winner exclusion", () => {
  it("rejects a prior winner when the raffle excludes them, after the cooldown check", () => {
    const input = baseInput({ excludePriorWinners: true, hasPriorWin: true });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "prior_winner" });
  });

  it("accepts a prior winner when exclusion is off (the default)", () => {
    const input = baseInput({ excludePriorWinners: false, hasPriorWin: true });
    expect(checkEligibility(input)).toEqual({ ok: true });
  });

  it("accepts a never-winner when exclusion is on", () => {
    const input = baseInput({ excludePriorWinners: true, hasPriorWin: false });
    expect(checkEligibility(input)).toEqual({ ok: true });
  });

  it("reports the cooldown before prior-winner when both would fire", () => {
    const input = baseInput({
      excludePriorWinners: true,
      hasPriorWin: true,
      cooldown: { cooldownDays: 30, cooldownCount: null },
      wins: [{ raffleId: 1, wonAt: "2026-07-10T00:00:00.000Z" }],
    });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "in_cooldown" });
  });
});

describe("activity requirement boundaries", () => {
  it("accepts exactly the required message count", () => {
    expect(
      meetsActivityRequirement(
        baseInput({ dailyCounts: [{ day: "2026-07-10", count: 10 }] }),
      ),
    ).toBe(true);
  });

  it("rejects one below the required count", () => {
    expect(
      meetsActivityRequirement(
        baseInput({ dailyCounts: [{ day: "2026-07-10", count: 9 }] }),
      ),
    ).toBe(false);
  });

  it("anchored mode ignores activity after the raffle start day", () => {
    // Messages the day after start must not count in anchored mode.
    const input = baseInput({
      windowAnchor: "start",
      dailyCounts: [{ day: "2026-07-15", count: 50 }],
    });
    expect(meetsActivityRequirement(input)).toBe(false);
  });

  it("rolling mode counts activity up to the entry attempt", () => {
    // Same post-start messages DO count when the window is anchored at `now`.
    const input = baseInput({
      windowAnchor: "rolling",
      raffleStart: "2026-07-14T12:00:00.000Z",
      now: "2026-07-15T12:00:00.000Z",
      dailyCounts: [{ day: "2026-07-15", count: 50 }],
    });
    expect(meetsActivityRequirement(input)).toBe(true);
  });

  it("counts a message on the exact UTC-midnight window edge", () => {
    // Window for reqDays=14 ending 2026-07-14 starts 2026-07-01. The first day
    // is inclusive.
    const input = baseInput({ dailyCounts: [{ day: "2026-07-01", count: 10 }] });
    expect(meetsActivityRequirement(input)).toBe(true);
  });

  it("excludes a message one day before the window opens", () => {
    const input = baseInput({ dailyCounts: [{ day: "2026-06-30", count: 10 }] });
    expect(meetsActivityRequirement(input)).toBe(false);
  });
});

describe("activity requirement - malformed/absent requirement degrades safely", () => {
  it("treats a zero message floor as no requirement (met)", () => {
    const input = baseInput({ reqMessages: 0, dailyCounts: [] });
    expect(meetsActivityRequirement(input)).toBe(true);
  });

  it("does not throw on a non-positive window; treats it as no requirement", () => {
    // activityWindow would throw on reqDays < 1; a bad/edited raffle row reaching
    // entry time must degrade to "met", not crash the entry handler.
    const input = baseInput({ reqDays: 0, dailyCounts: [] });
    expect(() => meetsActivityRequirement(input)).not.toThrow();
    expect(meetsActivityRequirement(input)).toBe(true);
    expect(() => checkEligibility(input)).not.toThrow();
    expect(checkEligibility(input)).toEqual({ ok: true });
  });
});

describe("activity requirement - distinct active days (K)", () => {
  it("rejects a single-day burst that clears the message total but not the day spread", () => {
    // 30 messages, but all on one day: fails a 3-distinct-day requirement.
    const input = baseInput({
      reqMessages: 10,
      reqActiveDays: 3,
      dailyCounts: [{ day: "2026-07-10", count: 30 }],
    });
    expect(meetsActivityRequirement(input)).toBe(false);
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "insufficient_activity" });
  });

  it("accepts activity spread across at least K days", () => {
    const input = baseInput({
      reqMessages: 10,
      reqActiveDays: 3,
      dailyCounts: [
        { day: "2026-07-08", count: 4 },
        { day: "2026-07-09", count: 3 },
        { day: "2026-07-10", count: 3 },
      ],
    });
    expect(meetsActivityRequirement(input)).toBe(true);
    expect(checkEligibility(input)).toEqual({ ok: true });
  });

  it("still enforces the message total alongside the day spread", () => {
    // Active on 3 days, but only 3 messages total — fails the message floor.
    const input = baseInput({
      reqMessages: 10,
      reqActiveDays: 3,
      dailyCounts: [
        { day: "2026-07-08", count: 1 },
        { day: "2026-07-09", count: 1 },
        { day: "2026-07-10", count: 1 },
      ],
    });
    expect(meetsActivityRequirement(input)).toBe(false);
  });

  it("a zero day-floor imposes no spread requirement", () => {
    const input = baseInput({
      reqMessages: 10,
      reqActiveDays: 0,
      dailyCounts: [{ day: "2026-07-10", count: 10 }],
    });
    expect(meetsActivityRequirement(input)).toBe(true);
  });
});

describe("checkEligibility - server tenure lockout", () => {
  it("rejects a member who has not been in the server long enough", () => {
    const input = baseInput({
      minServerAgeDays: 7,
      joinedAt: "2026-07-12T00:00:00.000Z", // ~2 days before now
    });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "too_new_to_server" });
  });

  it("accepts a member past the tenure floor", () => {
    const input = baseInput({
      minServerAgeDays: 7,
      joinedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(checkEligibility(input)).toEqual({ ok: true });
  });

  it("rejects when the tenure floor is set but the join date is unknown", () => {
    const input = baseInput({ minServerAgeDays: 7, joinedAt: null });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "too_new_to_server" });
  });

  it("reports account age before server tenure when both would fire", () => {
    const created = Date.parse("2026-07-13T00:00:00.000Z");
    const youngSnowflake = ((BigInt(created) - BigInt(DISCORD_EPOCH)) << 22n).toString();
    const input = baseInput({
      userSnowflake: youngSnowflake,
      minAccountAgeDays: 30,
      minServerAgeDays: 7,
      joinedAt: null,
    });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "account_too_new" });
  });
});

describe("checkEligibility - open to everyone", () => {
  it("waives every requirement below the creator check", () => {
    const input = baseInput({
      openToAll: true,
      dailyCounts: [], // fails activity...
      minServerAgeDays: 30,
      joinedAt: null, // ...and tenure...
      minAccountAgeDays: 3650, // ...and account age...
      excludePriorWinners: true,
      hasPriorWin: true, // ...and prior-winner...
      cooldown: { cooldownDays: 30, cooldownCount: null },
      wins: [{ raffleId: 1, wonAt: "2026-07-13T00:00:00.000Z" }], // ...and cooldown.
    });
    expect(checkEligibility(input)).toEqual({ ok: true });
  });

  it("still rejects a blacklisted member", () => {
    const input = baseInput({ openToAll: true, blacklisted: true });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "blacklisted" });
  });

  it("still rejects the raffle creator", () => {
    const input = baseInput({ openToAll: true, isCreator: true });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "is_creator" });
  });

  it("still rejects a duplicate entry", () => {
    const input = baseInput({ openToAll: true, alreadyEntered: true });
    expect(checkEligibility(input)).toEqual({ ok: false, reason: "already_entered" });
  });
});
