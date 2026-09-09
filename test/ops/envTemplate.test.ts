import { describe, expect, it } from "vitest";
import {
  isSecretEnvKey,
  knownEnvKeys,
  NON_SECRET_ENV_KEYS,
  renderEnvTemplate,
  SECRET_ENV_KEYS,
} from "../../src/ops/envTemplate.js";

describe("env template", () => {
  it("classifies every variable the bot or dashboard reads", () => {
    // Adding a variable to ENV or WEB_ENV without classifying it here would
    // otherwise default to writing its value into every backup archive.
    const unclassified = knownEnvKeys().filter(
      (key) => !isSecretEnvKey(key) && !NON_SECRET_ENV_KEYS.has(key),
    );
    expect(
      unclassified,
      `Classify these in src/ops/envTemplate.ts as either SECRET_ENV_KEYS or NON_SECRET_ENV_KEYS`,
    ).toEqual([]);
  });

  it("treats a secret-sounding name as secret even if nobody listed it", () => {
    expect(SECRET_ENV_KEYS.has("SOME_FUTURE_SECRET")).toBe(false);
    expect(isSecretEnvKey("SOME_FUTURE_SECRET")).toBe(true);
    expect(isSecretEnvKey("SOME_FUTURE_TOKEN")).toBe(true);
    expect(isSecretEnvKey("SOME_FUTURE_PASSWORD")).toBe(true);
  });

  it("blanks secrets that were set and comments out what was not set", () => {
    const rendered = renderEnvTemplate(
      { DISCORD_TOKEN: "s3cret", DISCORD_APP_ID: "123", GUILD_IDS: "456" },
      "2026-09-09T10:15:00.000Z",
    );

    expect(rendered).not.toContain("s3cret");
    expect(rendered).toMatch(/^DISCORD_TOKEN=$/m);
    expect(rendered).toContain("DISCORD_APP_ID=123");
    expect(rendered).toContain("GUILD_IDS=456");
    // Unset variables are commented out, so the template mirrors what the old
    // host actually had configured.
    expect(rendered).toMatch(/^# DASHBOARD_PORT=$/m);
  });

  it("does not leak a secret whose name was never added to the list", () => {
    const rendered = renderEnvTemplate(
      { DASHBOARD_SESSION_SECRET: "hunter2", DESIGNER_HANDOFF_SECRET: "hunter3" },
      "2026-09-09T10:15:00.000Z",
    );
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain("hunter3");
  });
});
