import { describe, expect, it } from "vitest";
import { resolveEntrySettings } from "../../src/core/settings.js";

const defaults = {
  default_min_account_age_days: 30,
  default_cooldown_days: 7,
  default_cooldown_count: 2,
};

describe("resolveEntrySettings", () => {
  it("falls back to guild defaults when the raffle leaves fields unset", () => {
    const resolved = resolveEntrySettings(
      { min_account_age_days: null, cooldown_days: null, cooldown_count: null },
      defaults,
    );
    expect(resolved).toEqual({ minAccountAgeDays: 30, cooldownDays: 7, cooldownCount: 2 });
  });

  it("keeps per-raffle overrides, including an explicit 0", () => {
    const resolved = resolveEntrySettings(
      { min_account_age_days: 0, cooldown_days: 3, cooldown_count: 5 },
      defaults,
    );
    expect(resolved).toEqual({ minAccountAgeDays: 0, cooldownDays: 3, cooldownCount: 5 });
  });

  it("is all-null when neither raffle nor guild sets anything", () => {
    const resolved = resolveEntrySettings(
      { min_account_age_days: null, cooldown_days: null, cooldown_count: null },
      { default_min_account_age_days: null, default_cooldown_days: null, default_cooldown_count: null },
    );
    expect(resolved).toEqual({ minAccountAgeDays: null, cooldownDays: null, cooldownCount: null });
  });
});
