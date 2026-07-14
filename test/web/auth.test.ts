import { describe, expect, it } from "vitest";
import { hasManageGuild, MANAGE_GUILD, selectManageableGuilds } from "../../src/web/auth.js";
import type { DiscordPartialGuild } from "../../src/web/oauth.js";

const ALLOWLIST = ["g1", "g2"];

function guild(overrides: Partial<DiscordPartialGuild>): DiscordPartialGuild {
  return {
    id: "g1",
    name: "Guild One",
    icon: null,
    owner: false,
    permissions: "0",
    ...overrides,
  };
}

describe("hasManageGuild", () => {
  it("detects the Manage Server bit", () => {
    expect(hasManageGuild(MANAGE_GUILD.toString())).toBe(true);
    // Administrator (bit 3) alone does not set MANAGE_GUILD; test the exact bit.
    expect(hasManageGuild("0")).toBe(false);
    expect(hasManageGuild((MANAGE_GUILD | 8n).toString())).toBe(true);
  });

  it("treats malformed permissions as no permission", () => {
    expect(hasManageGuild("not-a-number")).toBe(false);
  });
});

describe("selectManageableGuilds", () => {
  it("includes an allowlisted guild the user owns", () => {
    const result = selectManageableGuilds([guild({ id: "g1", owner: true })], ALLOWLIST);
    expect(result).toEqual([{ id: "g1", name: "Guild One", icon: null }]);
  });

  it("includes an allowlisted guild where the user has Manage Server", () => {
    const result = selectManageableGuilds(
      [guild({ id: "g2", name: "Two", permissions: MANAGE_GUILD.toString() })],
      ALLOWLIST,
    );
    expect(result.map((g) => g.id)).toEqual(["g2"]);
  });

  it("excludes a guild not on the allowlist even with Manage Server", () => {
    const result = selectManageableGuilds(
      [guild({ id: "other", owner: true, permissions: MANAGE_GUILD.toString() })],
      ALLOWLIST,
    );
    expect(result).toEqual([]);
  });

  it("excludes an allowlisted guild where the user is a plain member", () => {
    const result = selectManageableGuilds([guild({ id: "g1", permissions: "0" })], ALLOWLIST);
    expect(result).toEqual([]);
  });

  it("keeps only the qualifying guilds from a mixed list", () => {
    const result = selectManageableGuilds(
      [
        guild({ id: "g1", owner: true }),
        guild({ id: "g2", permissions: "0" }),
        guild({ id: "other", owner: true }),
      ],
      ALLOWLIST,
    );
    expect(result.map((g) => g.id)).toEqual(["g1"]);
  });
});
