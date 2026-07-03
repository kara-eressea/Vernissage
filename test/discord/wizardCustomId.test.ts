import { describe, expect, it } from "vitest";
import {
  buildWizardId,
  nextStep,
  parseWizardId,
  WIZARD_STEPS,
} from "../../src/discord/wizard/customId.js";

describe("wizard custom id", () => {
  it("round-trips build and parse", () => {
    const id = buildWizardId("schedule", "submit", 42);
    expect(id).toBe("wiz:schedule:submit:42");
    expect(parseWizardId(id)).toEqual({ step: "schedule", action: "submit", raffleId: 42 });
  });

  it("rejects ids from another namespace or malformed shapes", () => {
    expect(parseWizardId("enter:raffle:12")).toBeNull();
    expect(parseWizardId("wiz:schedule:submit")).toBeNull(); // too few parts
    expect(parseWizardId("wiz:schedule:submit:notanumber")).toBeNull();
  });

  it("advances through the steps and stops at the end", () => {
    expect(nextStep("basics")).toBe("schedule");
    expect(nextStep("draw")).toBe("summary");
    expect(nextStep("summary")).toBeNull();
  });

  it("has the design's five steps in order", () => {
    expect(WIZARD_STEPS).toEqual(["basics", "schedule", "eligibility", "draw", "summary"]);
  });
});
