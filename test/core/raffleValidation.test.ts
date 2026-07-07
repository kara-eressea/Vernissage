import { describe, expect, it } from "vitest";
import {
  resolveRaffleSettings,
  validateBasics,
  validateDraft,
  validateDraw,
  validateEligibility,
  validateOpenRaffleEdit,
  START_GRACE_MS,
  validateSchedule,
  type RaffleDraftFields,
} from "../../src/core/raffleValidation.js";

const NOW = "2026-07-03T12:00:00.000Z";

const validDraft: RaffleDraftFields = {
  name: "Giveaway",
  description: null,
  prize: "A record",
  starts_at: "2026-07-10T12:00:00.000Z",
  ends_at: "2026-07-17T12:00:00.000Z",
  winner_count: 1,
  req_messages: 20,
  req_days: 14,
  window_anchor: "start",
  new_member_exempt: 0,
  new_member_days: null,
  min_account_age_days: null,
  exclude_prior_winners: 0,
  required_role_id: null,
  excluded_role_id: null,
  cooldown_days: null,
  cooldown_count: null,
  claim_window_hours: null,
  is_test: 0,
  draw_mode: "auto",
};

describe("validateBasics", () => {
  it("requires a name and a prize", () => {
    expect(validateBasics({ name: "x", prize: "y" }).ok).toBe(true);
    expect(validateBasics({ name: "", prize: "y" }).ok).toBe(false);
    expect(validateBasics({ name: "x", prize: "  " }).ok).toBe(false);
  });
});

describe("validateSchedule", () => {
  it("accepts a future window with end after start", () => {
    expect(validateSchedule(validDraft.starts_at, validDraft.ends_at, NOW).ok).toBe(true);
  });

  it("rejects a start in the past", () => {
    expect(validateSchedule("2026-07-01T00:00:00.000Z", validDraft.ends_at, NOW).ok).toBe(false);
  });

  it("accepts a start within the grace window, so a typed 'now' survives to confirm", () => {
    const now = Date.parse(NOW);
    const justInside = new Date(now - START_GRACE_MS + 60_000).toISOString();
    const justOutside = new Date(now - START_GRACE_MS - 60_000).toISOString();
    expect(validateSchedule(justInside, validDraft.ends_at, NOW).ok).toBe(true);
    expect(validateSchedule(justOutside, validDraft.ends_at, NOW).ok).toBe(false);
  });

  it("rejects end before or equal to start", () => {
    const s = "2026-07-10T12:00:00.000Z";
    expect(validateSchedule(s, "2026-07-09T12:00:00.000Z", NOW).ok).toBe(false);
    expect(validateSchedule(s, s, NOW).ok).toBe(false);
  });

  it("rejects missing times", () => {
    expect(validateSchedule(null, validDraft.ends_at, NOW).ok).toBe(false);
  });
});

describe("validateEligibility", () => {
  const base = {
    req_messages: 20,
    req_days: 14,
    window_anchor: "start",
    min_account_age_days: null,
    new_member_exempt: 0,
    new_member_days: null,
  };

  it("accepts a valid config", () => {
    expect(validateEligibility(base).ok).toBe(true);
  });

  it("rejects X of 0 and Y of 0", () => {
    expect(validateEligibility({ ...base, req_messages: 0 }).ok).toBe(false);
    expect(validateEligibility({ ...base, req_days: 0 }).ok).toBe(false);
  });

  it("rejects a new-member exemption without a join window", () => {
    expect(validateEligibility({ ...base, new_member_exempt: 1, new_member_days: null }).ok).toBe(
      false,
    );
    expect(validateEligibility({ ...base, new_member_exempt: 1, new_member_days: 7 }).ok).toBe(true);
  });

  it("rejects an unknown window anchor", () => {
    expect(validateEligibility({ ...base, window_anchor: "sideways" }).ok).toBe(false);
  });
});

describe("validateDraw", () => {
  it("requires at least one winner and a valid mode", () => {
    expect(validateDraw({ winner_count: 1, draw_mode: "auto" }).ok).toBe(true);
    expect(validateDraw({ winner_count: 0, draw_mode: "auto" }).ok).toBe(false);
    expect(validateDraw({ winner_count: 1, draw_mode: "coinflip" }).ok).toBe(false);
  });
});

describe("validateDraft", () => {
  it("accepts a fully valid draft", () => {
    expect(validateDraft(validDraft, NOW).ok).toBe(true);
  });

  it("surfaces the first failing step", () => {
    const bad = { ...validDraft, prize: null };
    const result = validateDraft(bad, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/prize/i);
  });
});

describe("resolveRaffleSettings", () => {
  const defaults = {
    default_cooldown_days: 7,
    default_cooldown_count: 2,
    default_min_account_age_days: 30,
  };

  it("fills unset fields from guild defaults", () => {
    const resolved = resolveRaffleSettings(validDraft, defaults);
    expect(resolved.cooldown_days).toBe(7);
    expect(resolved.cooldown_count).toBe(2);
    expect(resolved.min_account_age_days).toBe(30);
  });

  it("keeps explicit per-raffle overrides", () => {
    const resolved = resolveRaffleSettings(
      { ...validDraft, cooldown_days: 3, min_account_age_days: 0 },
      defaults,
    );
    expect(resolved.cooldown_days).toBe(3);
    expect(resolved.min_account_age_days).toBe(0); // explicit 0 is not overridden
  });
});

describe("validateOpenRaffleEdit", () => {
  // The first argument is the raffle's *start* time; the end may be corrected to
  // any instant after it (earlier or later than the current end).
  const start = "2026-07-15T12:00:00.000Z";

  it("accepts a later end", () => {
    expect(validateOpenRaffleEdit(start, "2026-07-20T12:00:00.000Z").ok).toBe(true);
  });

  it("accepts an earlier end, as long as it is after the start", () => {
    // The July-5 -> July-4 correction: still after the raffle opened.
    expect(validateOpenRaffleEdit(start, "2026-07-16T00:00:00.000Z").ok).toBe(true);
  });

  it("rejects an end at or before the start", () => {
    expect(validateOpenRaffleEdit(start, start).ok).toBe(false);
    expect(validateOpenRaffleEdit(start, "2026-07-15T00:00:00.000Z").ok).toBe(false);
  });

  it("rejects an invalid time or a missing start", () => {
    expect(validateOpenRaffleEdit(start, "not-a-time").ok).toBe(false);
    expect(validateOpenRaffleEdit(null, "2026-07-20T12:00:00.000Z").ok).toBe(false);
  });
});
