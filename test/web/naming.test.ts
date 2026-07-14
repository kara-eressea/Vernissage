import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_NAME, GUILDLESS_NAME, resolveDisplayName } from "../../src/web/naming.js";

describe("resolveDisplayName", () => {
  it("names no bot on guild-less screens", () => {
    expect(resolveDisplayName(null)).toBe(GUILDLESS_NAME);
    expect(resolveDisplayName()).toBe(GUILDLESS_NAME);
    expect(GUILDLESS_NAME).toBe("Moderator Dashboard");
  });

  it("falls back to the user-facing bot name in a guild with no stored nickname", () => {
    expect(resolveDisplayName({})).toBe(DEFAULT_BOT_NAME);
    expect(resolveDisplayName({ botNickname: null })).toBe(DEFAULT_BOT_NAME);
    expect(resolveDisplayName({ botNickname: "   " })).toBe(DEFAULT_BOT_NAME);
    expect(DEFAULT_BOT_NAME).toBe("Tombola");
  });

  it("uses the stored per-guild nickname when present", () => {
    expect(resolveDisplayName({ botNickname: "Raffles" })).toBe("Raffles");
  });
});
