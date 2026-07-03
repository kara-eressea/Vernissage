import { describe, expect, it } from "vitest";
import { parseBanDuration } from "../../src/core/duration.js";

const NOW = "2026-07-15T12:00:00.000Z";

describe("parseBanDuration", () => {
  it("parses each unit into an absolute UTC expiry", () => {
    expect(parseBanDuration("30m", NOW)).toBe("2026-07-15T12:30:00.000Z");
    expect(parseBanDuration("24h", NOW)).toBe("2026-07-16T12:00:00.000Z");
    expect(parseBanDuration("7d", NOW)).toBe("2026-07-22T12:00:00.000Z");
    expect(parseBanDuration("2w", NOW)).toBe("2026-07-29T12:00:00.000Z");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(parseBanDuration("  7D  ", NOW)).toBe("2026-07-22T12:00:00.000Z");
  });

  it("treats empty/omitted input as a permanent ban (null)", () => {
    expect(parseBanDuration(null, NOW)).toBeNull();
    expect(parseBanDuration(undefined, NOW)).toBeNull();
    expect(parseBanDuration("", NOW)).toBeNull();
    expect(parseBanDuration("   ", NOW)).toBeNull();
  });

  it("throws on malformed input", () => {
    for (const bad of ["abc", "0d", "-1d", "5x", "12", "1.5d", "d", "7 d"]) {
      expect(() => parseBanDuration(bad, NOW), bad).toThrow(RangeError);
    }
  });

  it("handles a large value without overflow", () => {
    expect(parseBanDuration("52w", NOW)).toBe("2027-07-14T12:00:00.000Z");
  });
});
