import { describe, expect, it } from "vitest";
import {
  entryFailureMessage,
  entrySuccessMessage,
} from "../../src/discord/messages/entryReplies.js";
import type { EligibilityInput } from "../../src/core/types.js";

function input(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    status: "open",
    blacklisted: false,
    userSnowflake: "1",
    minAccountAgeDays: null,
    cooldown: { cooldownDays: 7, cooldownCount: null },
    wins: [{ raffleId: 1, wonAt: "2026-07-01T00:00:00.000Z" }],
    rafflesSinceLastWin: 0,
    reqMessages: 20,
    reqDays: 14,
    windowAnchor: "start",
    raffleStart: "2026-07-10T12:00:00.000Z",
    newMemberExempt: false,
    newMemberDays: null,
    joinedAt: null,
    dailyCounts: [{ day: "2026-07-05", count: 8 }],
    alreadyEntered: false,
    now: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("entrySuccessMessage", () => {
  it("names the raffle", () => {
    expect(entrySuccessMessage("Big One")).toContain("Big One");
  });
});

describe("entryFailureMessage", () => {
  it("hides the blacklist behind a generic line when the guild opts in", () => {
    const specific = entryFailureMessage("blacklisted", input(), false);
    const generic = entryFailureMessage("blacklisted", input(), true);
    expect(specific.toLowerCase()).toContain("blacklisted");
    expect(generic.toLowerCase()).not.toContain("blacklisted");
  });

  it("quotes have/need for an activity shortfall", () => {
    const msg = entryFailureMessage("insufficient_activity", input(), false);
    expect(msg).toContain("20");
    expect(msg).toContain("8");
  });

  it("describes the win cooldown", () => {
    const msg = entryFailureMessage("in_cooldown", input(), false);
    expect(msg.toLowerCase()).toContain("cooldown");
  });

  it("has a line for every reason", () => {
    for (const reason of [
      "not_open",
      "account_too_new",
      "already_entered",
    ] as const) {
      expect(entryFailureMessage(reason, input(), false).length).toBeGreaterThan(0);
    }
  });
});
