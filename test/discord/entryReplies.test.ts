import { describe, expect, it } from "vitest";
import {
  entryFailureMessage,
  entrySuccessMessage,
  raffleListMessage,
  statusMessage,
} from "../../src/discord/messages/entryReplies.js";
import type { EligibilityInput } from "../../src/core/types.js";

function input(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    status: "open",
    blacklisted: false,
    isCreator: false,
    userRoleIds: [],
    requiredRoleId: null,
    excludedRoleId: null,
    userSnowflake: "1",
    minAccountAgeDays: null,
    cooldown: { cooldownDays: 7, cooldownCount: null },
    wins: [{ raffleId: 1, wonAt: "2026-07-01T00:00:00.000Z" }],
    rafflesSinceLastWin: 0,
    excludePriorWinners: false,
    hasPriorWin: false,
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

describe("statusMessage", () => {
  it("shows activity progress, cooldown, and entry state", () => {
    // 8 messages in-window against a 20 requirement, an active cooldown, entered.
    const msg = statusMessage("Big One", input({ alreadyEntered: true }));
    expect(msg).toContain("Big One");
    expect(msg).toContain("8/20");
    expect(msg.toLowerCase()).toContain("cooldown");
    expect(msg).toContain("already entered");
  });

  it("marks a blacklisted member and the new-member activity exemption", () => {
    const msg = statusMessage(
      null,
      input({ blacklisted: true, newMemberExempt: true, newMemberDays: 7, joinedAt: "2026-07-04T00:00:00.000Z" }),
    );
    expect(msg.toLowerCase()).toContain("blacklisted");
    expect(msg.toLowerCase()).toContain("exempt");
  });
});

describe("raffleListMessage", () => {
  it("labels open raffles with their close time and scheduled ones as upcoming", () => {
    const msg = raffleListMessage([
      { raffle_id: 1, name: "Open One", status: "open", starts_at: null, ends_at: "2026-08-01T00:00:00.000Z" },
      { raffle_id: 2, name: null, status: "scheduled", starts_at: "2026-08-05T00:00:00.000Z", ends_at: null },
    ]);
    expect(msg).toContain("Open One");
    expect(msg).toContain("closes");
    expect(msg).toContain("Raffle #2"); // null name falls back to the id
    expect(msg).toContain("opens");
  });
});
