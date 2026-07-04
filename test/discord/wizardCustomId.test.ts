import { describe, expect, it } from "vitest";
import { buildWizardId, parseWizardId } from "../../src/discord/wizard/customId.js";

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
});
