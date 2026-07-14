import { describe, expect, it } from "vitest";
import type {
  SimulatedMember,
  SimulationResult,
  SimulationSettings,
} from "../../src/eligibility/service.js";
import {
  buildConfigCommand,
  buildSimulatorView,
  resolveSimSettings,
} from "../../src/web/simulator.js";

function settings(over: Partial<SimulationSettings> = {}): SimulationSettings {
  return {
    reqMessages: 10,
    reqDays: 14,
    reqActiveDays: 3,
    minAccountAgeDays: 30,
    cooldownDays: 60,
    cooldownCount: null,
    ...over,
  };
}

function member(over: Partial<SimulatedMember> = {}): SimulatedMember {
  return {
    userId: "1",
    messages: 20,
    activeDays: 5,
    accountAgeDays: 100,
    eligible: true,
    reason: null,
    ...over,
  };
}

function result(over: Partial<SimulationResult> = {}): SimulationResult {
  const members = over.members ?? [member()];
  return {
    settings: settings(),
    considered: members.length,
    eligible: members.filter((m) => m.eligible).length,
    ...over,
    members,
  };
}

describe("resolveSimSettings", () => {
  const base = settings({
    reqMessages: 10,
    reqDays: 14,
    reqActiveDays: 0,
    minAccountAgeDays: 0,
    cooldownDays: 0,
  });

  it("overlays parsed params onto the base settings", () => {
    const out = resolveSimSettings(
      base,
      new URLSearchParams("req-messages=25&req-days=7&cooldown-days=90"),
    );
    expect(out.reqMessages).toBe(25);
    expect(out.reqDays).toBe(7);
    expect(out.cooldownDays).toBe(90);
    // Untouched dials keep the base value; cooldownCount is not a slider.
    expect(out.reqActiveDays).toBe(0);
    expect(out.cooldownCount).toBeNull();
  });

  it("clamps out-of-range values to each dial's bounds", () => {
    const hi = resolveSimSettings(base, new URLSearchParams("req-messages=999"));
    expect(hi.reqMessages).toBe(50);
    const lo = resolveSimSettings(base, new URLSearchParams("req-messages=-5&req-days=0"));
    expect(lo.reqMessages).toBe(0);
    expect(lo.reqDays).toBe(1); // window floor is 1
  });

  it("ignores missing or non-numeric params", () => {
    const out = resolveSimSettings(base, new URLSearchParams("req-messages=abc&req-days="));
    expect(out.reqMessages).toBe(10);
    expect(out.reqDays).toBe(14);
  });
});

describe("buildConfigCommand", () => {
  it("uses the real /raffle config set option names", () => {
    expect(buildConfigCommand(settings())).toBe(
      "/raffle config set req-messages:10 req-days:14 req-active-days:3 min-account-age-days:30 cooldown-days:60",
    );
  });

  it("renders a null age or cooldown as 0", () => {
    expect(buildConfigCommand(settings({ minAccountAgeDays: null, cooldownDays: null }))).toContain(
      "min-account-age-days:0 cooldown-days:0",
    );
  });
});

describe("buildSimulatorView", () => {
  const members = [
    member({ userId: "111", messages: 20, eligible: true, reason: null }),
    member({ userId: "222", messages: 5, eligible: false, reason: "insufficient_activity" }),
    member({
      userId: "333",
      messages: 12,
      eligible: false,
      reason: "account_too_new",
      accountAgeDays: 12,
    }),
  ];

  it("exposes the five dials seeded from the settings", () => {
    const view = buildSimulatorView(result({ members }), "all");
    expect(view.sliders).toHaveLength(5);
    expect(view.sliders[0]!.param).toBe("req-messages");
    expect(view.sliders[0]!.value).toBe(10);
    expect(view.command).toContain("/raffle config set");
  });

  it("counts the filter tabs and shows blocked members first", () => {
    const view = buildSimulatorView(result({ members }), "all");
    expect(view.considered).toBe(3);
    expect(view.eligible).toBe(1);
    expect(view.filterTabs.map((t) => t.label)).toEqual(["All 3", "Eligible 1", "Blocked 2"]);
    // Blocked first, busiest first within a group: 333 (12), 222 (5), then 111.
    expect(view.rows.map((r) => r.userId)).toEqual(["333", "222", "111"]);
  });

  it("filters to blocked members only", () => {
    const view = buildSimulatorView(result({ members }), "blocked");
    expect(view.rows.map((r) => r.userId)).toEqual(["333", "222"]);
    expect(view.filterTabs.find((t) => t.filter === "blocked")!.active).toBe(true);
  });

  it("writes a plain-language reason per row", () => {
    const view = buildSimulatorView(result({ members }), "all");
    const byId = new Map(view.rows.map((r) => [r.userId, r]));
    expect(byId.get("111")!.reason).toBe("—");
    expect(byId.get("222")!.reason).toBe("Needs 10 msgs · has 5");
    expect(byId.get("333")!.reason).toBe("Account too new · 12d old");
  });

  it("distinguishes the day-spread failure from the message-count failure", () => {
    // Reason is insufficient_activity but the message count is met, so it's days.
    const dayFail = member({
      userId: "444",
      messages: 15,
      activeDays: 1,
      eligible: false,
      reason: "insufficient_activity",
    });
    const view = buildSimulatorView(result({ members: [dayFail] }), "all");
    expect(view.rows[0]!.reason).toBe("Only 1 active day · needs 3");
  });

  it("places the threshold line and marks bins above X as clearing", () => {
    const view = buildSimulatorView(result({ members }), "all");
    expect(view.histogram.bins.length).toBeGreaterThan(0);
    expect(view.histogram.axisMax).toBeGreaterThanOrEqual(12);
    // The first bin starts at 0 messages, below X=10, so it does not clear.
    expect(view.histogram.bins[0]!.clears).toBe(false);
  });

  it("handles a guild with no counted activity", () => {
    const view = buildSimulatorView(result({ members: [] }), "all");
    expect(view.hasCandidates).toBe(false);
    expect(view.pctClear).toBe(0);
    expect(view.rows).toHaveLength(0);
    expect(view.shownLabel).toBe("0 members");
  });
});
