import { describe, expect, it } from "vitest";
import { loadWebConfig } from "../../src/web/config.js";

/** The minimum environment a dashboard config needs. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_CLIENT_ID: "app-1",
    DISCORD_CLIENT_SECRET: "shh",
    DASHBOARD_BASE_URL: "https://dash.example",
    DASHBOARD_SESSION_SECRET: "secret",
    GUILD_IDS: "g1",
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe("loadWebConfig — access revalidation", () => {
  it("re-checks access by default", () => {
    // The default is the security-relevant one: leaving it off would restore the
    // multi-day revocation lag this exists to close (issue #40).
    expect(loadWebConfig(env()).revalidateAccess).toBe(true);
  });

  it("can be switched off as an operational escape hatch", () => {
    for (const value of ["off", "false", "0", "no"]) {
      expect(loadWebConfig(env({ DASHBOARD_REVALIDATE: value })).revalidateAccess).toBe(false);
    }
  });

  it("stays on for an explicit affirmative or a blank value", () => {
    for (const value of ["on", "true", "1", "yes", "", "   "]) {
      expect(loadWebConfig(env({ DASHBOARD_REVALIDATE: value })).revalidateAccess).toBe(true);
    }
  });
});
