import { describe, expect, it } from "vitest";
import { isModerator } from "../../src/core/permissions.js";

describe("isModerator", () => {
  const base = {
    modRole: null,
    memberRoleIds: [] as string[],
    isGuildOwner: false,
    hasManageGuild: false,
  };

  it("passes the guild owner regardless of mod role", () => {
    expect(isModerator({ ...base, isGuildOwner: true })).toBe(true);
    expect(isModerator({ ...base, isGuildOwner: true, modRole: "r1" })).toBe(true);
  });

  it("passes a member with Manage Server", () => {
    expect(isModerator({ ...base, hasManageGuild: true })).toBe(true);
  });

  it("fails an ordinary member before a mod role is set (bootstrap)", () => {
    expect(isModerator({ ...base, memberRoleIds: ["r1", "r2"] })).toBe(false);
  });

  it("passes a member holding the configured mod role", () => {
    expect(isModerator({ ...base, modRole: "mods", memberRoleIds: ["x", "mods"] })).toBe(true);
  });

  it("fails a member lacking the configured mod role", () => {
    expect(isModerator({ ...base, modRole: "mods", memberRoleIds: ["x", "y"] })).toBe(false);
  });
});
