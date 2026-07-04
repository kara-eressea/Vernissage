import { describe, expect, it } from "vitest";
import { ConfigError, ENV, loadConfig } from "../src/config.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    [ENV.token]: "tok",
    [ENV.appId]: "app",
    [ENV.guildIds]: "guild",
  };
}

describe("loadConfig", () => {
  it("builds a config from a complete environment", () => {
    expect(loadConfig(baseEnv())).toEqual({
      token: "tok",
      appId: "app",
      guildIds: ["guild"],
      databasePath: "./vernissage.db",
    });
  });

  it("parses a comma-separated allowlist, trimming and de-duplicating", () => {
    const env = { ...baseEnv(), [ENV.guildIds]: " g1 , g2 ,g1, " };
    expect(loadConfig(env).guildIds).toEqual(["g1", "g2"]);
  });

  it("falls back to the legacy HOME_GUILD_ID when GUILD_IDS is unset", () => {
    const env = {
      [ENV.token]: "tok",
      [ENV.appId]: "app",
      [ENV.homeGuildId]: "legacy-guild",
    };
    expect(loadConfig(env).guildIds).toEqual(["legacy-guild"]);
  });

  it("prefers GUILD_IDS over HOME_GUILD_ID when both are set", () => {
    const env = { ...baseEnv(), [ENV.guildIds]: "g1,g2", [ENV.homeGuildId]: "legacy" };
    expect(loadConfig(env).guildIds).toEqual(["g1", "g2"]);
  });

  it("uses a provided database path", () => {
    const env = { ...baseEnv(), [ENV.databasePath]: "/data/raffles.db" };
    expect(loadConfig(env).databasePath).toBe("/data/raffles.db");
  });

  it("trims surrounding whitespace", () => {
    const env = { ...baseEnv(), [ENV.token]: "  tok  " };
    expect(loadConfig(env).token).toBe("tok");
  });

  it("throws listing every missing required var", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(ENV.token);
      expect(message).toContain(ENV.appId);
      expect(message).toContain(ENV.guildIds);
    }
  });

  it("treats a blank/whitespace-only guild list as missing", () => {
    const env = { ...baseEnv(), [ENV.guildIds]: "  ,  " };
    expect(() => loadConfig(env)).toThrow(ENV.guildIds);
  });
});
