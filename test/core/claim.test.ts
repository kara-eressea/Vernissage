import { describe, expect, it } from "vitest";
import { claimDeadline, claimWindowEnabled, isClaimExpired } from "../../src/core/claim.js";

describe("claimWindowEnabled", () => {
  it("is off for null or non-positive hours", () => {
    expect(claimWindowEnabled(null)).toBe(false);
    expect(claimWindowEnabled(0)).toBe(false);
    expect(claimWindowEnabled(-4)).toBe(false);
  });

  it("is on for a positive hour count", () => {
    expect(claimWindowEnabled(24)).toBe(true);
  });
});

describe("claimDeadline", () => {
  it("adds the window in hours to the draw instant", () => {
    expect(claimDeadline("2026-07-15T12:00:00.000Z", 24)).toBe("2026-07-16T12:00:00.000Z");
    expect(claimDeadline("2026-07-15T12:00:00.000Z", 1)).toBe("2026-07-15T13:00:00.000Z");
  });
});

describe("isClaimExpired", () => {
  const deadline = "2026-07-16T12:00:00.000Z";

  it("is not expired before the deadline", () => {
    expect(isClaimExpired(deadline, "2026-07-16T11:59:59.000Z")).toBe(false);
  });

  it("is expired exactly at the deadline (inclusive boundary)", () => {
    expect(isClaimExpired(deadline, "2026-07-16T12:00:00.000Z")).toBe(true);
  });

  it("is expired after the deadline", () => {
    expect(isClaimExpired(deadline, "2026-07-17T00:00:00.000Z")).toBe(true);
  });
});
