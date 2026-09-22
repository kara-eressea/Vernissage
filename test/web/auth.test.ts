import { describe, expect, it } from "vitest";
import {
  hasManageGuild,
  MANAGE_GUILD,
  selectManageableGuilds,
  selectViewableGuilds,
} from "../../src/web/auth.js";
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

describe("selectViewableGuilds", () => {
  const SUPPORT = ["support-1"];

  it("changes nothing for an ordinary moderator", () => {
    const result = selectViewableGuilds([guild({ id: "g1", owner: true })], ALLOWLIST, {
      userId: "mod-1",
      supportUserIds: SUPPORT,
    });
    expect(result).toEqual([{ id: "g1", name: "Guild One", icon: null }]);
  });

  it("gives a support viewer every allowlisted guild, read-only", () => {
    // The case this exists for: invited to a server, not a moderator of it.
    const result = selectViewableGuilds([guild({ id: "g1", permissions: "0" })], ALLOWLIST, {
      userId: "support-1",
      supportUserIds: SUPPORT,
    });
    expect(result).toEqual([
      { id: "g1", name: "Guild One", icon: null, viewOnly: true },
      { id: "g2", name: "Server g2", icon: null, viewOnly: true },
    ]);
  });

  it("names a guild from the viewer's own list when they are a member of it", () => {
    const result = selectViewableGuilds(
      [guild({ id: "g2", name: "Second", icon: "abc", permissions: "0" })],
      ALLOWLIST,
      { userId: "support-1", supportUserIds: SUPPORT },
    );
    // g1 they are not in at all, so it falls back to the id.
    expect(result).toEqual([
      { id: "g1", name: "Server g1", icon: null, viewOnly: true },
      { id: "g2", name: "Second", icon: "abc", viewOnly: true },
    ]);
  });

  it("keeps full access to a guild the support viewer actually moderates", () => {
    const result = selectViewableGuilds(
      [guild({ id: "g1", name: "Mine", permissions: MANAGE_GUILD.toString() })],
      ALLOWLIST,
      { userId: "support-1", supportUserIds: SUPPORT },
    );
    // Moderated guilds come first and carry no read-only flag.
    expect(result[0]).toEqual({ id: "g1", name: "Mine", icon: null });
    expect(result[1]).toMatchObject({ id: "g2", viewOnly: true });
  });

  it("grants nothing extra once an id is removed from the support list", () => {
    const result = selectViewableGuilds([guild({ id: "g1", permissions: "0" })], ALLOWLIST, {
      userId: "support-1",
      supportUserIds: [],
    });
    expect(result).toEqual([]);
  });
});
