import { describe, expect, it } from "vitest";
import { ConfigError, ENV, loadConfig } from "../src/config.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    [ENV.token]: "tok",
    [ENV.appId]: "app",
    [ENV.homeGuildId]: "guild",
  };
}

describe("loadConfig", () => {
  it("builds a config from a complete environment", () => {
    expect(loadConfig(baseEnv())).toEqual({
      token: "tok",
      appId: "app",
      homeGuildId: "guild",
      databasePath: "./vernissage.db",
    });
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
      expect(message).toContain(ENV.homeGuildId);
    }
  });

  it("treats blank/whitespace-only values as missing", () => {
    const env = { ...baseEnv(), [ENV.homeGuildId]: "   " };
    expect(() => loadConfig(env)).toThrow(ENV.homeGuildId);
  });
});
