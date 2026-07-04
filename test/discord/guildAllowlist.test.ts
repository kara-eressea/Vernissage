import { describe, expect, it } from "vitest";
import { shouldLeaveGuild } from "../../src/discord/guildAllowlist.js";

describe("shouldLeaveGuild", () => {
  const allowed = new Set(["111111111111111111", "222222222222222222"]);

  it("stays in an allowlisted guild", () => {
    expect(shouldLeaveGuild("111111111111111111", allowed)).toBe(false);
    expect(shouldLeaveGuild("222222222222222222", allowed)).toBe(false);
  });

  it("leaves any guild not on the allowlist", () => {
    expect(shouldLeaveGuild("999999999999999999", allowed)).toBe(true);
  });

  it("leaves everything when the allowlist is empty", () => {
    expect(shouldLeaveGuild("111111111111111111", new Set())).toBe(true);
  });
});
