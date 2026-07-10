import { describe, expect, it } from "vitest";
import { resolveEntrySettings } from "../../src/core/settings.js";

const defaults = {
  default_min_account_age_days: 30,
  default_min_server_age_days: 5,
  default_cooldown_days: 7,
  default_cooldown_count: 2,
};

describe("resolveEntrySettings", () => {
  it("takes account age and tenure from the guild defaults; cooldown falls back", () => {
    const resolved = resolveEntrySettings(
      { cooldown_days: null, cooldown_count: null },
      defaults,
    );
    expect(resolved).toEqual({
      minAccountAgeDays: 30,
      minServerAgeDays: 5,
      cooldownDays: 7,
      cooldownCount: 2,
    });
  });

  it("keeps per-raffle cooldown overrides, including an explicit 0", () => {
    const resolved = resolveEntrySettings(
      { cooldown_days: 0, cooldown_count: 5 },
      defaults,
    );
    expect(resolved).toEqual({
      minAccountAgeDays: 30,
      minServerAgeDays: 5,
      cooldownDays: 0,
      cooldownCount: 5,
    });
  });

  it("is all-null when neither raffle nor guild sets anything", () => {
    const resolved = resolveEntrySettings(
      { cooldown_days: null, cooldown_count: null },
      {
        default_min_account_age_days: null,
        default_min_server_age_days: null,
        default_cooldown_days: null,
        default_cooldown_count: null,
      },
    );
    expect(resolved).toEqual({
      minAccountAgeDays: null,
      minServerAgeDays: null,
      cooldownDays: null,
      cooldownCount: null,
    });
  });
});
