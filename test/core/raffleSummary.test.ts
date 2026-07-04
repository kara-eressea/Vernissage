import { describe, expect, it } from "vitest";
import { describeRaffle } from "../../src/core/raffleSummary.js";
import type { ResolvedRaffleSettings } from "../../src/core/raffleValidation.js";

const base: ResolvedRaffleSettings = {
  name: "Summer Giveaway",
  description: null,
  prize: "A vinyl record",
  starts_at: "2026-07-10T12:00:00.000Z",
  ends_at: "2026-07-17T12:00:00.000Z",
  winner_count: 2,
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
  draw_mode: "auto",
};

function joined(settings: ResolvedRaffleSettings): string {
  return describeRaffle(settings).join("\n");
}

describe("describeRaffle", () => {
  it("echoes name, prize, X/Y and winner count", () => {
    const text = joined(base);
    expect(text).toContain("Summer Giveaway");
    expect(text).toContain("A vinyl record");
    expect(text).toContain("at least 20 messages");
    expect(text).toContain("2 winners");
  });

  it("uses anchored phrasing for the 'start' window", () => {
    expect(joined({ ...base, window_anchor: "start" })).toContain(
      "in the 14 days before the raffle starts",
    );
  });

  it("uses rolling phrasing for the 'rolling' window", () => {
    const text = joined({ ...base, window_anchor: "rolling" });
    expect(text).toContain("in the 14 days before they enter");
    expect(text).not.toContain("before the raffle starts");
  });

  it("describes the draw mode", () => {
    expect(joined({ ...base, draw_mode: "auto" })).toContain("automatically at close");
    expect(joined({ ...base, draw_mode: "manual" })).toContain("manually by a mod");
  });

  it("mentions the new-member exemption when enabled", () => {
    const text = joined({ ...base, new_member_exempt: 1, new_member_days: 7 });
    expect(text).toContain("joined in the last 7 days are exempt");
  });

  it("mentions cooldowns when set", () => {
    const text = joined({ ...base, cooldown_days: 7, cooldown_count: 2 });
    expect(text).toContain("7 days and 2 raffles");
  });

  it("singularizes a one-winner, one-day raffle", () => {
    const text = joined({ ...base, winner_count: 1, req_messages: 1, req_days: 1 });
    expect(text).toContain("1 winner ");
    expect(text).toContain("at least 1 message ");
    expect(text).toContain("in the 1 day before");
  });
});
