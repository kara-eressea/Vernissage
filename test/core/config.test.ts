import { describe, expect, it } from "vitest";
import {
  validateCooldownCount,
  validateCooldownDays,
  validateHourlyCap,
  validateMinAccountAge,
  validateReqDays,
  validateReqMessages,
  validateTimezone,
} from "../../src/core/config.js";

describe("config validation", () => {
  const validators = [
    validateHourlyCap,
    validateCooldownDays,
    validateCooldownCount,
    validateMinAccountAge,
  ];

  it("accepts zero and positive integers", () => {
    for (const v of validators) {
      expect(v(0)).toEqual({ ok: true, value: 0 });
      expect(v(14)).toEqual({ ok: true, value: 14 });
    }
  });

  it("rejects negative values with a message", () => {
    for (const v of validators) {
      const result = v(-1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/negative/i);
    }
  });

  it("rejects non-integer values", () => {
    for (const v of validators) {
      const result = v(3.5);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/whole number/i);
    }
  });

  it("labels the offending field in the error", () => {
    const cap = validateHourlyCap(-1);
    const age = validateMinAccountAge(-1);
    if (!cap.ok) expect(cap.error).toMatch(/hourly cap/i);
    if (!age.ok) expect(age.error).toMatch(/account age/i);
  });
});

describe("activity-requirement defaults", () => {
  it("accepts zero messages (no requirement) but rejects a zero-day window", () => {
    expect(validateReqMessages(0)).toEqual({ ok: true, value: 0 });
    expect(validateReqMessages(20)).toEqual({ ok: true, value: 20 });
    const days = validateReqDays(0);
    expect(days.ok).toBe(false);
    if (!days.ok) expect(days.error).toMatch(/at least 1/i);
    expect(validateReqDays(14)).toEqual({ ok: true, value: 14 });
  });
});

describe("validateTimezone", () => {
  it("accepts a valid IANA zone and trims it", () => {
    expect(validateTimezone("  Europe/Copenhagen ")).toEqual({
      ok: true,
      value: "Europe/Copenhagen",
    });
    expect(validateTimezone("America/New_York").ok).toBe(true);
  });

  it("rejects an unknown zone or empty string", () => {
    expect(validateTimezone("Mars/Olympus").ok).toBe(false);
    expect(validateTimezone("").ok).toBe(false);
  });
});
