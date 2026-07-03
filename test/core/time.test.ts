import { describe, expect, it } from "vitest";
import { activityWindow, addDays, discordTimestamp, utcDay } from "../../src/core/time.js";

describe("discordTimestamp", () => {
  it("converts a UTC ISO string to epoch-seconds markup", () => {
    // 2026-07-10T12:00:00Z is 1783684800 seconds since the epoch.
    expect(discordTimestamp("2026-07-10T12:00:00.000Z")).toBe("<t:1783684800:F>");
  });

  it("defaults to the F (long date-time) style and accepts an override", () => {
    expect(discordTimestamp("2026-07-10T12:00:00.000Z", "R")).toBe("<t:1783684800:R>");
  });

  it("floors to whole seconds and handles a UTC-midnight boundary", () => {
    expect(discordTimestamp("2026-07-10T00:00:00.000Z", "d")).toBe("<t:1783641600:d>");
    expect(discordTimestamp("2026-07-10T12:00:00.999Z", "f")).toBe("<t:1783684800:f>");
  });

  it("throws on an invalid timestamp", () => {
    expect(() => discordTimestamp("not-a-date")).toThrow();
  });
});

describe("utcDay", () => {
  it("extracts the UTC calendar day from a timestamp", () => {
    expect(utcDay("2026-07-03T12:34:56.000Z")).toBe("2026-07-03");
  });

  it("uses UTC, not local time, across midnight", () => {
    // 23:30 UTC is still the 3rd in UTC regardless of the runner's timezone.
    expect(utcDay("2026-07-03T23:30:00.000Z")).toBe("2026-07-03");
    expect(utcDay("2026-07-04T00:00:00.000Z")).toBe("2026-07-04");
  });

  it("throws on an invalid timestamp", () => {
    expect(() => utcDay("not-a-date")).toThrow();
  });
});

describe("addDays", () => {
  it("moves forward and backward across month boundaries", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-07-01", -1)).toBe("2026-06-30");
  });

  it("is a no-op for zero", () => {
    expect(addDays("2026-07-03", 0)).toBe("2026-07-03");
  });
});

describe("activityWindow", () => {
  it("returns Y inclusive days ending at the anchor day", () => {
    // 14 days ending 2026-07-14 -> starts 2026-07-01.
    expect(activityWindow("2026-07-14T09:00:00.000Z", 14)).toEqual({
      startDay: "2026-07-01",
      endDay: "2026-07-14",
    });
  });

  it("collapses to a single day when reqDays is 1", () => {
    expect(activityWindow("2026-07-03T00:00:00.000Z", 1)).toEqual({
      startDay: "2026-07-03",
      endDay: "2026-07-03",
    });
  });

  it("uses the anchor's UTC day, not local", () => {
    expect(activityWindow("2026-07-03T23:59:59.000Z", 2)).toEqual({
      startDay: "2026-07-02",
      endDay: "2026-07-03",
    });
  });

  it("rejects non-positive windows", () => {
    expect(() => activityWindow("2026-07-03T00:00:00.000Z", 0)).toThrow();
    expect(() => activityWindow("2026-07-03T00:00:00.000Z", -5)).toThrow();
  });
});
