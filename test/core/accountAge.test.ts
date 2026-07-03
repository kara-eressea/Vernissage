import { describe, expect, it } from "vitest";
import {
  DISCORD_EPOCH,
  accountCreatedAt,
  meetsMinAccountAge,
} from "../../src/core/accountAge.js";

/** Build a snowflake whose encoded creation time is `createdAtMs`. */
function snowflakeFor(createdAtMs: number): string {
  return ((BigInt(createdAtMs) - BigInt(DISCORD_EPOCH)) << 22n).toString();
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("accountCreatedAt", () => {
  it("decodes the creation time from the snowflake", () => {
    const created = Date.parse("2020-01-01T00:00:00.000Z");
    expect(accountCreatedAt(snowflakeFor(created)).getTime()).toBe(created);
  });

  it("decodes a known real-world snowflake near the Discord epoch", () => {
    // The Discord epoch itself corresponds to snowflake 0.
    expect(accountCreatedAt("0").getTime()).toBe(DISCORD_EPOCH);
  });
});

describe("meetsMinAccountAge", () => {
  const created = Date.parse("2026-01-01T00:00:00.000Z");
  const snowflake = snowflakeFor(created);

  it("always passes when no requirement is set", () => {
    expect(meetsMinAccountAge(snowflake, null, "2026-01-01T00:00:00.000Z")).toBe(
      true,
    );
    expect(meetsMinAccountAge(snowflake, 0, "2026-01-01T00:00:00.000Z")).toBe(
      true,
    );
  });

  it("fails when the account is younger than the minimum", () => {
    const now = new Date(created + 6 * MS_PER_DAY).toISOString();
    expect(meetsMinAccountAge(snowflake, 7, now)).toBe(false);
  });

  it("passes at exactly the minimum age (inclusive boundary)", () => {
    const now = new Date(created + 7 * MS_PER_DAY).toISOString();
    expect(meetsMinAccountAge(snowflake, 7, now)).toBe(true);
  });

  it("passes when the account is older than the minimum", () => {
    const now = new Date(created + 30 * MS_PER_DAY).toISOString();
    expect(meetsMinAccountAge(snowflake, 7, now)).toBe(true);
  });
});
