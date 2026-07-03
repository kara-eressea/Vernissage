import { describe, expect, it } from "vitest";
import { shouldLeaveGuild } from "../../src/discord/homeGuild.js";

describe("shouldLeaveGuild", () => {
  const home = "111111111111111111";

  it("stays in the home guild", () => {
    expect(shouldLeaveGuild(home, home)).toBe(false);
  });

  it("leaves any other guild", () => {
    expect(shouldLeaveGuild("999999999999999999", home)).toBe(true);
  });
});
