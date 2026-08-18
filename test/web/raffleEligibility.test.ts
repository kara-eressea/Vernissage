import { describe, expect, it } from "vitest";
import type {
  RaffleEligibilityMember,
  RaffleEligibilityReport,
} from "../../src/eligibility/service.js";
import { buildRaffleEligibilityView } from "../../src/web/raffleEligibility.js";

function member(overrides: Partial<RaffleEligibilityMember> = {}): RaffleEligibilityMember {
  return {
    userId: "u1",
    messages: 20,
    activeDays: 5,
    accountAgeDays: 400,
    entered: false,
    eligible: true,
    reasons: [],
    missesVolume: false,
    missesSpread: false,
    ...overrides,
  };
}

function report(members: RaffleEligibilityMember[], overrides: Partial<RaffleEligibilityReport> = {}): RaffleEligibilityReport {
  return {
    raffleId: 6,
    raffleName: "Weyn Raffle",
    status: "open",
    isTest: false,
    anchoredAt: "2026-08-16T20:24:00.000Z",
    window: { startDay: "2026-08-03", endDay: "2026-08-16" },
    settings: {
      reqMessages: 10,
      reqDays: 14,
      reqActiveDays: 5,
      minAccountAgeDays: 30,
      cooldownDays: 180,
      cooldownCount: 1,
      openToAll: false,
      excludePriorWinners: false,
      requiredRoleId: null,
      excludedRoleId: null,
    },
    considered: members.length,
    eligible: members.filter((m) => m.eligible).length,
    entered: members.filter((m) => m.entered).length,
    members,
    ...overrides,
  };
}

describe("buildRaffleEligibilityView", () => {
  it("spells out a spread failure with the member's own numbers", () => {
    const view = buildRaffleEligibilityView(
      report([
        member({
          userId: "u1",
          messages: 45,
          activeDays: 4,
          eligible: false,
          reasons: ["insufficient_activity"],
          missesSpread: true,
        }),
      ]),
      "all",
    );
    expect(view.rows[0]!.reasons).toEqual(["Needs 5 active days · has 4"]);
  });

  it("spells out a volume failure separately from a spread one", () => {
    const view = buildRaffleEligibilityView(
      report([
        member({
          messages: 3,
          activeDays: 5,
          eligible: false,
          reasons: ["insufficient_activity"],
          missesVolume: true,
        }),
      ]),
      "all",
    );
    expect(view.rows[0]!.reasons).toEqual(["Needs 10 msgs · has 3"]);
  });

  it("reports both floors when a member misses both", () => {
    const view = buildRaffleEligibilityView(
      report([
        member({
          messages: 2,
          activeDays: 1,
          eligible: false,
          reasons: ["insufficient_activity"],
          missesVolume: true,
          missesSpread: true,
        }),
      ]),
      "all",
    );
    expect(view.rows[0]!.reasons).toEqual(["Needs 10 msgs on 5 days · has 2 on 1"]);
  });

  it("lists every failing gate, not just one", () => {
    const view = buildRaffleEligibilityView(
      report([
        member({
          eligible: false,
          reasons: ["in_cooldown", "insufficient_activity"],
          missesVolume: true,
          messages: 1,
        }),
      ]),
      "all",
    );
    expect(view.rows[0]!.reasons).toEqual(["In win cooldown", "Needs 10 msgs · has 1"]);
  });

  it("labels entrants distinctly from merely-eligible members", () => {
    const view = buildRaffleEligibilityView(
      report([
        member({ userId: "entered", entered: true }),
        member({ userId: "eligible" }),
        member({ userId: "blocked", eligible: false, reasons: ["blacklisted"] }),
      ]),
      "all",
    );
    const byId = new Map(view.rows.map((r) => [r.userId, r.statusLabel]));
    expect(byId.get("entered")).toBe("Entered");
    expect(byId.get("eligible")).toBe("Eligible");
    expect(byId.get("blocked")).toBe("Blocked");
  });

  it("counts eligible members who never entered", () => {
    const view = buildRaffleEligibilityView(
      report([
        member({ userId: "a", entered: true }),
        member({ userId: "b" }),
        member({ userId: "c" }),
        member({ userId: "d", eligible: false, reasons: ["blacklisted"] }),
      ]),
      "all",
    );
    expect(view.missed).toBe(2);
  });

  it("filters to blocked, eligible, or entered members", () => {
    const members = [
      member({ userId: "a", entered: true }),
      member({ userId: "b" }),
      member({ userId: "c", eligible: false, reasons: ["blacklisted"] }),
    ];
    expect(buildRaffleEligibilityView(report(members), "blocked").rows.map((r) => r.userId)).toEqual(["c"]);
    expect(buildRaffleEligibilityView(report(members), "entered").rows.map((r) => r.userId)).toEqual(["a"]);
    expect(buildRaffleEligibilityView(report(members), "eligible").rows.map((r) => r.userId).sort()).toEqual(["a", "b"]);
  });

  it("labels the member by cached name, falling back to the id", () => {
    const view = buildRaffleEligibilityView(
      report([member({ userId: "u1" }), member({ userId: "u2" })]),
      "all",
      new Map([["u1", "Mobi"]]),
    );
    const byId = new Map(view.rows.map((r) => [r.userId, r.name]));
    expect(byId.get("u1")).toBe("Mobi");
    expect(byId.get("u2")).toBeNull();
  });

  it("describes the window as ending when the raffle opened", () => {
    const view = buildRaffleEligibilityView(report([member()]), "all");
    expect(view.windowLabel).toContain("3 Aug");
    expect(view.windowLabel).toContain("16 Aug 2026");
    expect(view.windowLabel).toContain("ending when the raffle opened");
  });

  it("recaps the bar the raffle applied", () => {
    const view = buildRaffleEligibilityView(report([member()]), "all");
    expect(view.barLabel).toBe("10 msgs / 14 days · 5 active days · 30d+ account · 180d cooldown");
  });

  it("says an open-to-everyone raffle had no bar", () => {
    const base = report([member()]);
    const view = buildRaffleEligibilityView(
      { ...base, settings: { ...base.settings, openToAll: true } },
      "all",
    );
    expect(view.barLabel).toContain("Open to everyone");
  });

  it("warns that a role gate could not be checked", () => {
    const base = report([member()]);
    const view = buildRaffleEligibilityView(
      { ...base, settings: { ...base.settings, requiredRoleId: "r1" } },
      "all",
    );
    expect(view.caveats.some((c) => c.includes("role gate"))).toBe(true);
  });

  it("always states the candidate-set and blacklist blind spots", () => {
    const view = buildRaffleEligibilityView(report([member()]), "all");
    expect(view.caveats.some((c) => c.includes("never posted"))).toBe(true);
    expect(view.caveats.some((c) => c.includes("blacklist"))).toBe(true);
  });
});
