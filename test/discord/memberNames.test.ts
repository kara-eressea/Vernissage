import { describe, expect, it } from "vitest";
import type { APIInteractionGuildMember, GuildMember, User } from "discord.js";
import { nameFromMember } from "../../src/discord/memberNames.js";

function user(over: Partial<{ username: string; globalName: string | null }> = {}): User {
  return { username: "alice", globalName: "Alice G", ...over } as unknown as User;
}

describe("nameFromMember", () => {
  it("prefers a full member's server nickname (displayName getter)", () => {
    const member = { displayName: "Ally the mod" } as unknown as GuildMember;
    expect(nameFromMember(user(), member)).toEqual({ username: "alice", displayName: "Ally the mod" });
  });

  it("uses a raw API member's nick when there is no displayName getter", () => {
    const member = { nick: "Ally raw" } as unknown as APIInteractionGuildMember;
    expect(nameFromMember(user(), member).displayName).toBe("Ally raw");
  });

  it("falls back to the global name when the member has no nickname", () => {
    const member = { nick: null } as unknown as APIInteractionGuildMember;
    expect(nameFromMember(user(), member).displayName).toBe("Alice G");
  });

  it("falls back to the username when there is no member and no global name", () => {
    expect(nameFromMember(user({ globalName: null }), null).displayName).toBe("alice");
  });
});
