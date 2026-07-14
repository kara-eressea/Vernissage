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
  req_active_days: null,
  open_to_all: 0,
  min_account_age_days: null,
  min_server_age_days: null,
  exclude_prior_winners: 0,
  required_role_id: null,
  excluded_role_id: null,
  cooldown_days: null,
  cooldown_count: null,
  claim_window_hours: null,
  is_test: 0,
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

  it("phrases the activity window as ending at the raffle start", () => {
    expect(joined(base)).toContain("in the 14 days before the raffle starts");
  });

  it("describes the draw mode", () => {
    expect(joined({ ...base, draw_mode: "auto" })).toContain("automatically at close");
    expect(joined({ ...base, draw_mode: "manual" })).toContain("manually by a mod");
  });

  it("mentions the distinct-active-days requirement when set above 1", () => {
    const text = joined({ ...base, req_active_days: 3 });
    expect(text).toContain("on at least 3 different days");
  });

  it("mentions the server-tenure floor when set", () => {
    const text = joined({ ...base, min_server_age_days: 7 });
    expect(text).toContain("been in the server at least 7 days");
  });

  it("collapses to a single open-to-everyone line when open_to_all is set", () => {
    const text = joined({ ...base, open_to_all: 1, min_account_age_days: 30 });
    expect(text).toContain("Open to everyone");
    expect(text).not.toContain("at least 20 messages");
    expect(text).not.toContain("account must be");
  });

  it("mentions cooldowns when set", () => {
    const text = joined({ ...base, cooldown_days: 7, cooldown_count: 2 });
    expect(text).toContain("7 days and 2 raffles");
  });

  it("badges a test raffle and states it awards no prize", () => {
    const text = joined({ ...base, is_test: 1 });
    expect(text).toContain("Test raffle");
    expect(text).toMatch(/no prize/i);
    expect(text).toMatch(/does not affect/i);
  });

  it("omits the test badge for a normal raffle", () => {
    expect(joined(base)).not.toContain("Test raffle");
  });

  it("singularizes a one-winner, one-day raffle", () => {
    const text = joined({ ...base, winner_count: 1, req_messages: 1, req_days: 1 });
    expect(text).toContain("1 winner ");
    expect(text).toContain("at least 1 message ");
    expect(text).toContain("in the 1 day before");
  });
});
